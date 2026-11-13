import type { Track } from './perception/track'
import { decodeFrame, FLAG_REVOLUTION_END, FLAG_SIMULATED, FrameError, type Frame } from './protocol/frame'
import { PRESETS, type Environment, type SensorConfig } from './sim/sensor'
import type { FromWorker, ToWorker } from './sim/worker'
import type { CloudView } from './view/cloud'
import type { RangeImage } from './view/rangeImage'

export type SourceKind = 'simulator' | 'bridge' | 'recording'
export type BridgeState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export interface Stats {
  pointsPerSecond: number
  returnRate: number
  revolutionsPerSecond: number
  perceptionMs: number
  pointsHeld: number
  frameId: number
  /** seconds since the current source started */
  time: number
  simulated: boolean
  /** what an external source has shown so far: highest ring + 1 and farthest return */
  seenChannels: number
  seenRange: number
}

export interface EngineState {
  source: SourceKind
  running: boolean
  bridge: BridgeState
  bridgeMessage: string
  recording: boolean
  recordedFrames: number
  recordedSeconds: number
  replay: { frames: number; index: number; name: string } | null
  tracks: Track[]
  /** sensor position when the tracks were computed */
  ego: { x: number; y: number }
  stats: Stats
}

const MAX_RECORDED_BYTES = 400 * 1024 * 1024

/**
 * Moves frames from a source (simulator worker, bridge WebSocket or a recording)
 * into the views, and keeps the numbers the console shows.
 */
export class Engine {
  private worker: Worker
  private views: { cloud: CloudView; range: RangeImage } | null = null
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private sensor: SensorConfig = PRESETS[1].config
  private env: Environment
  private outline: Float32Array | null = null

  private rec: ArrayBuffer[] = []
  private recBytes = 0
  private recStart = 0
  private replayFrames: ArrayBuffer[] = []
  private replayTimer = 0

  // Bridge frames are gathered per revolution and handed to the worker for perception.
  private rev = new Float32Array(3 * 262144)
  private revCount = 0

  private statsTimer = 0
  private t0: number | null = null
  private seen = { channels: 0, range: 0 }
  private window = { start: performance.now(), points: 0, rays: 0, revs: 0 }

  state: EngineState = {
    source: 'simulator',
    running: true,
    bridge: 'idle',
    bridgeMessage: '',
    recording: false,
    recordedFrames: 0,
    recordedSeconds: 0,
    replay: null,
    tracks: [],
    ego: { x: 0, y: 0 },
    stats: {
      pointsPerSecond: 0, returnRate: 0, revolutionsPerSecond: 0, perceptionMs: 0,
      pointsHeld: 0, frameId: 0, time: 0, simulated: true, seenChannels: 0, seenRange: 0,
    },
  }

