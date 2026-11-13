import { describe, expect, it } from 'vitest'
import { decodeFrame, FLAG_SIMULATED } from '../protocol/frame'
import { CLASS, loopPose, LOOP_LENGTH } from './scene'
import { DEFAULT_ENVIRONMENT, PRESETS } from './sensor'
import { Simulator } from './simulator'

const sensor = PRESETS[1].config

describe('ego loop', () => {
  it('closes on itself and keeps a continuous heading', () => {
    const a = loopPose(0, { x: 0, y: 0, yaw: 0 })
    const b = loopPose(LOOP_LENGTH - 1e-6, { x: 0, y: 0, yaw: 0 })
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-3)
    let prev = loopPose(0, { x: 0, y: 0, yaw: 0 })
    for (let s = 0.5; s < LOOP_LENGTH; s += 0.5) {
      const p = loopPose(s, { x: 0, y: 0, yaw: 0 })
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThan(0.51)
      expect(Math.abs(p.yaw - prev.yaw)).toBeLessThan(0.1)
      prev = { ...p }
    }
  })
})

describe('simulator', () => {
  it('fires the configured number of rays and encodes valid frames', () => {
    const sim = new Simulator(sensor, DEFAULT_ENVIRONMENT)
    const p = sim.step(0.1)
    expect(p.rays).toBe(sensor.channels * 1800)
    expect(p.revolutionEnded || sim.step(0.01).revolutionEnded).toBe(true)
    const f = decodeFrame(p.frame)
    expect(f.flags & FLAG_SIMULATED).toBe(FLAG_SIMULATED)
    expect(f.pointCount).toBe(p.pointCount)
    expect(p.pointCount).toBeGreaterThan(p.rays * 0.3)
    expect(p.pointCount).toBeLessThan(p.rays)
  })

  it('keeps every return inside the instrumented range and above the road', () => {
    const sim = new Simulator(sensor, DEFAULT_ENVIRONMENT)
    const f = decodeFrame(sim.step(0.1).frame)
    for (let i = 0; i < f.pointCount; i++) {
      const x = f.f32[i * 4], y = f.f32[i * 4 + 1], z = f.f32[i * 4 + 2]
      const r = Math.hypot(x, y, z)
      expect(r).toBeGreaterThan(sensor.minRange - 0.2)
      expect(r).toBeLessThan(sensor.maxRange + 0.2)
      expect(z).toBeGreaterThan(-sensor.mountHeight - 0.2)
    }
  })

  it('sees ground, buildings, vegetation and vehicles in one revolution', () => {
    const sim = new Simulator(PRESETS[2].config, DEFAULT_ENVIRONMENT)
    const seen = new Set(sim.step(0.1).truth)
    for (const c of [CLASS.ground, CLASS.building, CLASS.vegetation, CLASS.car]) {
      expect(seen.has(c)).toBe(true)
    }
    expect(seen.has(CLASS.weather)).toBe(false)
  })

  it('loses returns in fog and gains droplet returns', () => {
    const clear = new Simulator(sensor, DEFAULT_ENVIRONMENT).step(0.1)
    const fog = new Simulator(sensor, { ...DEFAULT_ENVIRONMENT, weather: 'fog' }).step(0.1)
    const drops = fog.truth.reduce((n, c) => n + (c === CLASS.weather ? 1 : 0), 0)
    expect(drops).toBeGreaterThan(500)
    expect(fog.pointCount - drops).toBeLessThan(clear.pointCount)
  })
})
