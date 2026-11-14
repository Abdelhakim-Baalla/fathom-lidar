/**
 * Interface sounds, synthesised so there is nothing to download. Off until the
 * operator switches them on. Each cue tells the microphone detector to look away
 * for a moment, so the console never logs its own sounds as evidence.
 */
export type Cue = 'exhibit' | 'sound' | 'motion' | 'seal' | 'record'

export class Cues {
  enabled = false
  /** called with the time until which the microphone should ignore input, in seconds of performance.now */
  onPlay: (untilSeconds: number) => void = () => {}
  private ctx: AudioContext | null = null
  private last = new Map<Cue, number>()

  setEnabled(on: boolean): void {
    this.enabled = on
    if (on && !this.ctx) this.ctx = new AudioContext()
    if (on) this.ctx?.resume()
  }

  play(cue: Cue): void {
    if (!this.enabled || !this.ctx) return
    const now = performance.now()
    // A busy street confirms many objects at once; one cue per kind per 400 ms is enough.
    if (now - (this.last.get(cue) ?? 0) < 400) return
    this.last.set(cue, now)
    const t = this.ctx.currentTime + 0.01
    if (cue === 'exhibit') { this.tone(1046, t, 0.05, 0.05); this.tone(1568, t + 0.06, 0.07, 0.04) }
    else if (cue === 'sound') { this.tone(740, t, 0.09, 0.05) }
    else if (cue === 'motion') { this.tone(587, t, 0.08, 0.05); this.tone(440, t + 0.09, 0.12, 0.045) }
    else if (cue === 'record') { this.tone(880, t, 0.04, 0.05) }
    else if (cue === 'seal') { this.thump(t); this.tone(1318, t + 0.05, 0.12, 0.035) }
    this.onPlay(now / 1000 + 0.35)
  }

  private tone(freq: number, t: number, dur: number, gain: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = freq
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.006)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(ctx.destination)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  /** a short low knock, like a stamp landing */
  private thump(t: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(160, t)
    o.frequency.exponentialRampToValueAtTime(60, t + 0.12)
    g.gain.setValueAtTime(0.12, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
    o.connect(g).connect(ctx.destination)
    o.start(t)
    o.stop(t + 0.2)
  }
}