  constructor(env: Environment) {
    this.env = env
    this.worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data)
    this.post({ type: 'configure', sensor: this.sensor, env })
    this.post({ type: 'run', running: true })
    this.statsTimer = window.setInterval(() => this.tickStats(), 500)
  }

  dispose(): void {
    this.leaveSource()
    this.worker.terminate()
    clearInterval(this.statsTimer)
    this.listeners.clear()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  private post(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer)
  }

  attach(cloud: CloudView, range: RangeImage): void {
    this.views = { cloud, range }
    cloud.setOutline(this.outline)
    cloud.setMaxRange(this.sensor.maxRange)
    range.setChannels(this.sensor.channels)
    range.setMaxRange(this.sensor.maxRange)
  }

  detach(): void {
    this.views = null
  }

  // ── Controls ────────────────────────────────────────────────────────────

  configure(sensor: SensorConfig, env: Environment): void {
    this.sensor = sensor
    this.env = env
    this.post({ type: 'configure', sensor, env })
    if (this.views && this.state.source === 'simulator') {
      this.views.cloud.setMaxRange(sensor.maxRange)
      this.views.range.setChannels(sensor.channels)
      this.views.range.setMaxRange(sensor.maxRange)
    }
  }

  setRunning(running: boolean): void {
    if (this.state.source === 'simulator') this.post({ type: 'run', running })
    if (this.state.source === 'recording') {
      if (running) this.playReplay()
      else clearTimeout(this.replayTimer)
    }
    this.views?.cloud.setRunning(running)
    this.emit({ running })
  }

  restartSimulation(): void {
    this.t0 = null
    this.views?.cloud.clear()
    this.post({ type: 'restart' })
    this.emit({ tracks: [] })
  }

  useSimulator(): void {
    this.leaveSource()
    this.views?.cloud.clear()
    this.configure(this.sensor, this.env)
    this.post({ type: 'resetTracks' })
    this.post({ type: 'run', running: true })
    this.views?.cloud.setOutline(this.outline)
    this.views?.cloud.setRunning(true)
    this.views?.cloud.setMaxRange(this.sensor.maxRange)
    this.views?.range.setChannels(this.sensor.channels)
    this.views?.range.setMaxRange(this.sensor.maxRange)
    this.emit({ source: 'simulator', running: true, tracks: [] })
  }

  connectBridge(url: string): void {
    this.leaveSource()
    this.views?.cloud.clear()
    this.views?.cloud.setOutline(null)
    this.post({ type: 'resetTracks' })
    this.emit({ source: 'bridge', running: true, bridge: 'connecting', bridgeMessage: url, tracks: [] })
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.emit({ bridge: 'error', bridgeMessage: `${url} is not a valid WebSocket address` })
      return
    }
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => this.emit({ bridge: 'open', bridgeMessage: url })
    socket.onerror = () => this.emit({ bridge: 'error', bridgeMessage: `No bridge answered at ${url}` })
    socket.onclose = () => {
      if (this.socket === socket && this.state.bridge !== 'error') {
        this.emit({ bridge: 'closed', bridgeMessage: `${url} closed the connection` })
      }
    }
    socket.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || !this.state.running) return
      try {
        this.ingest(e.data, null, 0, true)
      } catch (err) {
        if (err instanceof FrameError) this.emit({ bridgeMessage: err.message })
        else throw err
      }
    }
  }

  private leaveSource(): void {
    if (this.socket) {
      const s = this.socket
      this.socket = null
      s.close()
    }
    clearTimeout(this.replayTimer)
    this.post({ type: 'run', running: false })
    this.revCount = 0
    this.t0 = null
    this.seen = { channels: 0, range: 0 }
    if (this.state.replay) this.emit({ replay: null })
    if (this.state.bridge !== 'idle') this.emit({ bridge: 'idle', bridgeMessage: '' })
  }

  // ── Recording ───────────────────────────────────────────────────────────

  startRecording(): void {
    this.rec = []
    this.recBytes = 0
    this.recStart = this.state.stats.time
    this.emit({ recording: true, recordedFrames: 0, recordedSeconds: 0 })
  }

  /** Stop and return the capture as one file: a u32 length before each frame. */
  stopRecording(): Blob | null {
    this.emit({ recording: false })
    if (!this.rec.length) return null
    const parts: BlobPart[] = []
    for (const f of this.rec) {
      parts.push(new Uint32Array([f.byteLength]).buffer, f)
    }
    this.rec = []
    return new Blob(parts, { type: 'application/octet-stream' })
  }

  async openRecording(file: File): Promise<string | null> {
    const buf = await file.arrayBuffer()
    const frames: ArrayBuffer[] = []
    const dv = new DataView(buf)
    let o = 0
    while (o + 4 <= buf.byteLength) {
      const n = dv.getUint32(o, true)
      o += 4
      if (n === 0 || o + n > buf.byteLength) return `${file.name} ends partway through a frame`
      const f = buf.slice(o, o + n)
      try {
        decodeFrame(f)
      } catch (err) {
        return `${file.name} is not a Fathom recording: ${(err as Error).message}`
      }
      frames.push(f)
      o += n
    }
    if (!frames.length) return `${file.name} holds no frames`
    this.leaveSource()
    this.views?.cloud.clear()
    this.views?.cloud.setOutline(null)
    this.post({ type: 'resetTracks' })
    this.replayFrames = frames
    this.emit({ source: 'recording', running: true, tracks: [], replay: { frames: frames.length, index: 0, name: file.name } })
    this.playReplay()
    return null
  }

  seekReplay(index: number): void {
    if (!this.state.replay) return
    this.views?.cloud.clear()
    this.post({ type: 'resetTracks' })
    this.revCount = 0
    this.emit({ replay: { ...this.state.replay, index }, tracks: [] })
    if (this.state.running) this.playReplay()
    else this.ingest(this.replayFrames[index].slice(0), null, 0, false)
  }

  /** Play from the current index, pinned to the wall clock so processing time never slows playback. */
  private playReplay(): void {
    clearTimeout(this.replayTimer)
    const start = this.state.replay
    if (!start) return
    const startWall = performance.now()
    const startT = decodeFrame(this.replayFrames[start.index]).timestamp
    const step = () => {
      const r = this.state.replay
      if (!r || !this.state.running) return
      const due = startT + (performance.now() - startWall) / 1000
      let i = r.index
      // Deliver every frame whose time has come.
      while (i < r.frames && decodeFrame(this.replayFrames[i]).timestamp <= due) {
        this.ingest(this.replayFrames[i].slice(0), null, 0, false)
        i++
      }
      if (i >= r.frames) {
        // Loop after a short pause, starting clean.
        this.state = { ...this.state, replay: { ...r, index: 0 } }
        this.replayTimer = window.setTimeout(() => {
          this.views?.cloud.clear()
          this.post({ type: 'resetTracks' })
          this.revCount = 0
          this.t0 = null
          this.playReplay()
        }, 600)
        return
      }
      this.state = { ...this.state, replay: { ...r, index: i } }
      this.replayTimer = window.setTimeout(step, 8)
    }
    step()
  }

  // ── Frames ──────────────────────────────────────────────────────────────

  private onWorker(m: FromWorker): void {
    if (m.type === 'outline') {
      this.outline = m.boxes
      if (this.state.source === 'simulator') this.views?.cloud.setOutline(m.boxes)
    } else if (m.type === 'packet') {
      if (this.state.source === 'simulator') this.ingest(m.frame, m.truth, m.rays, false)
    } else if (m.type === 'tracks') {
      this.views?.cloud.setTracks(m.tracks, m.time)
      this.emit({ tracks: m.tracks, ego: { x: m.x, y: m.y }, stats: { ...this.state.stats, perceptionMs: m.ms } })
    }
  }

  private ingest(buffer: ArrayBuffer, truth: Uint8Array | null, rays: number, external: boolean): void {
    const f: Frame = decodeFrame(buffer)
    if (this.state.recording) {
      if (this.recBytes + buffer.byteLength > MAX_RECORDED_BYTES) {
        this.emit({ recording: false })
      } else {
        this.rec.push(buffer.slice(0))
        this.recBytes += buffer.byteLength
      }
    }
    this.views?.cloud.push(f, truth)
    this.views?.range.push(f)
    this.window.points += f.pointCount
    this.window.rays += rays
    if (f.flags & FLAG_REVOLUTION_END) this.window.revs++
    if (this.t0 === null) this.t0 = f.timestamp
    this.state.stats.frameId = f.frameId
    this.state.stats.time = f.timestamp - this.t0
    this.state.stats.simulated = (f.flags & FLAG_SIMULATED) !== 0

    if (external || this.state.source === 'recording') this.gatherForPerception(f)
  }

  private gatherForPerception(f: Frame): void {
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw)
    const seen = this.seen
    for (let i = 0; i < f.pointCount && this.revCount * 3 < this.rev.length; i++) {
      const x = f.f32[i * 4], y = f.f32[i * 4 + 1], z = f.f32[i * 4 + 2]
      const ring = f.u8[i * 16 + 13] + 1
      if (ring > seen.channels) seen.channels = ring
      const r = x * x + y * y + z * z
      if (r > seen.range) seen.range = r
      const o = this.revCount++ * 3
      this.rev[o] = f.x + c * x - s * y
      this.rev[o + 1] = f.y + s * x + c * y
      this.rev[o + 2] = f.z + z
    }
    if (f.flags & FLAG_REVOLUTION_END) {
      // Fit the views to what the device actually delivers.
      const range = Math.max(10, Math.ceil(Math.sqrt(seen.range) / 10) * 10)
      if (this.views && (seen.channels !== this.state.stats.seenChannels || range !== this.state.stats.seenRange)) {
        this.views.range.setChannels(Math.max(1, seen.channels))
        this.views.range.setMaxRange(range)
        this.views.cloud.setMaxRange(range)
      }
      this.state.stats.seenChannels = seen.channels
      this.state.stats.seenRange = range
      const points = this.rev.slice(0, this.revCount * 3)
      this.post(
        { type: 'perceive', points, count: this.revCount, x: f.x, y: f.y, time: f.timestamp, range },
        [points.buffer],
      )
      this.revCount = 0
    }
  }

  private tickStats(): void {
    const now = performance.now()
    const dt = (now - this.window.start) / 1000
    const w = this.window
    const stats: Stats = {
      ...this.state.stats,
      pointsPerSecond: w.points / dt,
      returnRate: w.rays > 0 ? w.points / w.rays : this.state.stats.returnRate,
      revolutionsPerSecond: w.revs / dt,
      pointsHeld: this.views?.cloud.pointsHeld ?? 0,
    }
    this.window = { start: now, points: 0, rays: 0, revs: 0 }
    const patch: Partial<EngineState> = { stats }
    if (this.state.recording) {
      patch.recordedFrames = this.rec.length
      patch.recordedSeconds = Math.max(0, stats.time - this.recStart)
    }
    this.emit(patch)
  }
}

/** One engine per page; a hot reload of this module replaces it cleanly. */
export const engine = new Engine({ weather: 'clear', egoSpeed: 30 / 3.6 })
if (import.meta.hot) import.meta.hot.dispose(() => engine.dispose())
