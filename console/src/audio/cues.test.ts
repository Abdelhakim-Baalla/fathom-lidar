import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Cues } from './cues'

const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; buffer?: AudioBuffer }> = []
const parameter = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() })
const node = () => {
  const n = { connect: vi.fn(), disconnect: vi.fn(), gain: parameter(), pan: parameter(), frequency: parameter(), Q: parameter(), threshold: parameter(), knee: parameter(), ratio: parameter() }
  n.connect.mockReturnValue(n)
  return n
}
let decodedDuration = 1.53
class Context {
  currentTime = 10
  sampleRate = 8000
  state = 'running'
  destination = node()
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createGain = node
  createDynamicsCompressor = node
  createStereoPanner = node
  createBiquadFilter = node
  decodeAudioData = vi.fn(async () => ({ duration: decodedDuration }) as AudioBuffer)
  createBuffer = (_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) })
  createBufferSource() { const source = { ...node(), start: vi.fn(), stop: vi.fn(), buffer: undefined }; sources.push(source); return source }
  createOscillator = this.createBufferSource
}
let cues: Cues
beforeEach(() => {
  sources.length = 0
  decodedDuration = 1.53
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })))
  cues = new Cues()
})
afterEach(() => { cues.dispose(); vi.unstubAllGlobals() })

describe('audio playback lifecycle', () => {
  it('does not fetch or play before a user enables audio', () => {
    cues.play('scan'); cues.intro()
    expect(fetch).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
  })
  it('loads real samples and protects the entire intro from detector feedback and other cues', async () => {
    await cues.prepare()
    const mute = vi.fn(); cues.onPlay = mute
    cues.intro()
    const scheduled = sources.length
    expect(scheduled).toBeGreaterThan(10)
    expect(sources.some(source => source.buffer?.duration === 1.53)).toBe(true)
    expect(mute.mock.lastCall![0]).toBeGreaterThan(performance.now() / 1000 + 6)
    cues.play('exhibit')
    expect(sources).toHaveLength(scheduled)
  })
  it('muting cancels even future intro sources, with no delayed replay after re-enabling', async () => {
    await cues.prepare(); cues.intro()
    const scheduled = sources.length
    cues.setEnabled(false)
    expect(sources.every(source => source.stop.mock.calls.length === 2)).toBe(true)
    cues.setEnabled(true)
    expect(sources).toHaveLength(scheduled)
  })
  it('uses a local licensed clip without layering the default intro over it', async () => {
    decodedDuration = 51
    await cues.importSound('intro', new File(['audio'], 'hud.wav'))
    cues.intro()
    expect(sources).toHaveLength(1)
    expect(sources[0].stop.mock.calls[0][0] - sources[0].start.mock.calls[0][0]).toBeCloseTo(6.42)
    expect(cues.customNames.intro).toBe('hud.wav')
    cues.clearSound('intro')
    expect(cues.customNames.intro).toBeUndefined()
  })
  it('a short overlapping cue does not expose a longer scan to the microphone detector', async () => {
    await cues.prepare()
    const mute = vi.fn(); cues.onPlay = mute
    cues.play('scan')
    const scanEnd = mute.mock.lastCall![0]
    cues.play('record')
    expect(mute.mock.lastCall![0]).toBeGreaterThanOrEqual(scanEnd)
  })
  it('rejects oversized imports before decoding or enabling audio', async () => {
    const file = { size: 25 * 1024 * 1024 } as File
    await expect(cues.importSound('alert', file)).rejects.toThrow('24 MB')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('still produces a finite warning when sample downloads fail', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    await cues.prepare(); cues.play('alert')
    expect(sources).toHaveLength(12)
    expect(sources.every(source => source.stop.mock.calls[0][0] < 12)).toBe(true)
    const count = sources.length
    cues.play('alert')
    expect(sources).toHaveLength(count)
  })
  it('keeps disabled event cues silent while other event cues still play', async () => {
    await cues.prepare()
    cues.muted.add('motion')
    cues.play('motion')
    expect(sources).toHaveLength(0)
    cues.play('exhibit')
    expect(sources.length).toBeGreaterThan(0)
  })

})
