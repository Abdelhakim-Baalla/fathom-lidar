import type { SoundAnalyser } from '../acoustic/analyse'
import { hex } from './palettes'

const COLS = 600 // ten seconds at 60 blocks per second
const ROWS = 120
const F_LO = 50, F_HI = 12000
const DB_LO = -110, DB_HI = -30
const METER_W = 64

/** Scrolling log-frequency spectrogram of the microphone with a level meter. */
export class Spectrogram {
  private ctx: CanvasRenderingContext2D
  private sg = document.createElement('canvas')
  private sgCtx: CanvasRenderingContext2D
  private pending = 0
  private ramp: Array<[number, number, number]> = []
  private observer: ResizeObserver
  private raf = 0
  private w = 0
  private h = 0
  private canvas: HTMLCanvasElement
  private analyser: SoundAnalyser
  private sampleRate: () => number
  live = false

  constructor(canvas: HTMLCanvasElement, analyser: SoundAnalyser, sampleRate: () => number) {
    this.canvas = canvas
    this.analyser = analyser
    this.sampleRate = sampleRate
    this.ctx = canvas.getContext('2d')!
    this.sg.width = COLS
    this.sg.height = ROWS
    this.sgCtx = this.sg.getContext('2d')!
    this.sgCtx.fillStyle = '#0d1012'
    this.sgCtx.fillRect(0, 0, COLS, ROWS)
    const stops = ['#0d1012', '#3a4248', '#a9a397', '#f3eee2'].map(hex)
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

  /** a new block was analysed */
  tick(): void {
    this.pending++
  }

  private resize(): void {
    const dpr = Math.min(devicePixelRatio, 2)
    this.w = this.canvas.clientWidth
    this.h = this.canvas.clientHeight
    this.canvas.width = Math.round(this.w * dpr)
    this.canvas.height = Math.round(this.h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private column(): void {
    const spec = this.analyser.spectrum
    if (!spec.length) return
    const binHz = this.sampleRate() / (spec.length * 2)
    this.sgCtx.drawImage(this.sg, -1, 0)
    const img = this.sgCtx.createImageData(1, ROWS)
    for (let r = 0; r < ROWS; r++) {
      // Row 0 is the top: highest frequency.
      const f0 = F_LO * (F_HI / F_LO) ** ((ROWS - 1 - r) / ROWS)
      const f1 = F_LO * (F_HI / F_LO) ** ((ROWS - r) / ROWS)
      let m = -200
      for (let k = Math.max(1, Math.floor(f0 / binHz)); k <= Math.min(spec.length - 1, Math.ceil(f1 / binHz)); k++) m = Math.max(m, spec[k])
      const t = Math.max(0, Math.min(255, Math.round(((m - DB_LO) / (DB_HI - DB_LO)) * 255)))
      img.data.set([...this.ramp[t], 255], r * 4)
    }
    this.sgCtx.putImageData(img, COLS - 1, 0)
  }

  private draw(): void {
    const { ctx, w, h } = this
    if (!w || !h) return
    for (; this.pending > 0; this.pending--) this.column()
    ctx.clearRect(0, 0, w, h)
    ctx.font = '600 11px "Sofia Sans Variable", system-ui, sans-serif'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#7d7a72'
    const sgW = w - METER_W - 44
    ctx.fillText('Spectrum · 50 Hz – 12 kHz, log scale · 10 s', 40, 2)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.sg, 40, 18, sgW, h - 20)
    // frequency marks
    ctx.textAlign = 'right'
    for (const f of [100, 1000, 10000]) {
      const y = 18 + (h - 20) * (1 - Math.log(f / F_LO) / Math.log(F_HI / F_LO))
      ctx.fillText(f >= 1000 ? `${f / 1000} k` : `${f}`, 34, y - 6)
    }
    ctx.textAlign = 'left'

    // Level meter, dBFS
    const mx = w - METER_W, top = 18, mh = h - 20
    ctx.fillStyle = '#7d7a72'
    ctx.fillText('dBFS', mx, 2)
    ctx.fillStyle = '#14181b'
    ctx.fillRect(mx, top, 14, mh)
    const Y = (db: number) => top + mh * (1 - Math.max(0, Math.min(1, (db + 100) / 100)))
    if (this.live) {
      ctx.fillStyle = '#ebe5d6'
      const y = Y(this.analyser.levelDb)
      ctx.fillRect(mx, y, 14, top + mh - y)
      ctx.fillStyle = '#f2c230'
      ctx.fillRect(mx - 3, Y(this.analyser.floorDb + 12) - 1, 20, 2)
      ctx.fillStyle = '#a9a397'
      ctx.fillText(`${Math.round(this.analyser.levelDb)}`, mx + 20, Math.min(top + mh - 12, y - 6))
    }
  }
}
