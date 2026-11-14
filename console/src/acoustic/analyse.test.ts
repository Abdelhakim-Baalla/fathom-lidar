import { describe, expect, it } from 'vitest'
import { Rng } from '../sim/rng'
import { SoundAnalyser, type SoundEvent } from './analyse'

const RATE = 48000, N = 2048, HOP = 800 // 60 blocks per second

/** Feed a mono or stereo signal through the analyser in overlapping blocks. */
function run(signal: (t: number) => [number, number], seconds: number, stereo = false) {
  const a = new SoundAnalyser()
  const events = new Map<number, SoundEvent>()
  a.onEvent = (e) => events.set(e.id, { ...e })
  const total = Math.floor(seconds * RATE)
  const L = new Float32Array(total), R = new Float32Array(total)
  for (let i = 0; i < total; i++) [L[i], R[i]] = signal(i / RATE)
  for (let end = N; end <= total; end += HOP) {
    a.process({ t: end / RATE, left: L.slice(end - N, end), right: stereo ? R.slice(end - N, end) : null, sampleRate: RATE })
  }
  return [...events.values()].filter((e) => !e.open)
}

const rng = new Rng(3)
const hiss = () => rng.gauss() * 0.0005

describe('sound events', () => {
  it('finds nothing in room noise', () => {
    expect(run(() => { const v = hiss(); return [v, v] }, 3)).toHaveLength(0)
  })

  it('calls a short bright burst a clap', () => {
    const ev = run((t) => {
      const v = hiss() + (t > 1.5 && t < 1.53 ? rng.gauss() * 0.4 * Math.exp(-(t - 1.5) * 80) : 0)
      return [v, v]
    }, 3)
    expect(ev).toHaveLength(1)
    expect(ev[0].cls).toBe('Clap or knock')
  })

  it('calls a harmonic tone with a pitch voice', () => {
    const ev = run((t) => {
      let v = hiss()
      if (t > 1 && t < 1.8) for (let h = 1; h <= 8; h++) v += (0.05 / h) * Math.sin(2 * Math.PI * 140 * h * t)
      return [v, v]
    }, 3)
    expect(ev.length).toBeGreaterThan(0)
    expect(ev[0].cls).toBe('Voice')
    expect(ev[0].pitchHz).toBeGreaterThan(120)
    expect(ev[0].pitchHz).toBeLessThan(160)
  })

  it('reads a bearing from the delay between two microphones', () => {
    const delay = 10 / RATE // the right microphone hears it 10 samples later
    const burst = new Float32Array(RATE * 3)
    for (let i = 0; i < burst.length; i++) {
      const t = i / RATE
      burst[i] = t > 1.5 && t < 1.53 ? rng.gauss() * 0.4 : 0
    }
    const at = (t: number) => burst[Math.max(0, Math.floor(t * RATE))] ?? 0
    const ev = run((t) => [at(t) + hiss(), at(t - delay) + hiss()], 3, true)
    expect(ev[0].bearing).not.toBeNull()
    // 10 samples at 48 kHz over 10 cm: asin(0.0714 / 0.1) ≈ 46° to the left
    expect(ev[0].bearing!).toBeLessThan(-35)
    expect(ev[0].bearing!).toBeGreaterThan(-55)
  })

  it('reports no bearing for a mono input', () => {
    const ev = run((t) => { const v = hiss() + (t > 1.5 && t < 1.53 ? 0.3 : 0); return [v, v] }, 3, true)
    expect(ev[0].bearing).toBeNull()
  })
})
