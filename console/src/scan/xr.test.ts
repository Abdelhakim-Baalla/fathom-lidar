import { describe, expect, it } from 'vitest'
import { poseOf, unprojectDepth } from './xr'

// A 90° symmetric frustum: p0 = p5 = 1.
const PROJ = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('phone depth unprojection', () => {
  it('puts the centre pixel straight ahead at its depth', () => {
    const pts: number[][] = []
    unprojectDepth(() => 2, 1, 1, PROJ, ID, (x, y, z) => pts.push([x, y, z]))
    expect(pts[0][0]).toBeCloseTo(2)
    expect(pts[0][1]).toBeCloseTo(0)
    expect(pts[0][2]).toBeCloseTo(0)
  })

  it('puts the left edge to the left and the top edge up', () => {
    const pts: number[][] = []
    // 2×2 image: pixel centres at u,v = 0.25 and 0.75
    unprojectDepth(() => 1, 2, 2, PROJ, ID, (x, y, z) => pts.push([x, y, z]))
    const [topLeft] = pts
    expect(topLeft[0]).toBeCloseTo(1)
    expect(topLeft[1]).toBeCloseTo(0.5) // left is +y
    expect(topLeft[2]).toBeCloseTo(0.5) // up is +z
  })

  it('reads the phone heading from its view matrix', () => {
    // Turned 90° to the left (counter-clockwise seen from above): looks down −x in WebXR.
    const a = Math.PI / 2
    const view = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 1.4, 0, 1]
    const p = poseOf(view)
    expect(p.yaw).toBeCloseTo(Math.PI / 2)
    expect(p.z).toBeCloseTo(1.4)
  })
})
