import { describe, expect, it } from 'vitest'
import { CLASS } from '../sim/scene'
import { DEFAULT_ENVIRONMENT, PRESETS } from '../sim/sensor'
import { Simulator } from '../sim/simulator'
import { classify, detect, fitRectangle } from './detect'
import { Tracker } from './track'

/** Points on the two visible faces of a box standing on a sampled ground patch. */
function boxScene(cx: number, cy: number, l: number, w: number, h: number, yaw: number): Float32Array {
  const pts: number[] = []
  for (let x = cx - 8; x <= cx + 8; x += 0.5) for (let y = cy - 8; y <= cy + 8; y += 0.5) pts.push(x, y, 0)
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const put = (u: number, v: number, z: number) => pts.push(cx + u * c - v * s, cy + u * s + v * c, z)
  for (let z = 0.35; z <= h; z += 0.15) {
    for (let u = -l / 2; u <= l / 2; u += 0.1) put(u, -w / 2, z)
    for (let v = -w / 2; v <= w / 2; v += 0.1) put(-l / 2, v, z)
  }
  return new Float32Array(pts)
}

describe('rectangle fit', () => {
  it('recovers extents and heading of an L-shaped view', () => {
    const xs: number[] = [], ys: number[] = []
    const yaw = (30 * Math.PI) / 180
    for (let u = -2; u <= 2; u += 0.05) { xs.push(u * Math.cos(yaw) + 0.9 * Math.sin(yaw)); ys.push(u * Math.sin(yaw) - 0.9 * Math.cos(yaw)) }
    for (let v = -0.9; v <= 0.9; v += 0.05) { xs.push(-2 * Math.cos(yaw) - v * Math.sin(yaw)); ys.push(-2 * Math.sin(yaw) + v * Math.cos(yaw)) }
    const r = fitRectangle(xs, ys)
    expect(r.length).toBeCloseTo(4, 0)
    expect(r.width).toBeCloseTo(1.8, 0)
    expect(r.yaw).toBeCloseTo(yaw, 1)
  })
})

describe('classification', () => {
  it('sorts boxes by size', () => {
    expect(classify(0.5, 0.5, 1.7)).toBe(CLASS.pedestrian)
    expect(classify(1.8, 0.6, 1.7)).toBe(CLASS.cyclist)
    expect(classify(4.4, 1.8, 1.5)).toBe(CLASS.car)
    expect(classify(9, 2.5, 3.4)).toBe(CLASS.truck)
    expect(classify(30, 20, 4)).toBe(-1)
  })
})

describe('detection', () => {
  it('boxes a car standing on the ground', () => {
    const pts = boxScene(12, -5, 4.4, 1.8, 1.5, 0.4)
    const d = detect(pts, pts.length / 3, 0, 0, 60)
    expect(d).toHaveLength(1)
    expect(d[0].cls).toBe(CLASS.car)
    expect(d[0].x).toBeCloseTo(12, 0)
    expect(d[0].y).toBeCloseTo(-5, 0)
    expect(d[0].height).toBeCloseTo(1.5, 0)
  })

  it('finds vehicles in a simulated revolution', () => {
    const sim = new Simulator(PRESETS[2].config, DEFAULT_ENVIRONMENT)
    sim.step(0.1)
    const d = detect(sim.revPoints, sim.revCount, sim.pose.x, sim.pose.y, 120)
    expect(d.filter((x) => x.cls === CLASS.car).length).toBeGreaterThan(3)
  })
})

describe('tracker', () => {
  it('confirms a track and estimates its velocity', () => {
    const tracker = new Tracker()
    let out = tracker.update([], 0)
    for (let k = 0; k < 30; k++) {
      const t = k * 0.1
      out = tracker.update(
        [{ x: 10 + 8 * t, y: 3, z: 0.75, length: 4.4, width: 1.8, height: 1.5, yaw: 0, cls: CLASS.car, points: 80 }],
        t,
      )
    }
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(1)
    expect(out[0].vx).toBeCloseTo(8, 0)
    expect(Math.abs(out[0].vy)).toBeLessThan(0.3)
    expect(out[0].cls).toBe(CLASS.car)
  })
})
