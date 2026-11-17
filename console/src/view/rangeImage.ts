import type { Track } from '../perception/track'
import type { Frame } from '../protocol/frame'

const COLUMNS = 1440 // 0.25° per column, finer than the firing step
const TWO_PI = Math.PI * 2

/**
 * Range colours, near to far. The image is the sensor's own view: bone-white
 * where the returns are strong and close, steel where they fade into the range
 * gate. Intensity multiplies the colour, so road paint and retroreflectors
 * stand out of the asphalt instead of the ground reading as one flat band.
 */
const STOPS: Array<[number, number, number]> = [
  [244, 244, 245],
  [202, 205, 211],
  [148, 155, 166],
  [85, 94, 108],
  [43, 50, 62],
  [21, 25, 34],
]
const BACKGROUND: [number, number, number] = [7, 10, 12]
const INK = '#f4f4f5'
const DIM = '#798287'
const FAINT = '#3a4247'
const EXHIBIT = '#f48142'

/**
 * The sensor's own view: one row per channel, one column per bearing, shaded by
 * range and intensity. Bearing runs right to left so the image reads like
 * looking out from the sensor, with straight ahead at the centre.
 */
export class RangeImage {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private image: ImageData | null = null
  private range = new Float32Array(0)
  private intensity = new Uint8Array(0)
  private channels = 32
  private maxRange = 120
  private fovUp = 15
  private fovDown = -25
  private ramp = new Uint8Array(256 * 3)
  private sweepAz = 0
  private dirty = true
  private raf = 0
  private lastPaint = 0
  private observer: ResizeObserver
  private contacts: Track[] = []
  private exhibitOf: (trackId: number) => number | undefined = () => undefined
  private ego = { x: 0, y: 0, z: 1.9, yaw: 0 }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.loadPalette()
    this.setChannels(32)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas)
    this.resize()
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop)
      // Sensors turn at 10 Hz; 25 fps is more than the data needs and leaves
      // the main thread alone between packets.
      if (this.dirty && now - this.lastPaint > 40) {
        this.lastPaint = now
        this.paint()
      }
    }
    this.raf = requestAnimationFrame(loop)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
  }

  setChannels(n: number): void {
    if (n === this.channels && this.range.length) return
    this.channels = n
    this.range = new Float32Array(COLUMNS * n)
    this.intensity = new Uint8Array(COLUMNS * n)
    this.dirty = true
  }

  setMaxRange(m: number): void {
    this.maxRange = m
    this.dirty = true
  }

  /** Vertical field of view, for placing contacts at their true elevation. */
  setBeam(fovUp: number, fovDown: number): void {
    this.fovUp = fovUp
    this.fovDown = fovDown
    this.dirty = true
  }

  /** Tracks for the contact reticles; only the logged ones carry a number. */
  setContacts(tracks: Track[], exhibitOf: (trackId: number) => number | undefined): void {
    this.contacts = tracks
    this.exhibitOf = exhibitOf
    this.dirty = true
  }

  private loadPalette(): void {
    for (let i = 0; i < 256; i++) {
      const f = (i / 255) * (STOPS.length - 1)
      const k = Math.min(STOPS.length - 2, Math.floor(f))
      const u = f - k
      for (let c = 0; c < 3; c++) this.ramp[i * 3 + c] = STOPS[k][c] + (STOPS[k + 1][c] - STOPS[k][c]) * u
    }
    this.dirty = true
  }

  private resize(): void {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const w = Math.max(320, Math.round(this.canvas.clientWidth * dpr))
    const h = Math.max(80, Math.round(this.canvas.clientHeight * dpr))
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w
      this.canvas.height = h
    }
    // A remount reuses the element at the right size, so the buffer is created
    // from its own dimensions, not only when the canvas had to be resized.
    if (!this.image || this.image.width !== w || this.image.height !== h) {
      this.image = this.ctx.createImageData(w, h)
      this.dirty = true
    }
  }

  push(f: Frame): void {
    if (f.pointCount === 0) return
    // Columns swept by this frame are cleared first, so missing returns show as gaps.
    // Sensors spin either way; the shorter arc between first and last column is the sweep.
    const a0 = f.u16[7], a1 = f.u16[(f.pointCount - 1) * 8 + 7]
    let c0 = Math.floor((a0 / 36000) * COLUMNS), c1 = Math.floor((a1 / 36000) * COLUMNS)
    if ((c1 - c0 + COLUMNS) % COLUMNS > COLUMNS / 2) [c0, c1] = [c1, c0]
    for (let c = c0; c !== (c1 + 1) % COLUMNS; c = (c + 1) % COLUMNS) {
      for (let r = 0; r < this.channels; r++) {
        this.range[r * COLUMNS + c] = 0
        this.intensity[r * COLUMNS + c] = 0
      }
    }
    for (let i = 0; i < f.pointCount; i++) {
      const ring = f.u8[i * 16 + 13]
      if (ring >= this.channels) continue
      const col = Math.min(COLUMNS - 1, Math.floor((f.u16[i * 8 + 7] / 36000) * COLUMNS))
      const x = f.f32[i * 4], y = f.f32[i * 4 + 1], z = f.f32[i * 4 + 2]
      const o = ring * COLUMNS + col
      this.range[o] = Math.sqrt(x * x + y * y + z * z)
      this.intensity[o] = f.u8[i * 16 + 12]
    }
    this.sweepAz = (a1 * TWO_PI) / 36000
    this.ego = { x: f.x, y: f.y, z: f.z, yaw: f.yaw }
    this.dirty = true
  }

  /** Bearing, clockwise from straight ahead, in degrees 0..360. */
  private bearingOfAz(az: number): number {
    return (360 - (az * 180) / Math.PI + 720) % 360
  }

  private paint(): void {
    this.dirty = false
    const d = this.image?.data
    if (!d) return
    const W = this.canvas.width, H = this.canvas.height
    const footer = Math.max(22, Math.min(32, Math.round(H * 0.19)))
    const imgH = H - footer
    const n = this.channels
    const span = Math.max(1, n - 1)
    const max = Math.max(1, this.maxRange)
    const tolBase = Math.max(2.5, max * 0.02)

    // ── Raster ──────────────────────────────────────────────────────────────
    // Each pixel samples the four neighbouring beam cells. Neighbours whose
    // range disagrees with the nearest one are dropped, so a facade edge stays
    // an edge instead of smearing into the sky behind it. This is a small
    // bilateral filter, not a box blur.
    for (let y = 0; y < imgH; y++) {
      const fr = (1 - y / Math.max(1, imgH - 1)) * span
      const r0 = Math.min(span, Math.floor(fr))
      const r1 = Math.min(span, r0 + 1)
      const fu = fr - r0
      const row = y * W
      for (let x = 0; x < W; x++) {
        const deg = (0.5 - x / Math.max(1, W - 1)) * 360
        const az = ((deg % 360) + 360) % 360
        const fc = (az / 360) * COLUMNS
        const c0 = Math.min(COLUMNS - 1, Math.floor(fc))
        const c1 = (c0 + 1) % COLUMNS
        const cu = fc - Math.floor(fc)
        const a = r0 * COLUMNS + c0, b = r0 * COLUMNS + c1
        const c = r1 * COLUMNS + c0, e = r1 * COLUMNS + c1
        const ra = this.range[a], rb = this.range[b], rc = this.range[c], re = this.range[e]
        const nearest = Math.min(ra > 0 ? ra : Infinity, rb > 0 ? rb : Infinity, rc > 0 ? rc : Infinity, re > 0 ? re : Infinity)
        const o = (row + x) * 4
        if (!isFinite(nearest)) {
          // Above the horizon the sky sits a shade cooler than the ground
          // clutter, so the image has a direction even where nothing returns.
          const lift = (1 - y / Math.max(1, imgH - 1)) * 5
          d[o] = BACKGROUND[0]; d[o + 1] = BACKGROUND[1] + lift * 0.45; d[o + 2] = BACKGROUND[2] + lift; d[o + 3] = 255
          continue
        }
        const tol = tolBase + nearest * 0.16
        const wA = (1 - cu) * (1 - fu), wB = cu * (1 - fu), wC = (1 - cu) * fu, wD = cu * fu
        let v = 0, vw = 0, isum = 0, iw = 0
        if (ra > 0 && Math.abs(ra - nearest) <= tol) { v += ra * wA; vw += wA; isum += this.intensity[a] * wA; iw += wA }
        if (rb > 0 && Math.abs(rb - nearest) <= tol) { v += rb * wB; vw += wB; isum += this.intensity[b] * wB; iw += wB }
        if (rc > 0 && Math.abs(rc - nearest) <= tol) { v += rc * wC; vw += wC; isum += this.intensity[c] * wC; iw += wC }
        if (re > 0 && Math.abs(re - nearest) <= tol) { v += re * wD; vw += wD; isum += this.intensity[e] * wD; iw += wD }
        if (vw < 1e-4) { v = nearest; isum = 0; vw = 1; iw = 0 }
        v /= vw
        const i = Math.min(255, iw > 0 ? isum / iw : 0) / 255

        // Range sets the stock colour; reflectivity gates brightness, so asphalt
        // stays dark and glass reads cold while paint and reflectors burn warm.
        // The extra weight on the dark end gives the image a true black and a
        // brighter highlight instead of a uniformly pale sheet.
        const rr = Math.min(1, v / max)
        const si = Math.min(255, Math.round(Math.pow(rr, 0.78) * 255)) * 3
        const depth = 1 - 0.3 * Math.pow(rr, 1.45)
        const k = 0.14 + 1.2 * Math.pow(i, 0.55)
        let r = this.ramp[si] * k * depth
        let g = this.ramp[si + 1] * k * depth
        let bl = this.ramp[si + 2] * k * depth
        if (i > 0.62) {
          const w = Math.min(0.62, (i - 0.62) * 1.8)
          r += 92 * w; g += 68 * w; bl += 26 * w
        }
        // Fine dither: the instrument should read as a sensor, not a gradient.
        const grain = ((x * 928371 + y * 1237) & 15) - 7.5
        // A trickle of missing returns, denser where the signal is weak. Real
        // range images are perforated, not painted.
        const speck = ((x * 374761 + y * 668265 + (x >> 3) * 127) & 1023) / 1023
        if (speck < 0.004 + (1 - i) * 0.01) {
          d[o] = BACKGROUND[0]; d[o + 1] = BACKGROUND[1]; d[o + 2] = BACKGROUND[2]; d[o + 3] = 255
          continue
        }
        d[o] = Math.max(0, Math.min(255, r + grain * 1.25))
        d[o + 1] = Math.max(0, Math.min(255, g + grain * 1.25))
        d[o + 2] = Math.max(0, Math.min(255, bl + grain * 1.25))
        d[o + 3] = 255
      }
    }
    // The footer is part of the instrument: bearings, not decoration.
    for (let y = imgH; y < H; y++) {
      let o = y * W * 4
      for (let x = 0; x < W; x++, o += 4) {
        d[o] = 10; d[o + 1] = 13; d[o + 2] = 15; d[o + 3] = 255
      }
    }
    this.ctx.putImageData(this.image!, 0, 0)

    // ── Overlay ─────────────────────────────────────────────────────────────
    const elevY = (deg: number) => (1 - (deg - this.fovDown) / Math.max(1, this.fovUp - this.fovDown)) * (imgH - 1)
    const topY = Math.max(10, Math.round(imgH * 0.1))
    this.ctx.textBaseline = 'top'
    this.ctx.font = `600 ${Math.max(9, Math.round(H * 0.068))}px "Sofia Sans Extra Condensed", system-ui, sans-serif`

    // A thin gradient key for the range scale.
    this.ctx.fillStyle = DIM
    this.ctx.fillText(`0 – ${max} m`, 8, topY - 9)
    const keyX = 8, keyY = topY + Math.round(H * 0.062), keyW = 44, keyH = 3
    for (let k = 0; k < keyW; k++) {
      const f = k / (keyW - 1)
      const si = Math.round(Math.pow(f, 0.78) * (STOPS.length - 1))
      this.ctx.fillStyle = `rgb(${STOPS[si][0]} ${STOPS[si][1]} ${STOPS[si][2]})`
      this.ctx.fillRect(keyX + k, keyY, 1, keyH)
    }

    // Elevation scale: the vertical axis is what a range image is for.
    this.ctx.strokeStyle = 'rgba(235,229,214,0.22)'
    this.ctx.lineWidth = 1
    this.ctx.beginPath()
    this.ctx.moveTo(13, Math.max(4, elevY(this.fovUp)))
    this.ctx.lineTo(13, Math.min(imgH - 4, elevY(this.fovDown)))
    this.ctx.stroke()
    this.ctx.font = `600 ${Math.max(8, Math.round(H * 0.052))}px "Sofia Sans Extra Condensed", system-ui, sans-serif`
    for (const deg of [10, 0, -10, -20]) {
      if (deg > this.fovUp || deg < this.fovDown) continue
      const y = elevY(deg)
      this.ctx.strokeStyle = deg === 0 ? 'rgba(235,229,214,0.5)' : 'rgba(235,229,214,0.25)'
      this.ctx.beginPath()
      this.ctx.moveTo(13, y)
      this.ctx.lineTo(deg === 0 ? 26 : 20, y)
      this.ctx.stroke()
      this.ctx.fillStyle = deg === 0 ? INK : DIM
      this.ctx.fillText(`${deg > 0 ? '+' : ''}${deg}°`, 29, y - 4)
    }

    // Horizon: the one reference every range image has.
    const hz = elevY(0)
    if (hz > 2 && hz < imgH - 2) {
      this.ctx.strokeStyle = 'rgba(235,229,214,0.18)'
      this.ctx.setLineDash([2, 6])
      this.ctx.beginPath()
      this.ctx.moveTo(30, hz + 0.5)
      this.ctx.lineTo(W - 8, hz + 0.5)
      this.ctx.stroke()
      this.ctx.setLineDash([])
    }

    // Faint row structure: every eighth channel, not a grid over the picture.
    this.ctx.fillStyle = 'rgba(7,10,12,0.22)'
    for (let r = 8; r < n; r += 8) {
      const y = Math.round((1 - r / span) * (imgH - 1))
      if (y > 0 && y < imgH) this.ctx.fillRect(0, y, W, 1)
    }

    // The sweep cursor with a short wake: the sensor is turning clockwise, which
    // moves the cursor from right to left in this bearing map.
    const sx = (0.5 - this.sweepAz / TWO_PI) * W
    const trail = this.ctx.createLinearGradient(sx, 0, sx + 30, 0)
    trail.addColorStop(0, 'rgba(244,129,66,0.11)')
    trail.addColorStop(1, 'rgba(244,129,66,0)')
    this.ctx.fillStyle = trail
    this.ctx.fillRect(sx, 0, 30, imgH)
    this.ctx.fillStyle = 'rgba(244,129,66,0.5)'
    this.ctx.fillRect(sx, 0, 1, imgH)
    this.ctx.fillStyle = EXHIBIT
    this.ctx.beginPath()
    this.ctx.moveTo(sx - 4, 0)
    this.ctx.lineTo(sx + 4, 0)
    this.ctx.lineTo(sx, 6)
    this.ctx.closePath()
    this.ctx.fill()

    // Bearing readout, three digits, clockwise from the nose, on a dark plate.
    const bear = Math.round(this.bearingOfAz(this.sweepAz)) % 360
    const az = String(bear).padStart(3, '0')
    const azFont = Math.max(11, Math.round(H * 0.082))
    this.ctx.font = `800 ${azFont}px "Sofia Sans Extra Condensed", system-ui, sans-serif`
    const azW = this.ctx.measureText(`AZ ${az}`).width + 10
    this.ctx.fillStyle = 'rgba(9,12,14,0.74)'
    this.ctx.fillRect(W - azW - 6, 4, azW, azFont + 6)
    this.ctx.fillStyle = INK
    this.ctx.textAlign = 'right'
    this.ctx.fillText(`AZ ${az}`, W - 10, 7)
    this.ctx.textAlign = 'left'

    // Bearing ruler: a fine 5° comb with labelled 30° marks.
    const tickTop = imgH + 1
    this.ctx.fillStyle = 'rgba(235,229,214,0.12)'
    this.ctx.fillRect(0, imgH, W, 1)
    this.ctx.font = `700 ${Math.max(8, Math.round(footer * 0.5))}px "Sofia Sans Extra Condensed", system-ui, sans-serif`
    for (let b = 0; b < 360; b += 5) {
      const rel = b <= 180 ? b : b - 360
      const x = (0.5 + rel / 360) * W
      const major = b % 30 === 0
      this.ctx.fillStyle = major ? DIM : FAINT
      this.ctx.fillRect(Math.round(x), tickTop, 1, major ? footer * 0.26 : b % 10 === 0 ? footer * 0.18 : footer * 0.1)
      if (major) {
        const label = String(b).padStart(3, '0')
        this.ctx.fillStyle = b === 0 ? INK : DIM
        // The 180° label sits on the edge of the map; right-align it so it is
        // not sliced in half by the canvas border.
        this.ctx.textAlign = x > W - 16 ? 'right' : x < 16 ? 'left' : 'center'
        this.ctx.textBaseline = 'middle'
        this.ctx.fillText(label, Math.min(W - 2, Math.max(2, x)), imgH + footer * 0.64)
        this.ctx.textBaseline = 'top'
      }
    }
    this.ctx.textAlign = 'left'

    // Contacts: the logged exhibits, at their bearing and elevation. Labels are
    // placed on the first free side of the reticle so two adjacent exhibits do
    // not print on top of each other.
    this.ctx.font = `800 ${Math.max(10, Math.round(footer * 0.6))}px "Sofia Sans Extra Condensed", system-ui, sans-serif`
    this.ctx.textBaseline = 'middle'
    const placed: Array<[number, number, number, number]> = []
    for (const t of this.contacts) {
      const n = this.exhibitOf(t.id)
      if (n === undefined) continue
      const dx = t.x - this.ego.x, dy = t.y - this.ego.y
      const dist = Math.hypot(dx, dy)
      if (dist < 1 || dist > this.maxRange * 1.1) continue
      let rel = Math.atan2(dy, dx) - this.ego.yaw
      rel = Math.atan2(Math.sin(rel), Math.cos(rel))
      const x = (0.5 - rel / TWO_PI) * W
      const elev = (Math.atan2(t.z - this.ego.z, dist) * 180) / Math.PI
      const y = Math.min(imgH - 8, Math.max(8, elevY(elev)))
      if (x < 8 || x > W - 8) continue

      // Course vector: a two-second lead line in bearing/elevation, so a moving
      // contact reads as a track rather than a dot on the range image.
      const speed = Math.hypot(t.vx, t.vy)
      if (speed > 0.6) {
        const hx = t.x + t.vx * 2.2, hy = t.y + t.vy * 2.2
        let erel = Math.atan2(hy - this.ego.y, hx - this.ego.x) - this.ego.yaw
        erel = Math.atan2(Math.sin(erel), Math.cos(erel))
        const ex = (0.5 - erel / TWO_PI) * W
        const edist = Math.hypot(hx - this.ego.x, hy - this.ego.y)
        const ey = Math.min(imgH - 3, Math.max(3, elevY((Math.atan2(t.z - this.ego.z, edist) * 180) / Math.PI)))
        if (Math.abs(ex - x) < W / 2 && Math.abs(ex - x) > 3) {
          this.ctx.strokeStyle = 'rgba(244,129,66,0.5)'
          this.ctx.lineWidth = 1
          this.ctx.setLineDash([3, 3])
          this.ctx.beginPath()
          this.ctx.moveTo(x, y)
          this.ctx.lineTo(ex, ey)
          this.ctx.stroke()
          this.ctx.setLineDash([])
          const a = Math.atan2(ey - y, ex - x)
          this.ctx.beginPath()
          this.ctx.moveTo(ex, ey)
          this.ctx.lineTo(ex - Math.cos(a - 0.5) * 4, ey - Math.sin(a - 0.5) * 4)
          this.ctx.moveTo(ex, ey)
          this.ctx.lineTo(ex - Math.cos(a + 0.5) * 4, ey - Math.sin(a + 0.5) * 4)
          this.ctx.stroke()
        }
      }

      const s = 4
      this.ctx.strokeStyle = EXHIBIT
      this.ctx.lineWidth = 1
      this.ctx.beginPath()
      this.ctx.moveTo(x - s, y - s + 2); this.ctx.lineTo(x - s, y - s); this.ctx.lineTo(x - s + 2, y - s)
      this.ctx.moveTo(x + s - 2, y - s); this.ctx.lineTo(x + s, y - s); this.ctx.lineTo(x + s, y - s + 2)
      this.ctx.moveTo(x - s, y + s - 2); this.ctx.lineTo(x - s, y + s); this.ctx.lineTo(x - s + 2, y + s)
      this.ctx.moveTo(x + s - 2, y + s); this.ctx.lineTo(x + s, y + s); this.ctx.lineTo(x + s, y + s - 2)
      this.ctx.stroke()

      const label = String(n)
      const tw = this.ctx.measureText(label).width
      const boxW = tw + 5, boxH = 13
      const candidates: Array<[number, number]> = [
        [x + s + 2, y - 7],
        [x + s + 2, y - 20],
        [x + s + 2, y + 6],
        [x - s - 2 - boxW, y - 7],
        [x - s - 2 - boxW, y - 20],
        [x + s + 2, y - 33],
        [x - s - 2 - boxW, y + 6],
        [x + s + 2, y + 19],
      ]
      let bx = 0, by = 0
      for (const [cx, cy] of candidates) {
        bx = Math.min(W - boxW - 2, Math.max(2, cx))
        by = Math.min(imgH - boxH - 2, Math.max(2, cy))
        const clash = placed.some(([x0, y0, x1, y1]) =>
          bx < x1 + 2 && bx + boxW > x0 - 2 && by < y1 + 2 && by + boxH > y0 - 2)
        if (!clash) break
      }
      placed.push([bx, by, bx + boxW, by + boxH])
      // A hairline leader keeps a displaced tag tied to its reticle.
      const ax = bx > x ? x + s : x - s
      const ay = by + 6.5
      if (Math.abs(ay - y) > 3 || bx < x - s) {
        this.ctx.strokeStyle = 'rgba(244,129,66,0.55)'
        this.ctx.beginPath()
        this.ctx.moveTo(ax, y)
        this.ctx.lineTo(bx > x ? bx - 1 : bx + boxW + 1, ay)
        this.ctx.stroke()
      }
      this.ctx.fillStyle = 'rgba(9,12,14,0.82)'
      this.ctx.fillRect(bx, by, boxW, boxH)
      this.ctx.fillStyle = EXHIBIT
      this.ctx.textAlign = 'left'
      this.ctx.fillText(label, bx + 2, by + 6.5)
    }
    this.ctx.textAlign = 'left'
    this.ctx.textBaseline = 'alphabetic'
  }
}
