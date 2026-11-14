import type { SoundEvent } from './acoustic/analyse'
import { Listener, type MicState } from './acoustic/listener'
import { Cues } from './audio/cues'
import { clock, type Exhibit, type Seal } from './exhibits'
import type { Track } from './perception/track'
import { decodeFrame, FLAG_REVOLUTION_END, FLAG_SCAN, FLAG_SIMULATED, FrameError, type Frame } from './protocol/frame'
import { PhoneScan, type ScanStats } from './scan/xr'
import { PRESETS, type Environment, type SensorConfig } from './sim/sensor'
import type { FromWorker, ToWorker } from './sim/worker'
import type { CloudView } from './view/cloud'
import type { RangeImage } from './view/rangeImage'
import type { Spectrogram } from './view/spectrogram'
import type { Timeline } from './view/timeline'
import type { WifiView } from './view/wifiView'
import { WifiSim } from './wifi/csi'
import { MotionDetector, type MotionEpisode } from './wifi/motion'

export type SourceKind = 'simulator' | 'bridge' | 'recording' | 'scan'
export type WifiMode = 'simulated' | 'esp32' | 'off'

export interface WifiState {
  mode: WifiMode
  /** bridge connection for the ESP32 */
  link: BridgeState
  message: string
  index: number
  score: number
  moving: boolean
  rssi: number
  packetsPerSecond: number
  people: number
}

export interface MicInfo {
  state: MicState
  message: string
  device: string
  stereo: boolean
}
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
  /** every numbered exhibit this session, oldest first */
  exhibits: Exhibit[]
  /** frames carry the scan flag: points are kept, nothing is tracked */
  accumulating: boolean
  scan: ScanStats | null
  scanMessage: string
  wifi: WifiState
  mic: MicInfo
  sounds: boolean
}

const MAX_RECORDED_BYTES = 400 * 1024 * 1024
const MAX_EXHIBITS = 400

/**
 * Moves frames from a source (simulator worker, bridge WebSocket or a recording)
 * into the views, and keeps the numbers the console shows.
 */
