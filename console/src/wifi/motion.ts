/**
 * Motion detection from CSI amplitudes, for the simulator and an ESP32 alike.
 *
 * Each packet is divided by its own mean amplitude, which removes the receiver's
 * automatic gain changes. A person moving in the room changes the multipath and
 * makes every subcarrier fluctuate; an empty room leaves only noise. The motion
 * index is the median, over subcarriers, of the one-second coefficient of
 * variation. It is compared with the quietest index seen recently, so the
 * detector calibrates itself to the room and the radio.
 *
 * One link senses that something moved near it. It does not locate or count
 * people; the console says so.
 */

export interface MotionEpisode {
  start: number
  end: number
  peak: number
  open: boolean
}

const WINDOW_S = 1
const ON = 2.6
const OFF = 1.7
const HOLD_ON_S = 0.4
const HOLD_OFF_S = 1.5

export class MotionDetector {
  /** the latest normalised amplitudes, for the waterfall */
  latest = new Float32Array(0)
  index = 0
  floor = 0
  score = 0
  moving = false
  calibrationProgress = 0
  onEpisode: (e: MotionEpisode) => void = () => {}

  private ring: Float32Array[] = []
  private times: number[] = []
  private history: Array<{ t: number; index: number }> = []
  private above = 0
  private below = 0
  private lastT: number | null = null
  private calibrationStart: number | null = null
  private episode: MotionEpisode | null = null
  private used: boolean[] | null = null

  reset(): void {
    this.lastT = this.calibrationStart = null
    this.above = this.below = this.calibrationProgress = 0
    this.latest = new Float32Array(0)
    this.ring = []
    this.times = []
    this.history = []
    this.moving = false
    this.episode = null
    this.used = null
    this.index = this.floor = this.score = 0
  }

  push(t: number, amp: ArrayLike<number>): void {
    if (!Number.isFinite(t) || amp.length < 2 || amp.length > 1024 || Array.from(amp).some(v => !Number.isFinite(v) || v < 0)) return
    // Reconnects and channel-width changes invalidate the old baseline/window.
    if ((this.lastT !== null && (t <= this.lastT || t - this.lastT > .5)) || (this.used && this.used.length !== amp.length)) this.reset()
    if (!Array.from(amp).some(v => v > 0)) return
    this.calibrationStart ??= t
    // Guard and null subcarriers read as zero on real hardware: leave them out.
    if (!this.used || this.used.length !== amp.length) this.used = Array.from(amp, (a) => a > 0)
    else for (let i = 0; i < amp.length; i++) if (amp[i] > 0) this.used[i] = true
    let mean = 0, n = 0
    for (let i = 0; i < amp.length; i++) if (this.used[i]) { mean += amp[i]; n++ }
    mean = n ? mean / n : 1
    const norm = new Float32Array(amp.length)
    for (let i = 0; i < amp.length; i++) norm[i] = this.used[i] ? amp[i] / (mean || 1) : 0
    this.latest = norm

    this.ring.push(norm)
    this.times.push(t)
    while (this.times.length > 2 && t - this.times[0] > WINDOW_S) {
      this.times.shift()
      this.ring.shift()
    }
    const dt = this.lastT !== null ? Math.max(0, t - this.lastT) : 0
    this.lastT = t
    if (this.ring.length < 10) return

    const cv: number[] = []
    for (let k = 0; k < norm.length; k++) {
      if (!this.used[k]) continue
      let s = 0, s2 = 0
      for (const row of this.ring) { s += row[k]; s2 += row[k] * row[k] }
      const m = s / this.ring.length
      const v = Math.max(0, s2 / this.ring.length - m * m)
      cv.push(Math.sqrt(v) / (m || 1))
    }
    cv.sort((a, b) => a - b)
    if (!cv.length) return
    this.index = cv[cv.length >> 1] * 100

    // Quiet floor: the 10th percentile of the last two quiet minutes, never below a small epsilon.
    // Sampled at 10 Hz while the room is quiet, so motion never raises its own floor.
    const last = this.history[this.history.length - 1]
    if (!this.moving && (!last || t - last.t >= 0.1)) this.history.push({ t, index: this.index })
    while (this.history.length > 20 && t - this.history[0].t > 120) this.history.shift()
    const sorted = this.history.map((h) => h.index).sort((a, b) => a - b)
    this.floor = Math.max(0.05, sorted[Math.floor(sorted.length * 0.1)])
    this.score = this.index / this.floor
    this.calibrationProgress = Math.min(1, (t - this.calibrationStart) / 5, this.history.length / 40)
    if (this.calibrationProgress < 1) { this.score = 0; return }

    if (!this.moving) {
      this.above = this.score > ON ? this.above + dt : 0
      if (this.above >= HOLD_ON_S && this.history.length >= 20) {
        this.moving = true
        this.below = 0
        this.episode = { start: t - this.above, end: t, peak: this.score, open: true }
        this.onEpisode(this.episode)
      }
    } else if (this.episode) {
      this.episode.end = t
      this.episode.peak = Math.max(this.episode.peak, this.score)
      this.below = this.score < OFF ? this.below + dt : 0
      if (this.below >= HOLD_OFF_S) {
        this.moving = false
        this.episode.open = false
        this.episode.end = t - this.below
        this.onEpisode(this.episode)
        this.episode = null
      } else this.onEpisode(this.episode)
    }
  }
}
