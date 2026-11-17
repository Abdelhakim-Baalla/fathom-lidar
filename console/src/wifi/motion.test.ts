import { describe, expect, it } from 'vitest'
import { WifiSim } from './csi'
import { MotionDetector } from './motion'

function run(people: number, seconds: number, warmup = 0) {
  const sim = new WifiSim()
  sim.configure({ people: 0, snrDb: 38 })
  const det = new MotionDetector()
  const episodes: number[] = []
  det.onEpisode = (e) => { if (e.open && !episodes.includes(e.start)) episodes.push(e.start) }
  for (let i = 0; i < warmup * 100; i++) { const p = sim.step(0.01); det.push(p.t, p.amp) }
  sim.configure({ people, snrDb: 38 })
  for (let i = 0; i < seconds * 100; i++) { const p = sim.step(0.01); det.push(p.t, p.amp) }
  return { det, episodes }
}

describe('Wi-Fi motion', () => {
  it('stays quiet in an empty room', () => {
    expect(run(0, 30).episodes.length).toBe(0)
  })
  it('detects a person walking in', () => {
    const { episodes } = run(1, 20, 10)
    expect(episodes.length).toBeGreaterThan(0)
  })
  it('produces 56 subcarriers', () => {
    expect(new WifiSim().step(0.01).amp.length).toBe(56)
  })
})

it('calibrates before emitting events and resets the baseline after a packet gap', () => {
  const det = new MotionDetector()
  for (let i = 0; i < 600; i++) det.push(i / 100, [12, 18, 22, 16])
  expect(det.calibrationProgress).toBe(1)
  det.push(7, [12, 18, 22, 16])
  expect(det.calibrationProgress).toBe(0)
  expect(det.moving).toBe(false)
  expect(det.score).toBe(0)
})

it('handles channel width changes and rejects unusable packets without NaN scores', () => {
  const det = new MotionDetector()
  for (let i = 0; i < 600; i++) det.push(i / 100, [12, 18, 22, 16])
  for (let i = 600; i < 610; i++) det.push(i / 100, [10, 20])
  expect(det.latest.length).toBe(2)
  expect(det.calibrationProgress).toBeLessThan(1)
  det.push(6.1, [0, 0])
  det.push(6.2, [NaN, 1])
  det.push(6.3, [-1, 2])
  expect(Number.isFinite(det.score)).toBe(true)
  expect(Number.isFinite(det.index)).toBe(true)
})
