import { SoundAnalyser, type SoundEvent } from './analyse'

export type MicState = 'off' | 'asking' | 'on' | 'denied' | 'unavailable'

const BLOCK = 2048

/**
 * The microphone, read in overlapping 2048-sample blocks on every animation frame.
 * Browser echo cancellation, noise suppression and gain control are switched off:
 * they would erase exactly the transients the detector looks for.
 */
export class Listener {
  readonly analyser = new SoundAnalyser()
  state: MicState = 'off'
  message = ''
  deviceLabel = ''
  channels = 0
  onChange: () => void = () => {}
  onEvent: (e: SoundEvent) => void = () => {}
  onBlock: () => void = () => {}

  private generation = 0
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private nodes: AnalyserNode[] = []
  private raf = 0
  private bufL = new Float32Array(BLOCK)
  private bufR = new Float32Array(BLOCK)

  constructor() {
    this.analyser.onEvent = (e) => this.onEvent(e)
  }

  /** session clock shared with the rest of the console, seconds */
  clock: () => number = () => performance.now() / 1000

  async start(): Promise<void> {
    if (this.state === 'on' || this.state === 'asking') return
    if (!navigator.mediaDevices?.getUserMedia) {
      this.set('unavailable', 'This browser gives no microphone access here. It needs HTTPS or localhost.')
      return
    }
    const generation = ++this.generation
    this.set('asking', '')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
      })
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
    } catch (err) {
      if (generation !== this.generation) return
      const name = (err as DOMException).name
      this.set(name === 'NotAllowedError' ? 'denied' : 'unavailable',
        name === 'NotAllowedError' ? 'Microphone permission was refused. Allow it in the address bar and try again.'
        : name === 'NotFoundError' ? 'No microphone was found.' : `The microphone could not start (${name}).`)
      return
    }
    try {
      const track = this.stream.getAudioTracks()[0]
      track.addEventListener('ended', () => { if (generation === this.generation) this.stop() }, { once: true })
      this.deviceLabel = track.label || 'Microphone'
      this.channels = track.getSettings().channelCount ?? 1
      this.ctx = new AudioContext()
      await this.ctx.resume()
      if (generation !== this.generation) return
      const src = this.ctx.createMediaStreamSource(this.stream)
      const split = this.ctx.createChannelSplitter(2)
      src.connect(split)
      this.nodes = [0, 1].map((ch) => {
        const a = this.ctx!.createAnalyser()
        a.fftSize = BLOCK
        a.smoothingTimeConstant = 0
        split.connect(a, ch)
        return a
      })
      this.set('on', '')
      const loop = () => {
        this.raf = requestAnimationFrame(loop)
        this.nodes[0].getFloatTimeDomainData(this.bufL)
        const stereo = this.channels >= 2
        if (stereo) this.nodes[1].getFloatTimeDomainData(this.bufR)
        this.analyser.process({ t: this.clock(), left: this.bufL, right: stereo ? this.bufR : null, sampleRate: this.ctx!.sampleRate })
        this.onBlock()
      }
      loop()
    } catch {
      if (generation !== this.generation) return
      this.stop()
      this.set('unavailable', 'Audio processing could not start. Try another browser or input device.')
    }
  }

  stop(): void {
    this.generation++
    cancelAnimationFrame(this.raf)
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.stream = null
    this.set('off', '')
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000
  }

  private set(state: MicState, message: string): void {
    this.state = state
    this.message = message
    this.onChange()
  }
}
