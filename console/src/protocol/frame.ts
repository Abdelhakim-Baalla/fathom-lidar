/**
 * FTHM frame: the one wire format shared by the simulator, the hardware
 * bridge and recordings. Little-endian throughout.
 *
 *   0  u8[4]  magic "FTHM"
 *   4  u16    version
 *   6  u16    flags
 *   8  u32    frame id (increments per packet)
 *  12  u32    point count
 *  16  f64    timestamp, seconds
 *  24  f32[3] sensor position in the odometry frame, metres
 *  36  f32    sensor yaw in the odometry frame, radians
 *  40  points, 16 bytes each:
 *        f32 x, f32 y, f32 z   sensor frame, metres (x forward, y left, z up)
 *        u8  intensity         0..100 diffuse, 101..255 retroreflective
 *        u8  ring              channel index, 0 = lowest beam
 *        u16 azimuth           hundredths of a degree, 0..35999
 */

export const MAGIC = 0x4d485446 // "FTHM" read as little-endian u32
export const VERSION = 1
export const HEADER_BYTES = 40
export const POINT_BYTES = 16

export const FLAG_SIMULATED = 1 << 0
export const FLAG_REVOLUTION_END = 1 << 1

export interface FrameHeader {
  flags: number
  frameId: number
  pointCount: number
  timestamp: number
  x: number
  y: number
  z: number
  yaw: number
}

export interface Frame extends FrameHeader {
  /** xyz + one packed word per point; stride 4 floats */
  f32: Float32Array
  /** stride 16; intensity at +12, ring at +13 */
  u8: Uint8Array
  /** stride 8; azimuth at +7 */
  u16: Uint16Array
  buffer: ArrayBuffer
}

export function frameByteLength(pointCount: number): number {
  return HEADER_BYTES + pointCount * POINT_BYTES
}

/** Allocate a frame with room for `capacity` points; fill points, then call `finishFrame`. */
export function allocFrame(capacity: number): Frame {
  const buffer = new ArrayBuffer(frameByteLength(capacity))
  return viewFrame(buffer, capacity, {
    flags: 0,
    frameId: 0,
    pointCount: 0,
    timestamp: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
  })
}

function viewFrame(buffer: ArrayBuffer, points: number, h: FrameHeader): Frame {
  return {
    ...h,
    buffer,
    f32: new Float32Array(buffer, HEADER_BYTES, points * 4),
    u8: new Uint8Array(buffer, HEADER_BYTES, points * POINT_BYTES),
    u16: new Uint16Array(buffer, HEADER_BYTES, points * 8),
  }
}

export function writePoint(
  f: Frame,
  i: number,
  x: number,
  y: number,
  z: number,
  intensity: number,
  ring: number,
  azimuthCentideg: number,
): void {
  const o = i * 4
  f.f32[o] = x
  f.f32[o + 1] = y
  f.f32[o + 2] = z
  f.u8[i * 16 + 12] = intensity
  f.u8[i * 16 + 13] = ring
  f.u16[i * 8 + 7] = azimuthCentideg
}

/** Write the header and return the exact bytes to send (trimmed to the point count). */
export function finishFrame(f: Frame, h: FrameHeader): ArrayBuffer {
  const dv = new DataView(f.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint16(4, VERSION, true)
  dv.setUint16(6, h.flags, true)
  dv.setUint32(8, h.frameId, true)
  dv.setUint32(12, h.pointCount, true)
  dv.setFloat64(16, h.timestamp, true)
  dv.setFloat32(24, h.x, true)
  dv.setFloat32(28, h.y, true)
  dv.setFloat32(32, h.z, true)
  dv.setFloat32(36, h.yaw, true)
  const bytes = frameByteLength(h.pointCount)
  return bytes === f.buffer.byteLength ? f.buffer : f.buffer.slice(0, bytes)
}

export class FrameError extends Error {}

export function decodeFrame(buffer: ArrayBuffer): Frame {
  if (buffer.byteLength < HEADER_BYTES) throw new FrameError('Frame is shorter than its header')
  const dv = new DataView(buffer)
  if (dv.getUint32(0, true) !== MAGIC) throw new FrameError('Not an FTHM frame')
  const version = dv.getUint16(4, true)
  if (version !== VERSION) throw new FrameError(`Unsupported frame version ${version}`)
  const pointCount = dv.getUint32(12, true)
  if (buffer.byteLength < frameByteLength(pointCount)) {
    throw new FrameError('Frame is truncated: fewer bytes than its point count needs')
  }
  return viewFrame(buffer, pointCount, {
    flags: dv.getUint16(6, true),
    frameId: dv.getUint32(8, true),
    pointCount,
    timestamp: dv.getFloat64(16, true),
    x: dv.getFloat32(24, true),
    y: dv.getFloat32(28, true),
    z: dv.getFloat32(32, true),
    yaw: dv.getFloat32(36, true),
  })
}
