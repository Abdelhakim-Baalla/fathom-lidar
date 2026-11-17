import type { Track } from '../perception/track'
import type { Frame } from '../protocol/frame'
import type { CameraPreset, Layers } from './cloud'
import { buildRamp, HEIGHT_MAX, PALETTE, type ColorMode } from './palettes'
import type { PointView } from './pointView'

const CAPACITY = 60_000
const PER_PACKET = 1800

/** Bounded, sampled CPU point view. It draws received returns, never invented geometry. */
export class SoftwareCloud implements PointView {
  onSelect: (id: number | null) => void = () => {}
  exhibitOf: (trackId: number) => number | undefined = () => undefined
  pointsHeld = 0
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private xyz = new Float32Array(CAPACITY * 3)
  private time = new Float64Array(CAPACITY)
  private intensity = new Uint8Array(CAPACITY)
  private ring = new Uint8Array(CAPACITY)
  private truth = new Uint8Array(CAPACITY)
  private range = new Float32Array(CAPACITY)
  private cursor = 0
  private count = 0
  private now = 0
  private wall = 0
  private running = true
  private persist = .82
  private sweepAz = 0
  private maxRange = 120
  private pointSize = 2.6
  private mode: ColorMode = 'range'
  private colors: string[] = []
  private ego = { x: 0, y: 0, z: 1.9, yaw: 0 }
  private theta = .48
  private phi = 1.04
  private distance = 55
  private headingUp = true
  private tracks: Track[] = []
  private selected: number | null = null
  private layers: Layers = { rings: true, tracks: true, sweep: true, outline: false }
  private outline: Float32Array | null = null
  private observer: ResizeObserver
  private events = new AbortController()
  private raf = 0
  private lastPaint = 0
  private hits: Array<{ id: number; x: number; y: number }> = []
  private basis = { x: 0, y: 0, z: 0, yaw: 0, sin: 0, cos: 1, pitchSin: 1, pitchCos: 0 }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D is unavailable')
    this.ctx = ctx
    this.setColorMode('range')
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas.parentElement!)
    this.resize()
    const signal = this.events.signal
    let drag: { x: number; y: number; moved: number } | null = null
    canvas.addEventListener('pointerdown', event => {
      drag = { x: event.clientX, y: event.clientY, moved: 0 }
      canvas.setPointerCapture(event.pointerId)
    }, { signal })
    canvas.addEventListener('pointermove', event => {
      if (!drag) return
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y
      this.theta -= dx * .006
      this.phi = Math.max(.04, Math.min(1.5, this.phi - dy * .005))
      drag = { x: event.clientX, y: event.clientY, moved: drag.moved + Math.abs(dx) + Math.abs(dy) }
    }, { signal })
    canvas.addEventListener('pointerup', event => {
      if (drag && drag.moved < 5) {
        const hit = this.hits.find(hit => Math.hypot(hit.x - event.offsetX, hit.y - event.offsetY) < 24)
        this.onSelect(hit?.id ?? null)
      }
      drag = null
    }, { signal })
    canvas.addEventListener('pointercancel', () => { drag = null }, { signal })
    canvas.addEventListener('wheel', event => {
      event.preventDefault()
      this.distance = Math.max(5, Math.min(350, this.distance * Math.exp(event.deltaY * .0012)))
    }, { signal, passive: false })
    canvas.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft') this.theta -= .12
      else if (event.key === 'ArrowRight') this.theta += .12
      else if (event.key === 'ArrowUp') this.phi = Math.max(.04, this.phi - .08)
      else if (event.key === 'ArrowDown') this.phi = Math.min(1.5, this.phi + .08)
      else if (event.key === '+' || event.key === '=') this.distance = Math.max(5, this.distance * .85)
      else if (event.key === '-') this.distance = Math.min(350, this.distance * 1.18)
      else return
      event.preventDefault()
    }, { signal })
    this.raf = requestAnimationFrame(this.frame)
  }

  push(f: Frame, truth: Uint8Array | null): void {
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw)
    // Even sampling across each packet, rotated per frame to avoid a fixed ring bias.
    const stride = Math.max(1, Math.ceil(f.pointCount / PER_PACKET))
    for (let i = f.frameId % stride; i < f.pointCount; i += stride) {
      const x = f.f32[i * 4], y = f.f32[i * 4 + 1], z = f.f32[i * 4 + 2]
      const slot = this.cursor
      this.xyz[slot * 3] = f.x + c * x - s * y
      this.xyz[slot * 3 + 1] = f.y + s * x + c * y
      this.xyz[slot * 3 + 2] = f.z + z
      this.time[slot] = f.timestamp
      this.intensity[slot] = f.u8[i * 16 + 12]
      this.ring[slot] = f.u8[i * 16 + 13]
      this.truth[slot] = truth?.[i] ?? 0
      this.range[slot] = Math.hypot(x, y, z)
      this.cursor = (slot + 1) % CAPACITY
      this.count = Math.min(CAPACITY, this.count + 1)
    }
    if (f.pointCount) this.sweepAz = f.u16[(f.pointCount - 1) * 8 + 7] * Math.PI / 18000
    this.ego = { x: f.x, y: f.y, z: f.z, yaw: f.yaw }
    this.now = f.timestamp
    this.wall = performance.now()
  }

  clear(): void { this.cursor = this.count = this.pointsHeld = 0; this.tracks = [] }
  setTracks(tracks: Track[]): void { this.tracks = tracks }
  setSelected(id: number | null): void { this.selected = id }
  setRunning(value: boolean): void { this.running = value }
  setMaxRange(value: number): void { this.distance *= value / this.maxRange; this.maxRange = value }
  setBeam(): void { /* All received elevations are projected directly. */ }
  setOutline(boxes: Float32Array | null): void { this.outline = boxes }
  setColorMode(mode: ColorMode): void {
    this.mode = mode
    const ramp = buildRamp(PALETTE, mode)
    this.colors = Array.from({ length: 256 }, (_, i) => `rgb(${ramp[i * 4]} ${ramp[i * 4 + 1]} ${ramp[i * 4 + 2]})`)
  }
  setPointSize(size: number): void { this.pointSize = size }
  setPersistence(seconds: number): void { this.persist = seconds }
  setLayers(layers: Layers): void { this.layers = layers }
  setCamera(preset: CameraPreset): void {
    this.theta = preset === 'side' ? 1.32 : preset === 'plan' ? 0 : .48
    this.phi = preset === 'plan' ? .04 : 1.04
    this.distance = (preset === 'plan' ? 150 : 55) * this.maxRange / 120
    this.headingUp = preset !== 'plan'
  }
  dispose(): void { cancelAnimationFrame(this.raf); this.observer.disconnect(); this.events.abort() }

  private resize(): void {
    const host = this.canvas.parentElement!
    // One backing pixel per CSS pixel keeps CPU work bounded on high-DPI screens.
    this.canvas.width = Math.max(1, host.clientWidth)
    this.canvas.height = Math.max(1, host.clientHeight)
  }

  private project(x: number, y: number, z: number): [number, number] | null {
    const b = this.basis, dx = x - b.x, dy = y - b.y, dz = z - b.z
    const right = -dx * b.sin + dy * b.cos
    const along = dx * b.cos + dy * b.sin
    const up = along * b.pitchCos + dz * b.pitchSin
    const depth = this.distance + along * b.pitchSin - dz * b.pitchCos
    if (depth < .5) return null
    const scale = this.canvas.height * 1.22 / depth
    return [this.canvas.width / 2 + right * scale, this.canvas.height * .56 - up * scale]
  }

  private line(points: Array<[number, number, number]>): void {
    const ctx = this.ctx
    ctx.beginPath()
    let started = false
    for (const point of points) {
      const p = this.project(...point)
      if (!p) { started = false; continue }
      if (started) ctx.lineTo(...p)
      else { ctx.moveTo(...p); started = true }
    }
    ctx.stroke()
  }

  private frame = (wall: number): void => {
    this.raf = requestAnimationFrame(this.frame)
    if (wall - this.lastPaint < 65 || document.hidden) return
    this.lastPaint = wall
    const ctx = this.ctx, width = this.canvas.width, height = this.canvas.height
    ctx.globalAlpha = 1
    ctx.fillStyle = PALETTE.ground
    ctx.fillRect(0, 0, width, height)
    const yaw = (this.headingUp ? this.ego.yaw : 0) + this.theta
    this.basis = { x: this.ego.x, y: this.ego.y, z: this.ego.z - .5, yaw, sin: Math.sin(yaw), cos: Math.cos(yaw), pitchSin: Math.sin(this.phi), pitchCos: Math.cos(this.phi) }
    if (!this.count) return
    if (this.layers.rings) {
      ctx.strokeStyle = PALETTE.scale
      ctx.lineWidth = .7
      const step = this.maxRange / 6
      for (let r = step; r <= this.maxRange; r += step) {
        this.line(Array.from({ length: 73 }, (_, i) => [this.ego.x + Math.cos(i * Math.PI / 36) * r, this.ego.y + Math.sin(i * Math.PI / 36) * r, this.ego.z - 1.8]))
      }
    }
    if (this.layers.sweep) {
      const angle = this.ego.yaw + this.sweepAz
      ctx.strokeStyle = PALETTE.exhibit
      ctx.globalAlpha = .25
      this.line([[this.ego.x, this.ego.y, this.ego.z - 1.8], [this.ego.x + Math.cos(angle) * this.maxRange, this.ego.y + Math.sin(angle) * this.maxRange, this.ego.z - 1.8]])
      ctx.globalAlpha = 1
    }
    const now = this.now + (this.running ? Math.min(.1, (wall - this.wall) / 1000) : 0)
    let visible = 0
    const size = Math.max(1, this.pointSize * .65)
    for (let i = 0; i < this.count; i++) {
      const age = now - this.time[i]
      if (age > this.persist || age < -.5) continue
      visible++
      const z = this.xyz[i * 3 + 2]
      const point = this.project(this.xyz[i * 3], this.xyz[i * 3 + 1], z)
      if (!point || point[0] < 0 || point[0] > width || point[1] < 0 || point[1] > height) continue
      let t = this.range[i] / this.maxRange
      if (this.mode === 'height') t = (z - this.ego.z + 1.8) / HEIGHT_MAX
      else if (this.mode === 'intensity') t = this.intensity[i] <= 100 ? this.intensity[i] / 125 : .8 + (this.intensity[i] - 100) / 775
      else if (this.mode === 'ring') t = this.ring[i] % 2 ? .75 : .25
      else if (this.mode === 'truth') t = (this.truth[i] * 16 + 8) / 255
      ctx.fillStyle = this.colors[Math.max(0, Math.min(255, Math.floor(t * 255)))]
      ctx.globalAlpha = Math.max(.12, (1 - age / this.persist * .65) * (.35 + this.intensity[i] / 255 * .65))
      ctx.fillRect(point[0], point[1], size, size)
    }
    this.pointsHeld = visible
    ctx.globalAlpha = 1
    if (this.layers.outline && this.outline) {
      ctx.strokeStyle = PALETTE.outline
      ctx.globalAlpha = .25
      for (let i = 0; i < this.outline.length; i += 7) {
        const [x, y, z, hx, hy, hz, angle] = this.outline.subarray(i, i + 7)
        const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]]
        this.line(corners.map(([a, b]) => [x + a * Math.cos(angle) - b * Math.sin(angle), y + a * Math.sin(angle) + b * Math.cos(angle), z + hz]))
      }
      ctx.globalAlpha = 1
    }
    this.hits = []
    if (!this.layers.tracks) return
    ctx.font = '600 12px sans-serif'
    for (const track of this.tracks) {
      const n = this.exhibitOf(track.id), point = this.project(track.x, track.y, track.z + track.height / 2)
      if (n === undefined || !point) continue
      const [x, y] = point
      this.hits.push({ id: track.id, x, y })
      ctx.strokeStyle = track.id === this.selected ? PALETTE.ink : PALETTE.exhibit
      ctx.lineWidth = track.id === this.selected ? 2 : 1
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = PALETTE.exhibit
      ctx.fillText(String(n).padStart(2, '0'), x + 15, y + 4)
    }
  }
}
