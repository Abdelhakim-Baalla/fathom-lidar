/** Layered CC0 samples and original instrument cues. Never detected-object recordings. */
export type Cue = 'exhibit' | 'sound' | 'motion' | 'seal' | 'record' | 'connect' | 'disconnect' | 'alert' | 'scan'
export type CustomCue = 'intro' | 'scan' | 'alert'
export const INTRO_SECONDS = 6.4

export class Cues {
  enabled = false
  volume = 0.35
  onPlay: (untilSeconds: number) => void = () => {}
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private last = new Map<Cue, number>()
  private samples = new Map<string, AudioBuffer>()
  private voices = new Set<AudioScheduledSourceNode>()
  private loading: Promise<void> | null = null
  private sequenceUntil = 0
  private suppressUntil = 0
  readonly customNames: Partial<Record<CustomCue, string>> = {}

  setEnabled(on: boolean): void {
    this.enabled = on
    if (on && !this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      const limiter = this.ctx.createDynamicsCompressor()
      limiter.threshold.value = -15
      limiter.knee.value = 12
      limiter.ratio.value = 10
      this.master.connect(limiter).connect(this.ctx.destination)
      this.loading = this.loadSamples()
    }
    if (this.ctx && this.master) {
      if (!on) this.stopSequence()
      this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.02)
      if (on) void this.ctx.resume().catch(() => {})
    }
  }

  async prepare(): Promise<void> {
    this.setEnabled(true)
    await this.ctx!.resume()
    await this.loading
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value))
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.02)
  }

  /** Local, in-memory override for a user's own/licensed soundtrack. No upload. */
  async importSound(slot: CustomCue, file: File): Promise<void> {
    if (file.size > 24 * 1024 * 1024) throw new Error('Choose an audio file smaller than 24 MB.')
    await this.prepare()
    const buffer = await this.ctx!.decodeAudioData(await file.arrayBuffer())
    if (buffer.duration < .05) throw new Error('Choose a clip at least 0.05 seconds long.')
    if (buffer.duration > 120) throw new Error('Choose a clip shorter than two minutes.')
    this.samples.set(`custom-${slot}`, buffer)
    this.customNames[slot] = file.name
  }

  clearSound(slot: CustomCue): void { this.samples.delete(`custom-${slot}`); delete this.customNames[slot] }

  play(cue: Cue, pan = 0): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return
    const now = performance.now()
    if (this.ctx.currentTime < this.sequenceUntil || now - (this.last.get(cue) ?? -Infinity) < (cue === 'alert' ? 2000 : 650) || this.voices.size > 24) return
    this.last.set(cue, now)
    const t = this.ctx.currentTime + 0.015
    const duration = cue === 'alert' ? 1.65 : cue === 'scan' ? 1.55 : 0.7
    if (this.samples.has(`custom-${cue}`)) this.sample(`custom-${cue}`, t, .6, duration, pan)
    else if (cue === 'scan') {
      this.sample('scan', t, .38, 1.53, pan)
      this.noise(t, .45, 420, 2300, .08, pan)
    } else if (cue === 'alert') {
      // Deliberate RWR-inspired cadence. Not a recording of an aircraft warning.
      for (let i = 0; i < 6; i++) {
        this.tone(i % 2 ? 750 : 1000, i % 2 ? 750 : 1000, t + i * .24, .12, .12, 0, 'square')
        this.noise(t + i * .24, .025, 1800, 1800, .08, 0)
      }
    } else if (cue === 'motion') {
      this.sample('radar', t, .22, .7, pan)
      this.tone(165, 155, t, .18, .12, pan)
      this.tone(165, 155, t + .22, .18, .08, pan)
    } else if (cue === 'seal') {
      this.noise(t, .11, 1600, 180, .25, 0)
      this.tone(105, 42, t, .55, .38, 0)
      this.tone(320, 320, t + .13, .12, .045, 0, 'triangle')
    } else if (cue === 'disconnect') {
      this.noise(t, .2, 1200, 160, .16, 0)
      this.tone(180, 65, t, .24, .18, 0)
    } else {
      this.noise(t, .04, 2200, 600, .16, pan)
      const frequency = cue === 'exhibit' ? 480 : cue === 'sound' ? 380 : cue === 'record' ? 220 : 290
      this.tone(frequency, frequency * .97, t + .025, .12, .1, pan, 'triangle')
      if (cue === 'connect') this.noise(t + .13, .04, 1200, 600, .08, pan)
    }
    this.suppressUntil = Math.max(this.suppressUntil, now / 1000 + duration + .1)
    this.onPlay(this.suppressUntil)
  }

  private async loadSamples(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    await Promise.all(['scan', 'radar'].map(async name => {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}audio/${name}.mp3`, { signal: AbortSignal.timeout(2500) })
        if (response.ok) {
          const decoded = await ctx.decodeAudioData(await response.arrayBuffer())
          if (this.ctx === ctx) this.samples.set(name, decoded)
        }
      } catch { /* Procedural layers remain available offline. */ }
    }))
  }

  private sample(name: string, t: number, level: number, duration: number, pan = 0): void {
    const buffer = this.samples.get(name)
    if (!buffer || !this.ctx) return
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    this.route(source, t, Math.min(duration, buffer.duration), level, pan, true)
  }

  intro(): void {
    this.stopSequence()
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return
    const t = this.ctx.currentTime + .025
    this.sequenceUntil = t + INTRO_SECONDS
    this.suppressUntil = performance.now() / 1000 + INTRO_SECONDS + .15
    this.onPlay(this.suppressUntil)
    if (this.samples.has('custom-intro')) {
      this.sample('custom-intro', t, .65, INTRO_SECONDS)
      return
    }
    this.tone(68, 38, t, 2.6, .28, 0)
    this.noise(t, 1.1, 100, 900, .16, -.5)
    this.sample('scan', t + .25, .44, 1.53, -.35)
    this.sample('radar', t + 1.25, .27, 2.7, .2)
    for (let i = 0; i < 11; i++) this.noise(t + 1.6 + i * .105, .025, 1500 + i * 140, 800, .1, i % 2 ? .35 : -.35)
    this.sample('scan', t + 2.75, .32, 1.53, .4)
    this.noise(t + 3.55, .7, 1800, 120, .2, 0)
    this.tone(110, 36, t + 3.55, 1.25, .36, 0)
    this.noise(t + 4.5, .055, 2200, 400, .18, 0)
    this.tone(240, 235, t + 4.55, .16, .075, 0, 'triangle')
    this.noise(t + 4.8, 1.25, 700, 70, .07, 0)
  }

  stopSequence(): void {
    this.sequenceUntil = 0
    this.suppressUntil = performance.now() / 1000 + .05
    this.onPlay(this.suppressUntil)
    for (const voice of this.voices) { try { voice.stop() } catch { /* already ended */ } }
    this.voices.clear()
  }

  private route(source: AudioScheduledSourceNode & AudioNode, t: number, duration: number, level: number, pan: number, sustain = false, filter?: BiquadFilterNode): void {
    const ctx = this.ctx!, gain = ctx.createGain(), stereo = ctx.createStereoPanner()
    stereo.pan.value = Math.min(1, Math.max(-1, pan))
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(level, t + Math.min(.012, duration / 4))
    if (sustain) gain.gain.setValueAtTime(level, t + Math.max(.012, duration - .08))
    gain.gain.exponentialRampToValueAtTime(.0001, t + duration)
    if (filter) source.connect(filter).connect(gain)
    else source.connect(gain)
    gain.connect(stereo).connect(this.master!)
    this.voices.add(source)
    source.onended = () => { source.disconnect(); filter?.disconnect(); gain.disconnect(); stereo.disconnect(); this.voices.delete(source) }
    source.start(t)
    source.stop(t + duration + .02)
  }

  private tone(from: number, to: number, t: number, duration: number, level: number, pan: number, type: OscillatorType = 'sine'): void {
    const source = this.ctx!.createOscillator()
    source.type = type
    source.frequency.setValueAtTime(from, t)
    source.frequency.exponentialRampToValueAtTime(to, t + duration)
    // Limit the harsh harmonics of alert pulses.
    const filter = this.ctx!.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = type === 'square' ? 2200 : 4000
    this.route(source, t, duration, level, pan, false, filter)
  }

  private noise(t: number, duration: number, from: number, to: number, level: number, pan: number): void {
    const ctx = this.ctx!, buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate)
    const samples = buffer.getChannelData(0)
    let seed = 17
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0
      samples[i] = seed / 2147483648
    }
    const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter()
    source.buffer = buffer
    filter.type = 'bandpass'
    filter.Q.value = 1.4
    filter.frequency.setValueAtTime(from, t)
    filter.frequency.exponentialRampToValueAtTime(to, t + duration)
    this.route(source, t, duration, level, pan, false, filter)
  }

  dispose(): void {
    this.stopSequence()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
    this.loading = null
    this.samples.clear()
    for (const slot of Object.keys(this.customNames) as CustomCue[]) delete this.customNames[slot]
    this.last.clear()
  }
}
