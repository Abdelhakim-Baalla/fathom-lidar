import { expect, it } from 'vitest'
import { nearbyTracks } from './proximity'
import type { Track } from './perception/track'
const track = (id: number, x: number, overrides = {}): Track => ({ id, x, y: 0, z: 1, vx: 0, vy: 0, length: 1, width: 1, height: 2, yaw: 0, cls: 1, age: 10, hits: 8, misses: 0, points: 100, ...overrides })
it('alerts only on confirmed current tracks inside the operator radius', () => {
  expect(nearbyTracks([track(1, 3), track(2, 9), track(3, 2, { hits: 2 }), track(4, 1, { misses: 1 })], { x: 0, y: 0 }, 8)).toEqual([1])
})
it('uses sensor position and rejects nonfinite or invalid radii', () => {
  expect(nearbyTracks([track(1, 22)], { x: 20, y: 0 }, 3)).toEqual([1])
  expect(nearbyTracks([track(1, NaN)], { x: 0, y: 0 }, 3)).toEqual([])
  expect(nearbyTracks([track(1, 0)], { x: 0, y: 0 }, Infinity)).toEqual([])
})