export class Engine {
  private worker: Worker
  private views: { cloud: CloudView; range: RangeImage } | null = null
  private instruments: { wifi: WifiView; spectrogram: Spectrogram; timeline: Timeline } | null = null
  readonly listener = new Listener()
  readonly cues = new Cues()
  private register: Exhibit[] = []
  private nextExhibit = 1
  private trackExhibit = new Map<number, Exhibit>()
  private soundExhibit = new Map<number, Exhibit>()
  private wifiSim = new WifiSim()
  private motion = new MotionDetector()
  private wifiTimer = 0
  private wifiSocket: WebSocket | null = null
  private wifiEpisode: Exhibit | null = null
  private wifiPackets = 0
  private phone = new PhoneScan()
  private relay: WebSocket | null = null
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
    exhibits: [],
    accumulating: false,
    scan: null,
    scanMessage: '',
    wifi: { mode: 'simulated', link: 'idle', message: '', index: 0, score: 0, moving: false, rssi: 0, packetsPerSecond: 0, people: 2 },
    mic: { state: 'off', message: '', device: '', stereo: false },
    sounds: false,
  }

  constructor(env: Environment) {
    this.env = env
    this.worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data)
    this.post({ type: 'configure', sensor: this.sensor, env })
    this.post({ type: 'run', running: true })
    this.statsTimer = window.setInterval(() => this.tickStats(), 500)

    this.listener.clock = clock
    this.listener.onChange = () => this.emit({ mic: this.micInfo() })
    this.listener.onEvent = (e) => this.onSound(e)
    this.listener.onBlock = () => this.instruments?.spectrogram.tick()
    this.cues.onPlay = (until) => { this.listener.analyser.muteUntil = until - performance.now() / 1000 + clock() }
    this.motion.onEpisode = (e) => this.onMotion(e)
    this.phone.onFrame = (buf) => {
      this.ingest(buf, null, 0, false)
      if (this.relay?.readyState === WebSocket.OPEN) this.relay.send(buf)
    }
    this.phone.onStats = (st) => { this.state.scan = { ...st } }
    this.phone.onEnd = () => {
      this.relay?.close()
      this.relay = null
      this.emit({ scanMessage: `Scan finished: ${this.state.scan?.points.toLocaleString('en-GB') ?? 0} points kept.` })
    }
    this.setWifiMode('simulated')
  }

  dispose(): void {
    this.leaveSource()
    clearInterval(this.wifiTimer)
    this.wifiSocket?.close()
    this.listener.stop()
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
    cloud.exhibitOf = (id) => this.exhibitOfTrack(id)
    cloud.setOutline(this.outline)
    cloud.setMaxRange(this.sensor.maxRange)
    range.setChannels(this.sensor.channels)
    range.setMaxRange(this.sensor.maxRange)
  }

  detach(): void {
    this.views = null
  }

  attachInstruments(wifi: WifiView, spectrogram: Spectrogram, timeline: Timeline): void {
    this.instruments = { wifi, spectrogram, timeline }
  }

  detachInstruments(): void {
    this.instruments = null
  }

  /** the live register, for canvases that draw every frame */
  exhibitsNow = (): Exhibit[] => this.register

  exhibitOfTrack(trackId: number): number | undefined {
    return this.trackExhibit.get(trackId)?.n
  }

  setSounds(on: boolean): void {
    this.cues.setEnabled(on)
    this.emit({ sounds: on })
  }

  // ── Exhibits ────────────────────────────────────────────────────────────

  private addExhibit(e: Omit<Exhibit, 'n'>): Exhibit {
    const ex = { ...e, n: this.nextExhibit++ } as Exhibit
    this.register.push(ex)
    if (this.register.length > MAX_EXHIBITS) this.register.shift()
    this.emit({ exhibits: [...this.register] })
    return ex
  }

  private updateTrackExhibits(tracks: Track[]): void {
    const now = clock()
    const seen = new Set<number>()
    for (const t of tracks) {
      seen.add(t.id)
      const ex = this.trackExhibit.get(t.id)
      if (ex) {
        ex.end = now
        ex.cls = t.cls
      } else {
        this.trackExhibit.set(t.id, this.addExhibit({ kind: 'object', start: now, end: now, open: true, trackId: t.id, cls: t.cls }))
        this.cues.play('exhibit')
      }
    }
    for (const [id, ex] of this.trackExhibit) {
      if (!seen.has(id) && ex.open) ex.open = false
    }
  }

  /** Close every open object exhibit and forget track numbers: the tracker restarts. */
  private closeTracks(): void {
    for (const ex of this.trackExhibit.values()) ex.open = false
    this.trackExhibit.clear()
  }

  private onSound(e: SoundEvent): void {
    let ex = this.soundExhibit.get(e.id)
    if (!ex) {
      ex = this.addExhibit({ kind: 'sound', start: e.start, end: e.end, open: e.open, sound: { ...e } })
      this.soundExhibit.set(e.id, ex)
      this.instruments?.timeline.flash('sound')
      this.cues.play('sound')
    } else {
      ex.end = e.end
      ex.open = e.open
      ex.sound = { ...e }
      this.emit({ exhibits: [...this.register] })
    }
  }

  private onMotion(e: MotionEpisode): void {
    const source = this.state.wifi.mode === 'esp32' ? 'esp32' : 'simulated'
    if (!this.wifiEpisode || this.wifiEpisode.start !== e.start) {
      this.wifiEpisode = this.addExhibit({ kind: 'wifi', start: e.start, end: e.end, open: e.open, wifi: { peak: e.peak, source } })
      this.cues.play('motion')
    } else {
      this.wifiEpisode.end = e.end
      this.wifiEpisode.open = e.open
      this.wifiEpisode.wifi = { peak: e.peak, source }
      if (!e.open) this.emit({ exhibits: [...this.register] })
    }
  }

  // ── Wi-Fi ───────────────────────────────────────────────────────────────

  setWifiMode(mode: WifiMode, url?: string): void {
    clearInterval(this.wifiTimer)
    this.wifiSocket?.close()
    this.wifiSocket = null
    this.motion.reset()
    this.instruments?.wifi.clear()
    if (this.wifiEpisode?.open) this.wifiEpisode.open = false
    this.wifiEpisode = null
    this.emit({ wifi: { ...this.state.wifi, mode, link: 'idle', message: '', moving: false, score: 0, index: 0 } })
    if (mode === 'simulated') {
      // 100 packets a second, as an ESP32 is usually configured to send.
      let last = performance.now()
      this.wifiTimer = window.setInterval(() => {
        const now = performance.now()
        let steps = Math.min(20, Math.round((now - last) / 10))
        last += steps * 10
        while (steps-- > 0) {
          const p = this.wifiSim.step(0.01)
          this.onCsi(clock() - steps * 0.01, p.amp, p.rssi)
        }
      }, 20)
    } else if (mode === 'esp32' && url) {
      this.connectCsi(url)
    }
  }

  setWifiPeople(n: number): void {
    this.wifiSim.configure({ people: n, snrDb: 38 })
    this.emit({ wifi: { ...this.state.wifi, people: n } })
  }

  private connectCsi(url: string): void {
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.emit({ wifi: { ...this.state.wifi, link: 'error', message: `${url} is not a valid WebSocket address` } })
      return
    }
    this.wifiSocket = socket
    this.emit({ wifi: { ...this.state.wifi, link: 'connecting', message: url } })
    socket.onopen = () => this.emit({ wifi: { ...this.state.wifi, link: 'open', message: 'Waiting for CSI packets from the ESP32.' } })
    socket.onerror = () => this.emit({ wifi: { ...this.state.wifi, link: 'error', message: `No bridge answered at ${url}` } })
    socket.onclose = () => {
      if (this.wifiSocket === socket && this.state.wifi.link !== 'error') this.emit({ wifi: { ...this.state.wifi, link: 'closed', message: `${url} closed the connection` } })
    }
    socket.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      try {
        const m = JSON.parse(e.data) as { type?: string; rssi?: number; amp?: number[] }
        if (m.type === 'csi' && Array.isArray(m.amp)) this.onCsi(clock(), Float32Array.from(m.amp), m.rssi ?? 0)
      } catch {
        /* not ours */
      }
    }
  }

  private onCsi(t: number, amp: Float32Array, rssi: number): void {
    this.motion.push(t, amp)
    this.wifiPackets++
    this.state.wifi.rssi = rssi
    this.instruments?.wifi.push(this.motion.latest, this.motion.score, this.motion.moving,
      this.state.wifi.mode === 'simulated' ? this.wifiSim.people : null)
  }

  // ── Microphone ──────────────────────────────────────────────────────────

  listen(on: boolean): void {
    if (on) void this.listener.start()
    else this.listener.stop()
    if (this.instruments) this.instruments.spectrogram.live = on
  }

  private micInfo(): MicInfo {
    const l = this.listener
    if (this.instruments) this.instruments.spectrogram.live = l.state === 'on'
    return { state: l.state, message: l.message, device: l.deviceLabel, stereo: l.channels >= 2 }
  }

  // ── Phone scan ──────────────────────────────────────────────────────────

  /** Start an AR depth scan on this phone; frames also go to a bridge when one is given. */
  async startScan(overlay: HTMLElement, relayUrl: string | null): Promise<void> {
    this.leaveSource()
    this.views?.cloud.clear()
    this.views?.cloud.setOutline(null)
    this.closeTracks()
    this.emit({ source: 'scan', running: true, tracks: [], scan: null, scanMessage: '' })
    if (relayUrl) {
      try {
        this.relay = new WebSocket(relayUrl)
        this.relay.binaryType = 'arraybuffer'
      } catch {
        this.relay = null
      }
    }
    const err = await this.phone.begin(overlay)
    if (err) this.emit({ scanMessage: err })
  }

  endScan(): void {
    this.phone.end()
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
    this.closeTracks()
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
    this.emit({ source: 'simulator', running: true, tracks: [], accumulating: false })
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
    this.closeTracks()
    if (this.state.source === 'scan') this.phone.end()
    if (this.state.accumulating) this.emit({ accumulating: false })
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

  startRecordingCue(): void {
    this.cues.play('record')
  }

  /**
   * Stop and seal the capture: one file (a u32 length before each frame), its
   * SHA-256, and a numbered exhibit that records both.
   */
  async stopRecording(): Promise<{ blob: Blob; seal: Seal } | null> {
    const frames = this.rec.length
    const seconds = this.state.recordedSeconds
    const startedAt = clock() - seconds
    this.emit({ recording: false })
    if (!frames) return null
    const parts: BlobPart[] = []
    for (const f of this.rec) {
      parts.push(new Uint32Array([f.byteLength]).buffer, f)
    }
    this.rec = []
    const blob = new Blob(parts, { type: 'application/octet-stream' })
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
    const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
    const sealedAt = new Date().toISOString()
    const n = this.nextExhibit
    const seal: Seal = {
      name: `fathom-exhibit-${n}-${sha256.slice(0, 8)}.fthm`, sha256, bytes: blob.size, frames, seconds, sealedAt,
    }
    this.addExhibit({ kind: 'recording', start: startedAt, end: clock(), open: false, seal })
    this.cues.play('seal')
    return { blob, seal }
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
      this.updateTrackExhibits(m.tracks)
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

    // A still scan of a place is kept whole and never tracked: the classes are for streets.
    if (f.flags & FLAG_SCAN) {
      if (!this.state.accumulating) this.emit({ accumulating: true, tracks: [] })
      return
    }
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
    const patch: Partial<EngineState> = {
      stats,
      exhibits: [...this.register],
      wifi: {
        ...this.state.wifi,
        index: this.motion.index, score: this.motion.score, moving: this.motion.moving,
        packetsPerSecond: this.wifiPackets / dt,
      },
    }
    this.wifiPackets = 0
    if (this.state.scan) patch.scan = { ...this.state.scan }
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
