import type { Frame } from '../protocol/frame'
import { PALETTE } from './palettes'

const COLUMNS = 900 // 0.4° per column

/**
 * The sensor's own view: one row per channel, one column per bearing, shaded by range.
 * Bearing runs right to left so the image reads like looking out from the sensor.
 */
export class RangeImage {
  private ctx: CanvasRenderingContext2D
  private image: ImageData
  private range = new Float32Array(0)
  private channels = 32
  private maxRange = 120
  private ramp = new Uint8Array(256 * 3)
  private water = [0, 0, 0]
  private dirty = false
  private raf = 0

  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.image = this.ctx.createImageData(COLUMNS, 32)
    this.setChannels(32)
    this.loadPalette()
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (this.dirty) this.paint()
    }
    loop()
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
  }

  setChannels(n: number): void {
    if (n === this.channels && this.range.length) return
    this.channels = n
    this.range = new Float32Array(COLUMNS * n)
    this.canvas.width = COLUMNS
    this.canvas.height = n
    this.image = this.ctx.createImageData(COLUMNS, n)
    this.dirty = true
  }

  setMaxRange(m: number): void {
    this.maxRange = m
    this.dirty = true
  }

  private loadPalette(): void {
    const p = PALETTE
    const stops = p.ramps.range.map((c) => {
      const n = parseInt(c.slice(1), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    })
    for (let i = 0; i < 256; i++) {
      const f = (i / 255) * (stops.length - 1)
      const k = Math.min(stops.length - 2, Math.floor(f))
      const u = f - k
      for (let c = 0; c < 3; c++) this.ramp[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * u
    }
    const n = parseInt('#121619'.slice(1), 16)
    this.water = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    this.dirty = true
  }

  push(f: Frame): void {
    if (f.pointCount === 0) return
    // Columns swept by this frame are cleared first, so missing returns show as gaps.
    // Sensors spin either way; the shorter arc between first and last column is the sweep.
    const a0 = f.u16[7], a1 = f.u16[(f.pointCount - 1) * 8 + 7]
    let c0 = Math.floor((a0 / 36000) * COLUMNS), c1 = Math.floor((a1 / 36000) * COLUMNS)
    if ((c1 - c0 + COLUMNS) % COLUMNS > COLUMNS / 2) [c0, c1] = [c1, c0]
    for (let c = c0; c !== (c1 + 1) % COLUMNS; c = (c + 1) % COLUMNS) {
      for (let r = 0; r < this.channels; r++) this.range[r * COLUMNS + c] = 0
    }
    for (let i = 0; i < f.pointCount; i++) {
      const ring = f.u8[i * 16 + 13]
      if (ring >= this.channels) continue
      const col = Math.min(COLUMNS - 1, Math.floor((f.u16[i * 8 + 7] / 36000) * COLUMNS))
      const x = f.f32[i * 4], y = f.f32[i * 4 + 1], z = f.f32[i * 4 + 2]
      this.range[ring * COLUMNS + col] = Math.sqrt(x * x + y * y + z * z)
    }
    this.dirty = true
  }

  private paint(): void {
    this.dirty = false
    const d = this.image.data
    const n = this.channels
    for (let r = 0; r < n; r++) {
      const row = n - 1 - r // highest beam on top
      for (let c = 0; c < COLUMNS; c++) {
        const v = this.range[r * COLUMNS + c]
        const o = (row * COLUMNS + (COLUMNS - 1 - c)) * 4
        if (v <= 0) {
          d[o] = this.water[0]; d[o + 1] = this.water[1]; d[o + 2] = this.water[2]
        } else {
          const k = Math.min(255, Math.floor((v / this.maxRange) * 255)) * 3
          d[o] = this.ramp[k]; d[o + 1] = this.ramp[k + 1]; d[o + 2] = this.ramp[k + 2]
        }
        d[o + 3] = 255
      }
    }
    this.ctx.putImageData(this.image, 0, 0)
  }
}
