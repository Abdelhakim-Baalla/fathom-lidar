import { describe, expect, it } from 'vitest'
import {
  allocFrame,
  decodeFrame,
  finishFrame,
  FLAG_SIMULATED,
  FrameError,
  frameByteLength,
  writePoint,
} from './frame'

describe('FTHM frame', () => {
  it('round-trips header and points', () => {
    const f = allocFrame(8)
    writePoint(f, 0, 1.5, -2.25, 0.5, 87, 3, 12345)
    writePoint(f, 1, -40, 12, 3, 255, 31, 35999)
    const bytes = finishFrame(f, {
      flags: FLAG_SIMULATED,
      frameId: 42,
      pointCount: 2,
      timestamp: 1234.5678,
      x: 10,
      y: -20,
      z: 1.9,
      yaw: 0.75,
    })
    expect(bytes.byteLength).toBe(frameByteLength(2))

    const d = decodeFrame(bytes)
    expect(d.frameId).toBe(42)
    expect(d.pointCount).toBe(2)
    expect(d.timestamp).toBeCloseTo(1234.5678, 9)
    expect(d.yaw).toBeCloseTo(0.75, 6)
    expect(Array.from(d.f32.slice(0, 3))).toEqual([1.5, -2.25, 0.5])
    expect(d.u8[12]).toBe(87)
    expect(d.u8[13]).toBe(3)
    expect(d.u16[7]).toBe(12345)
    expect(d.u8[16 + 12]).toBe(255)
    expect(d.u8[16 + 13]).toBe(31)
    expect(d.u16[8 + 7]).toBe(35999)
  })

  it('rejects foreign and truncated buffers', () => {
    expect(() => decodeFrame(new ArrayBuffer(8))).toThrow(FrameError)
    expect(() => decodeFrame(new ArrayBuffer(64))).toThrow('Not an FTHM frame')
    const f = allocFrame(4)
    const bytes = finishFrame(f, {
      flags: 0, frameId: 1, pointCount: 4, timestamp: 0, x: 0, y: 0, z: 0, yaw: 0,
    })
    expect(() => decodeFrame(bytes.slice(0, bytes.byteLength - 4))).toThrow('truncated')
  })
})
