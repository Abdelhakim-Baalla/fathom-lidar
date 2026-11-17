import { ROOM, type Person } from '../wifi/csi'
import { PALETTE, hex } from './palettes'

const COLS = 600 // last 600 received packets; duration depends on the actual packet rate
const PLAN_W = 168
const TRACE_W = 220
const ON = 2.6

/**
 * Three views of one Wi-Fi link: the room plan (simulation only), a waterfall of
 * subcarrier amplitudes over recent received samples, and the motion score against its threshold.
 */
export class WifiView {
  private ctx: CanvasRenderingContext2D
  private wf = document.createElement('canvas')
  private wfCtx: CanvasRenderingContext2D
  private latest: Float32Array | null = null
  private score: number[] = []
  private moving: boolean[] = []
  private people: Person[] | null = null
  private raf = 0
  private observer: ResizeObserver
  private w = 0
  private h = 0
  private canvas: HTMLCanvasElement
  private rows = 56
  private ramp: Array<[number, number, number]> = []

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.wf.width = COLS
    this.wf.height = this.rows
    this.wfCtx = this.wf.getContext('2d')!
    this.wfCtx.fillStyle = '#0d1012'
    this.wfCtx.fillRect(0, 0, COLS, this.rows)
    const stops = ['#0d1012', '#1d2f5c', PALETTE.radio, '#c9d6ff'].map(hex)
    for (let i = 0; i < 256; i++) {
      const f = (i / 255) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(f)), u = f - k
      this.ramp.push([0, 1, 2].map((c) => stops[k][c] + (stops[k + 1][c] - stops[k][c]) * u) as [number, number, number])
    }
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas)
    this.resize()
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

  push(norm: Float32Array, score: number, moving: boolean, people: Person[] | null): void {
    this.latest = norm
    this.scroll()
    this.people = people
    this.score.push(score)
    this.moving.push(moving)
    if (this.score.length > COLS) { this.score.shift(); this.moving.shift() }
  }

  clear(): void {
    this.latest = null
    this.people = null
    this.score = []
    this.moving = []
    this.wfCtx.fillStyle = '#0d1012'
    this.wfCtx.fillRect(0, 0, COLS, this.rows)
  }

  private resize(): void {
    const dpr = Math.min(devicePixelRatio, 2)
    this.w = this.canvas.clientWidth
    this.h = this.canvas.clientHeight
    this.canvas.width = Math.round(this.w * dpr)
    this.canvas.height = Math.round(this.h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private scroll(): void {
    const a = this.latest
    if (!a) return
    if (a.length !== this.rows) {
      this.rows = a.length
      this.wf.height = this.rows
      this.score = []
      this.moving = []
      this.wfCtx.fillStyle = '#0d1012'
      this.wfCtx.fillRect(0, 0, COLS, this.rows)
    }
    // Shift left one column and paint the newest packet on the right.
    this.wfCtx.drawImage(this.wf, -1, 0)
    const img = this.wfCtx.createImageData(1, this.rows)
    for (let r = 0; r < this.rows; r++) {
      // Normalised amplitude 0.2…1.8 → ramp; highest subcarrier at the top.
      const v = a[this.rows - 1 - r]
      const k = Math.max(0, Math.min(255, Math.round(((v - 0.2) / 1.6) * 255)))
      const [cr, cg, cb] = v > 0 ? this.ramp[k] : [13, 16, 18]
      img.data.set([cr, cg, cb, 255], r * 4)
    }
    this.wfCtx.putImageData(img, COLS - 1, 0)
  }

  private draw(): void {
    const { ctx, w, h } = this
    if (!w || !h) return
    const p = PALETTE
    ctx.clearRect(0, 0, w, h)
    ctx.font = '600 11px "Sofia Sans Variable", system-ui, sans-serif'
    ctx.textBaseline = 'top'

    // Plan
    const showPlan = this.people !== null && w > 640
    let x0 = 0
    if (showPlan) {
      const s = Math.min((PLAN_W - 16) / ROOM.width, (h - 24) / ROOM.depth)
      const ox = 4, oy = 18
      const X = (x: number) => ox + x * s, Y = (y: number) => oy + (ROOM.depth - y) * s
      ctx.fillStyle = '#a8adb6'
      ctx.fillText('Room 8 × 6 m · ground truth', 4, 2)
      ctx.fillStyle = '#1f2529'
      ctx.fillRect(X(0), Y(ROOM.depth), ROOM.width * s, ROOM.depth * s)
      // first Fresnel zone of the link
      const [tx, ty] = ROOM.tx, [rx, ry] = ROOM.rx
      const d = Math.hypot(rx - tx, ry - ty), lam = 0.123
      const a = (d + lam / 2) / 2, b = Math.sqrt(a * a - (d / 2) ** 2)
      ctx.save()
      ctx.translate(X((tx + rx) / 2), Y((ty + ry) / 2))
      ctx.rotate(-Math.atan2(ry - ty, rx - tx))
      ctx.fillStyle = 'rgba(91,134,255,0.18)'
      ctx.beginPath()
      ctx.ellipse(0, 0, a * s, b * s, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = p.radio
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(X(tx), Y(ty)); ctx.lineTo(X(rx), Y(ry)); ctx.stroke()
      ctx.fillStyle = p.radio
      for (const [px, py, l] of [[tx, ty, 'TX'], [rx, ry, 'RX']] as const) {
        ctx.fillRect(X(px) - 3, Y(py) - 3, 6, 6)
        ctx.fillText(l, X(px) - 6, Y(py) + 6)
      }
      ctx.strokeStyle = p.ink
      ctx.lineWidth = 1.5
      for (const person of this.people!) {
        ctx.beginPath()
        ctx.arc(X(person.x), Y(person.y), 4, 0, Math.PI * 2)
        ctx.stroke()
      }
      // door
      ctx.fillStyle = '#a8adb6'
      ctx.fillRect(X(ROOM.door[0]) - 6, Y(ROOM.door[1]) - 1, 12, 2)
      x0 = PLAN_W + 8
    }

    // Waterfall
    const traceWidth = Math.min(TRACE_W, w * 0.32)
    const wfW = Math.max(1, w - x0 - traceWidth - 12)
    ctx.fillStyle = '#a8adb6'
    ctx.fillText(`Subcarrier amplitude · ${this.rows} subcarriers · 600 packets`, x0, 2)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(this.wf, x0, 18, wfW, h - 20)

    // Motion score
    const tx0 = w - traceWidth
    ctx.fillText('Motion score, × quiet floor', tx0, 2)
    const top = 18, bh = h - 20
    ctx.fillStyle = '#14181b'
    ctx.fillRect(tx0, top, traceWidth, bh)
    const max = 8
    const Ys = (v: number) => top + bh - (Math.min(v, max) / max) * bh
    const n = this.score.length
    for (let i = 0; i < n; i++) {
      if (!this.moving[i]) continue
      ctx.fillStyle = 'rgba(91,134,255,0.22)'
      ctx.fillRect(tx0 + ((i + COLS - n) / COLS) * traceWidth, top, traceWidth / COLS + 0.5, bh)
    }
    ctx.strokeStyle = '#a8adb6'
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(tx0, Ys(ON)); ctx.lineTo(w, Ys(ON)); ctx.stroke()
    ctx.setLineDash([])
    ctx.strokeStyle = p.radio
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const xx = tx0 + ((i + COLS - n) / COLS) * traceWidth
      if (i === 0) ctx.moveTo(xx, Ys(this.score[i]))
      else ctx.lineTo(xx, Ys(this.score[i]))
    }
    ctx.stroke()
    ctx.fillStyle = '#c3c6cd'
    ctx.fillText('threshold', tx0 + 4, Ys(ON) - 14)
  }
}
