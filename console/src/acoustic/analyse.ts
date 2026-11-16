import { fft, gccPhat, hann } from './fft'

/**
 * Sound event detection on short overlapping blocks from a microphone.
 *
 * An event opens when the level jumps well above the room's noise floor and the
 * spectrum changes (spectral flux), and closes when the level falls back. Each
 * event is described by its duration, peak level, spectral centroid, flatness and
 * how much of it was voiced (a clear pitch between 80 and 400 Hz). The class is a
 * rule on those features, so the console always calls it "likely".
 *
 * Levels are dBFS: relative to the converter's full scale, not sound pressure.
 * A browser microphone is uncalibrated.
 */

export type SoundClass = 'Clap or knock' | 'Thud' | 'Footsteps' | 'Voice' | 'Metallic ring' | 'Sustained sound'

export interface SoundEvent {
  id: number
  start: number
  end: number
  open: boolean
  cls: SoundClass
  peakDb: number
  centroidHz: number
  flatness: number
  voicedShare: number
  pitchHz: number | null
  /** degrees, negative to the left of the microphone pair, null when the input is mono */
  bearing: number | null
  /** impulses merged into one footstep exhibit */
  count: number
  /** how far the peak rose above the noise floor, dB: the detection's margin */
  overFloorDb: number
}

export interface Block {
  t: number
  left: Float32Array
  right: Float32Array | null
  sampleRate: number
}

const OPEN_DB = 12
const HOLD_DB = 6
const CLOSE_TICKS = 4
const SPEED_OF_SOUND = 343

export class SoundAnalyser {
  /** latest magnitude spectrum in dBFS, bins of sampleRate / blockLength */
  spectrum = new Float32Array(0)
  levelDb = -120
  floorDb = -70
  stereo = false
  /** microphone spacing in metres, for the bearing */
  spacing = 0.1
  /** blocks before this time are ignored, so the console's own cues are not detected */
  muteUntil = 0
  onEvent: (e: SoundEvent) => void = () => {}

  private prevMag: Float64Array | null = null
  private event: (SoundEvent & { cSum: number; fSum: number; voiced: number; ticks: number; pSum: number }) | null = null
  private quiet = 0
  private nextId = 1
  private impulses: Array<{ t: number; centroid: number }> = []
  private steps: SoundEvent | null = null
  private prevDb = -120

  process(b: Block): void {
    const n = b.left.length
    const w = hann(n)
    const re = new Float64Array(n), im = new Float64Array(n)
    let sq = 0
    for (let i = 0; i < n; i++) {
      sq += b.left[i] * b.left[i]
      re[i] = b.left[i] * w[i]
    }
    const db = 10 * Math.log10(sq / n + 1e-14)
    this.levelDb = db
    fft(re, im)
    const bins = n / 2
    const mag = new Float64Array(bins)
    if (this.spectrum.length !== bins) this.spectrum = new Float32Array(bins)
    const norm = 2 / (n * 0.5) // Hann coherent gain
    let flux = 0, total = 0, cNum = 0, logSum = 0, linSum = 0, used = 0
    const hz = b.sampleRate / n
    const top = Math.min(bins, Math.floor(10000 / hz))
    for (let k = 1; k < bins; k++) {
      const m = Math.hypot(re[k], im[k]) * norm
      mag[k] = m
      this.spectrum[k] = 20 * Math.log10(m + 1e-9)
      if (this.prevMag) flux += Math.max(0, m - this.prevMag[k])
      total += m
      cNum += m * k * hz
      if (k >= 2 && k < top) {
        logSum += Math.log(m + 1e-12)
        linSum += m
        used++
      }
    }
    this.prevMag = mag
    const centroid = total > 0 ? cNum / total : 0
    const flatness = used && linSum > 0 ? Math.exp(logSum / used) / (linSum / used) : 1
    const relFlux = total > 0 ? flux / total : 0

    // Noise floor follows quiet passages down quickly and rises slowly.
    if (!this.event) this.floorDb = db < this.floorDb ? db : this.floorDb + 0.015
    this.stereo = !!b.right && !sameSignal(b.left, b.right)

    if (b.t < this.muteUntil) {
      this.prevDb = db
      return
    }

    if (!this.event) {
      const jump = db - this.prevDb
      if (db > this.floorDb + OPEN_DB && (relFlux > 0.3 || jump > 6)) {
        this.event = {
          id: this.nextId++, start: b.t, end: b.t, open: true, cls: 'Sustained sound',
          peakDb: db, centroidHz: centroid, flatness, voicedShare: 0, pitchHz: null,
          bearing: this.bearing(b), count: 1, overFloorDb: db - this.floorDb,
          cSum: 0, fSum: 0, voiced: 0, ticks: 0, pSum: 0,
        }
        this.quiet = 0
      }
    }
    const e = this.event
    if (e) {
      e.end = b.t
      e.peakDb = Math.max(e.peakDb, db)
      e.overFloorDb = Math.max(e.overFloorDb, db - this.floorDb)
      e.ticks++
      e.cSum += centroid
      e.fSum += flatness
      const p = pitch(b.left, b.sampleRate)
      if (p) { e.voiced++; e.pSum += p }
      e.centroidHz = e.cSum / e.ticks
      e.flatness = e.fSum / e.ticks
      e.voicedShare = e.voiced / e.ticks
      e.pitchHz = e.voiced ? e.pSum / e.voiced : null
      this.quiet = db < this.floorDb + HOLD_DB ? this.quiet + 1 : 0
      if (this.quiet >= CLOSE_TICKS || b.t - e.start > 8) this.close(e)
    }
    this.prevDb = db
  }

