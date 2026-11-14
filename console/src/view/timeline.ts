import { clock, type Exhibit, type ExhibitKind } from '../exhibits'
import { PALETTE } from './palettes'

const WINDOW_S = 60
const LANES: Array<{ kind: ExhibitKind; label: string }> = [
  { kind: 'object', label: 'LiDAR' },
  { kind: 'wifi', label: 'Wi-Fi' },
  { kind: 'sound', label: 'Acoustic' },
  { kind: 'recording', label: 'Sealed' },
]
const LABEL_W = 76
const FONT = '600 11px "Sofia Sans Variable", system-ui, sans-serif'
const NUM_FONT = '700 12px "Sofia Sans Extra Condensed", system-ui, sans-serif'

/**
 * The last minute of every sensor on one time axis. Each exhibit is a bar whose
 * length is how long it lasted; an exhibit still open runs to "now". A new sound
 * event inverts its lane for one frame.
 */
export class Timeline {
  onSelect: (n: number) => void = () => {}
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private flashLane = -1
  private observer: ResizeObserver
  private w = 0
  private h = 0
  private hits: Array<{ x0: number; x1: number; y0: number; y1: number; n: number }> = []
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  selected: number | null = null

  private canvas: HTMLCanvasElement
  private source: () => Exhibit[]

  constructor(canvas: HTMLCanvasElement, source: () => Exhibit[]) {
    this.canvas = canvas
    this.source = source
    this.ctx = canvas.getContext('2d')!
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas)
    this.resize()
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      const hit = this.hits.find((b) => x >= b.x0 - 3 && x <= b.x1 + 3 && y >= b.y0 && y <= b.y1)
      if (hit) this.onSelect(hit.n)
    })
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      this.draw()
    }
    loop()
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
  }

  /** A sound was just logged: invert its lane for one frame. */
  flash(kind: ExhibitKind): void {
    if (!this.reduced) this.flashLane = LANES.findIndex((l) => l.kind === kind)
  }

  private resize(): void {
    const dpr = Math.min(devicePixelRatio, 2)
    this.w = this.canvas.clientWidth
    this.h = this.canvas.clientHeight
    this.canvas.width = Math.round(this.w * dpr)
    this.canvas.height = Math.round(this.h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private draw(): void {
    const { ctx, w, h } = this
    if (!w || !h) return
    const p = PALETTE
    const now = clock()
    const axisH = 16
    const laneH = Math.floor((h - axisH) / LANES.length)
    const x = (t: number) => LABEL_W + ((t - (now - WINDOW_S)) / WINDOW_S) * (w - LABEL_W - 8)
    ctx.clearRect(0, 0, w, h)
    this.hits = []
    const items = this.source()

    LANES.forEach((lane, i) => {
      const y = i * laneH
      const inverted = this.flashLane === i
      ctx.fillStyle = inverted ? p.ink : i % 2 ? '#14181b' : '#171b1e'
      ctx.fillRect(LABEL_W, y, w - LABEL_W, laneH - 2)
      ctx.fillStyle = '#a9a397'
      ctx.font = FONT
      ctx.textBaseline = 'middle'
      ctx.fillText(lane.label, 0, y + laneH / 2)
      const colour = lane.kind === 'object' ? p.exhibit : lane.kind === 'wifi' ? p.radio : lane.kind === 'sound' ? p.sound : p.seal
      for (const e of items) {
        if (e.kind !== lane.kind || e.end < now - WINDOW_S) continue
        const x0 = Math.max(LABEL_W, x(e.start))
        const x1 = Math.max(x0 + 3, x(e.open ? now : e.end))
        const bh = lane.kind === 'object' ? 6 : laneH - 10
        // Objects stack in thin rows so overlapping tracks stay apart.
        const row = lane.kind === 'object' ? (e.n % Math.max(1, Math.floor((laneH - 6) / 8))) : 0
        const by = lane.kind === 'object' ? y + 3 + row * 8 : y + 4
        ctx.fillStyle = inverted ? p.ground : colour
        ctx.globalAlpha = this.selected === null || this.selected === e.n ? 1 : 0.55
        ctx.fillRect(x0, by, x1 - x0, bh)
        if (this.selected === e.n) {
          ctx.strokeStyle = p.ink
          ctx.lineWidth = 2
          ctx.strokeRect(x0 - 2, by - 2, x1 - x0 + 4, bh + 4)
        }
        ctx.globalAlpha = 1
        if (lane.kind !== 'object' && x1 - x0 > 22) {
          ctx.fillStyle = lane.kind === 'wifi' || lane.kind === 'recording' ? p.ink : p.ground
          ctx.font = NUM_FONT
          ctx.fillText(String(e.n), x0 + 4, by + bh / 2 + 1)
        }
        this.hits.push({ x0, x1, y0: y, y1: y + laneH, n: e.n })
      }
    })
    this.flashLane = -1

    // Time axis: every ten seconds back from now.
    const ay = LANES.length * laneH + axisH / 2
    ctx.fillStyle = '#7d7a72'
    ctx.font = FONT
    for (let s = 0; s <= WINDOW_S; s += 10) {
      const xx = x(now - s)
      ctx.textAlign = s === 0 ? 'right' : 'center'
      ctx.fillText(s === 0 ? 'now' : `−${s} s`, xx, ay)
    }
    ctx.textAlign = 'left'
  }
}