  private close(e: NonNullable<SoundAnalyser['event']>): void {
    this.event = null
    e.open = false
    e.cls = classify(e)
    const out: SoundEvent = {
      id: e.id, start: e.start, end: e.end, open: false, cls: e.cls, peakDb: e.peakDb,
      centroidHz: e.centroidHz, flatness: e.flatness, voicedShare: e.voicedShare,
      pitchHz: e.pitchHz, bearing: e.bearing, count: 1, overFloorDb: e.overFloorDb,
    }
    // Footsteps: low impulses in a walking rhythm merge into one event.
    if (out.cls === 'Thud' || out.cls === 'Clap or knock') {
      const last = this.impulses[this.impulses.length - 1]
      this.impulses.push({ t: e.start, centroid: e.centroidHz })
      if (this.impulses.length > 4) this.impulses.shift()
      const gap = last ? e.start - last.t : Infinity
      if (gap > 0.3 && gap < 1.1 && e.centroidHz < 2500) {
        if (this.steps && e.start - this.steps.end < 1.2) {
          this.steps.end = e.end
          this.steps.count++
          this.steps.peakDb = Math.max(this.steps.peakDb, e.peakDb)
          this.onEvent(this.steps)
          return
        }
        if (this.impulses.length >= 3) {
          const first = this.impulses[this.impulses.length - 3]
          this.steps = { ...out, start: first.t, cls: 'Footsteps', count: 3 }
          this.onEvent(this.steps)
          return
        }
      }
    }
    this.onEvent(out)
  }

  private bearing(b: Block): number | null {
    if (!b.right || !this.stereo) return null
    const maxLag = Math.ceil((this.spacing / SPEED_OF_SOUND) * b.sampleRate)
    const { lag, strength } = gccPhat(b.left, b.right, maxLag)
    if (strength < 3) return null
    const s = Math.max(-1, Math.min(1, (lag / b.sampleRate) * SPEED_OF_SOUND / this.spacing))
    // R later than L: the source is on the left.
    return -(Math.asin(s) * 180) / Math.PI
  }
}

export function classify(e: Pick<SoundEvent, 'start' | 'end' | 'centroidHz' | 'flatness' | 'voicedShare'>): SoundClass {
  const dur = e.end - e.start
  if (e.voicedShare > 0.4 && dur >= 0.2) return 'Voice'
  if (e.centroidHz > 3000 && e.flatness < 0.25 && dur >= 0.12) return 'Metallic ring'
  if (dur < 0.3) return e.centroidHz > 1200 ? 'Clap or knock' : 'Thud'
  return 'Sustained sound'
}

/** Pitch by normalised autocorrelation in the voice range, or null when unvoiced. */
export function pitch(input: Float32Array, sampleRate: number): number | null {
  // Halve the rate first: the voice range does not need it and the search gets 4× cheaper.
  const n = Math.min(input.length >> 1, 1024)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = (input[2 * i] + input[2 * i + 1]) / 2
  const rate = sampleRate / 2
  const minLag = Math.floor(rate / 400), maxLag = Math.ceil(rate / 80)
  if (maxLag * 2 > n) return null
  let e0 = 0
  for (let i = 0; i < n - maxLag; i++) e0 += x[i] * x[i]
  if (e0 < 1e-8) return null
  let best = 0, bestLag = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0, e1 = 0
    for (let i = 0; i < n - maxLag; i++) {
      r += x[i] * x[i + lag]
      e1 += x[i + lag] * x[i + lag]
    }
    const c = r / Math.sqrt(e0 * e1 + 1e-12)
    if (c > best) { best = c; bestLag = lag }
  }
  return best > 0.75 ? rate / bestLag : null
}

function sameSignal(a: Float32Array, b: Float32Array): boolean {
  let d = 0, e = 0
  for (let i = 0; i < a.length; i += 4) {
    d += Math.abs(a[i] - b[i])
    e += Math.abs(a[i])
  }
  return d <= e * 1e-3
}
