import {
  allocFrame,
  finishFrame,
  FLAG_REVOLUTION_END,
  FLAG_SIMULATED,
  writePoint,
  type Frame,
} from '../protocol/frame'
import { Rng } from './rng'
import {
  BOX,
  buildScene,
  CLASS,
  CYLINDER,
  groundReflectivity,
  loopPose,
  type Pose,
  type Prim,
  type Scene,
} from './scene'
import { atmosphere, beamElevations, type Environment, type SensorConfig } from './sensor'

export interface Packet {
  /** encoded FTHM frame */
  frame: ArrayBuffer
  /** ground-truth class per point; simulator only */
  truth: Uint8Array
  pointCount: number
  /** rays fired, including those that returned nothing */
  rays: number
  revolutionEnded: boolean
}

const TWO_PI = Math.PI * 2

/**
 * A spinning multi-beam LiDAR on a vehicle driving the scene. Every point is a
 * ray cast at its own firing time from the pose the vehicle had at that instant.
 */
export class Simulator {
  readonly scene: Scene
  time = 0
  /** sensor azimuth in the sensor frame, radians, counter-clockwise from forward */
  azimuth = 0
  distance = 0
  readonly pose: Pose = { x: 0, y: 0, yaw: 0 }

  private sensor: SensorConfig
  private env: Environment
  private elevCos = new Float32Array(0)
  private elevSin = new Float32Array(0)
  private rng = new Rng(1234)
  private columnCarry = 0
  private frameId = 0
  private near: Prim[] = []
  private column: Prim[] = []
  private colPose: Pose = { x: 0, y: 0, yaw: 0 }

  /** world-frame points of the revolution in progress, for perception */
  revPoints = new Float32Array(3 * 262144)
  revCount = 0

  constructor(sensor: SensorConfig, env: Environment, seed = 7) {
    this.scene = buildScene(seed)
    this.sensor = sensor
    this.env = env
    this.setSensor(sensor)
    loopPose(0, this.pose)
  }

  setSensor(sensor: SensorConfig): void {
    this.sensor = sensor
    const el = beamElevations(sensor)
    this.elevCos = el.map(Math.cos)
    this.elevSin = el.map(Math.sin)
  }

  setEnvironment(env: Environment): void {
    this.env = env
  }

  /** Advance the world by `dt` seconds and fire every column that falls in that window. */
  step(dt: number): Packet {
    const s = this.sensor
    const t0 = this.time
    const exact = this.columnCarry + s.columnRate * dt
    const columns = Math.floor(exact)
    this.columnCarry = exact - columns

    // Moving objects are posed once per step; the ego pose is exact per column.
    this.scene.update(t0 + dt / 2)
    const d0 = this.distance
    const d1 = d0 + this.env.egoSpeed * dt
    loopPose(d1, this.pose)
    const refCos = Math.cos(this.pose.yaw), refSin = Math.sin(this.pose.yaw)

    // Solids that can be reached at all from this stretch of road.
    const near = this.near
    near.length = 0
    const reach = s.maxRange + this.env.egoSpeed * dt + 1
    for (const p of this.scene.prims) {
      const dx = p.cx - this.pose.x, dy = p.cy - this.pose.y
      const r = reach + p.br
      if (dx * dx + dy * dy < r * r) near.push(p)
    }

    const frame = allocFrame(columns * s.channels)
    const truth = new Uint8Array(columns * s.channels)
    const air = atmosphere(this.env.weather)
    const dAz = (TWO_PI * s.rateHz) / s.columnRate
    const oz = s.mountHeight
    let n = 0
    let revolutionEnded = false

    for (let c = 0; c < columns; c++) {
      const f = columns > 0 ? (c + 1) / columns : 1
      const cp = loopPose(d0 + (d1 - d0) * f, this.colPose)
      let az = this.azimuth + dAz
      if (az >= TWO_PI) {
        az -= TWO_PI
        revolutionEnded = true
      }
      this.azimuth = az
      const worldAz = cp.yaw + az
      const ax = Math.cos(worldAz), ay = Math.sin(worldAz)
      const ox = cp.x, oy = cp.y

      // Column cull: keep solids whose footprint circle the vertical firing plane crosses.
      const col = this.column
      col.length = 0
      for (let i = 0; i < near.length; i++) {
        const p = near[i]
        const vx = p.cx - ox, vy = p.cy - oy
        const along = vx * ax + vy * ay
        if (along < -p.br || along - p.br > s.maxRange) continue
        const perp = vx * ay - vy * ax
        if (perp > p.br || perp < -p.br) continue
        col.push(p)
      }
      const azCenti = Math.min(35999, Math.round((az * 18000) / Math.PI))

      for (let ch = 0; ch < s.channels; ch++) {
        const ce = this.elevCos[ch], dz = this.elevSin[ch]
        const dx = ax * ce, dy = ay * ce

        let t = Infinity
        let cosInc = 1
        let hit: Prim | null = null
        let hitAxis = 2
        let hitU = 0
        if (dz < -1e-6) {
          t = -oz / dz
          cosInc = -dz
        }
        for (let i = 0; i < col.length; i++) {
          const p = col[i]
          const th = intersect(p, ox, oy, oz, dx, dy, dz, t)
          if (th < t) {
            if (p.porosity > 0 && this.rng.next() < p.porosity) continue
            t = th
            cosInc = lastCos
            hit = p
            hitAxis = lastAxis
            hitU = lastU
          }
        }

        let cls: number = CLASS.ground
        let refl = 0
        let valid = t < s.maxRange
        if (valid) {
          if (hit) {
            cls = hit.cls
            refl = hit.refl
            if (hit.specular && cosInc < 0.92 && this.rng.next() < 0.32) valid = false
            if (hit.porosity > 0) t += this.rng.next() * 0.7 // leaves sit at varying depth
            // Building facades are not flat: windows sit in a recess and reflect
            // like glass, piers stand proud, mullion grids break up a tower.
            // Modulating the hit depth keeps the ray count low and still gives
            // the cloud real architectural relief.
            if (hit.detail > 0 && hitAxis < 2) {
              const wz = oz + dz * t
              const seed = tint(hit.cx * 0.13, hit.cy * 0.17)
              const f = facadeAt(hit.detail, hitU, wz, seed, hit.refl)
              if (f.refl >= 0) {
                refl = f.refl
                // Positive recess moves the return into the glass; negative
                // values stand proud (sills, pilasters, cornices), which gives
                // the cloud real ledges instead of a painted wall.
                if (f.recess !== 0) t += f.recess / Math.max(0.16, cosInc)
              }
            }
          } else {
            refl = groundReflectivity(ox + dx * t, oy + dy * t)
          }
        }
        if (valid) {
          // Returned power falls with 1/r², incidence angle and two-way extinction.
          const k = s.range10 / t
          const snr = (Math.min(refl, 1.6) / 0.1) * cosInc * k * k * Math.exp(-2 * air.alpha * t)
          if (snr < 1.3 && this.rng.next() > (snr - 0.7) / 0.6) valid = false
        }
        // A droplet in front of the target can return first.
        if (air.backscatter > 0 && this.rng.next() < air.backscatter) {
          const td = s.minRange + -Math.log(1 - this.rng.next()) * air.meanDepth
          if (td < t || !valid) {
            if (td < s.maxRange * 0.5) {
              t = td
              valid = true
              cls = CLASS.weather
              refl = 0.04
              cosInc = 1
            }
          }
        }
        if (!valid) continue
        t += this.rng.gauss() * s.rangeNoise
        // Recessed glass and range noise can push a return past the gate; a real
        // instrument reports nothing there rather than stretching its range.
        if (t < s.minRange || t >= s.maxRange) continue

        const wx = ox + dx * t, wy = oy + dy * t, wz = oz + dz * t
        let intensity =
          refl <= 1 ? refl * 100 * (0.55 + 0.45 * cosInc) : 100 + (refl - 1) * 90
        intensity = Math.max(1, Math.min(255, Math.round(intensity + this.rng.gauss() * 2)))

        // Express the point in the sensor frame of the packet's reference pose.
        const rx = wx - this.pose.x, ry = wy - this.pose.y
        writePoint(frame, n, rx * refCos + ry * refSin, -rx * refSin + ry * refCos, wz - oz, intensity, ch, azCenti)
        truth[n] = cls
        n++

        if (this.revCount * 3 < this.revPoints.length) {
          const o = this.revCount * 3
          this.revPoints[o] = wx
          this.revPoints[o + 1] = wy
          this.revPoints[o + 2] = wz
          this.revCount++
        }
      }
    }

    this.time = t0 + dt
    this.distance = d1
    return this.finish(frame, truth, n, columns * s.channels, revolutionEnded)
  }

  private finish(frame: Frame, truth: Uint8Array, n: number, rays: number, revolutionEnded: boolean): Packet {
    const bytes = finishFrame(frame, {
      flags: FLAG_SIMULATED | (revolutionEnded ? FLAG_REVOLUTION_END : 0),
      frameId: this.frameId++,
      pointCount: n,
      timestamp: this.time,
      x: this.pose.x,
      y: this.pose.y,
      z: this.sensor.mountHeight,
      yaw: this.pose.yaw,
    })
    return { frame: bytes, truth: truth.subarray(0, n), pointCount: n, rays, revolutionEnded }
  }
}

/** Cosine of the incidence angle at the most recent hit returned by `intersect`. */
let lastCos = 1
/** Face and along-facade coordinate of the most recent box hit (axis 0/1 only). */
let lastAxis = 2
let lastU = 0

/** Distance along the ray to the solid, or Infinity. Only hits nearer than `tMax` count. */
function intersect(
  p: Prim, ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number, tMax: number,
): number {
  const px = ox - p.cx, py = oy - p.cy, pz = oz - p.cz
  if (p.kind === BOX) {
    const lx = px * p.cos + py * p.sin, ly = -px * p.sin + py * p.cos
    const ex = dx * p.cos + dy * p.sin, ey = -dx * p.sin + dy * p.cos
    let tNear = -Infinity, tFar = Infinity, axis = 0
    // x slab
    if (Math.abs(ex) < 1e-9) {
      if (lx < -p.hx || lx > p.hx) return Infinity
    } else {
      let a = (-p.hx - lx) / ex, b = (p.hx - lx) / ex
      if (a > b) { const s = a; a = b; b = s }
      if (a > tNear) { tNear = a; axis = 0 }
      if (b < tFar) tFar = b
    }
    if (Math.abs(ey) < 1e-9) {
      if (ly < -p.hy || ly > p.hy) return Infinity
    } else {
      let a = (-p.hy - ly) / ey, b = (p.hy - ly) / ey
      if (a > b) { const s = a; a = b; b = s }
      if (a > tNear) { tNear = a; axis = 1 }
      if (b < tFar) tFar = b
    }
    if (Math.abs(dz) < 1e-9) {
      if (pz < -p.hz || pz > p.hz) return Infinity
    } else {
      let a = (-p.hz - pz) / dz, b = (p.hz - pz) / dz
      if (a > b) { const s = a; a = b; b = s }
      if (a > tNear) { tNear = a; axis = 2 }
      if (b < tFar) tFar = b
    }
    if (tNear > tFar || tNear <= 0 || tNear >= tMax) return Infinity
    lastCos = Math.abs(axis === 0 ? ex : axis === 1 ? ey : dz)
    lastAxis = axis
    lastU = axis === 0 ? ly + ey * tNear : lx + ex * tNear
    return tNear
  }
  if (p.kind === CYLINDER) {
    const a = dx * dx + dy * dy
    if (a < 1e-12) return Infinity
    const b = px * dx + py * dy
    const disc = b * b - a * (px * px + py * py - p.hx * p.hx)
    if (disc < 0) return Infinity
    const t = (-b - Math.sqrt(disc)) / a
    if (t <= 0 || t >= tMax) return Infinity
    const z = pz + dz * t
    if (z < -p.hz || z > p.hz) return Infinity
    lastCos = Math.abs(((px + dx * t) * dx + (py + dy * t) * dy) / p.hx)
    return t
  }
  // sphere
  const b = px * dx + py * dy + pz * dz
  const disc = b * b - (px * px + py * py + pz * pz - p.hx * p.hx)
  if (disc < 0) return Infinity
  const t = -b - Math.sqrt(disc)
  if (t <= 0 || t >= tMax) return Infinity
  lastCos = Math.abs(((px + dx * t) * dx + (py + dy * t) * dy + (pz + dz * t) * dz) / p.hx)
  return t
}

const frac = (v: number) => v - Math.floor(v)

/** Cheap deterministic noise for glass tint and blind positions. */
const tint = (u: number, v: number) => frac(Math.sin(u * 3.17 + v * 7.31) * 43758.5453)

/** Facade dimensions derived once per building, not once per returned ray. */
interface FacadeParams {
  shopBay: number
  shopPier: number
  cwBay: number
  cwFloor: number
  bayW: number
  floorH: number
  ribbon: boolean
  bayMid: number
  halfW: number
  sill: number
  head: number
  litAt: number
}

const facadeCache = new Map<number, FacadeParams>()

function facadeFor(seed: number): FacadeParams {
  const key = Math.round(seed * 4096)
  let p = facadeCache.get(key)
  if (p) return p
  const ribbon = seed > 0.7
  p = {
    shopBay: 3.4 + seed * 3.0,
    shopPier: 0.09 + tint(seed, 1.7) * 0.1,
    cwBay: 1.42 + seed * 0.6,
    cwFloor: 3.45 + tint(seed, 8.4) * 0.65,
    bayW: 2.85 + seed * 1.35,
    floorH: 3.15 + tint(seed, 2.3) * 0.75,
    ribbon,
    bayMid: 0.5 + tint(seed, 5.9) * 0.06,
    halfW: ribbon ? 0.46 : 0.2 + tint(seed, 4.4) * 0.07,
    sill: ribbon ? 1.12 : 0.9 + tint(seed, 6.2) * 0.22,
    head: ribbon ? 2.42 : 2.3 + tint(seed, 9.7) * 0.26,
    litAt: 0.9 + tint(seed, 6.6) * 0.06,
  }
  facadeCache.set(key, p)
  return p
}

/**
 * Facade relief. Returns the recess depth into the wall and the reflectivity of
 * that piece of facade; `refl < 0` means the plain wall value stands. `seed` is
 * fixed per building so bay rhythm, floor height and glazing style differ from
 * one block to the next instead of repeating like wallpaper.
 */
function facadeAt(
  detail: number, u: number, v: number, seed: number, wall: number,
): { recess: number; refl: number } {
  const p = facadeFor(seed)
  if (detail === 3) {
    // Shopfront: tall panes between masonry piers, fascia above, stall riser below.
    const bayW = p.shopBay
    const pier = p.shopPier
    const bay = frac(u / bayW)
    if (v > 3.06 && v < 3.42) {
      // Fascia board stands off the wall and carries a bright trim line, so the
      // ground floor reads as a separate storey from the upper floors.
      return { recess: -0.1, refl: v > 3.34 || v < 3.1 ? 0.52 : 0.3 }
    }
    if ((bay < pier || bay > 1 - pier) && v < 3.06) {
      // Masonry piers between the shop windows.
      return { recess: -0.14, refl: 0.38 + tint(u, v) * 0.08 }
    }
    if (v > 0.48 && v < 3.02) {
      if (Math.abs(v - 2.52) < 0.035) return { recess: -0.02, refl: 0.4 }
      if (frac(u / 1.55) < 0.07) return { recess: -0.01, refl: 0.4 }
      // A few units are lit from inside; the rest return almost nothing.
      if (tint(u * 0.21, v * 0.13) > 0.9) return { recess: 0.16, refl: 1.15 }
      const t = tint(u, v)
      return { recess: 0.3 + t * 0.08, refl: 0.035 + t * 0.05 }
    }
    // Stall riser: dark painted panel under the glazing.
    return { recess: 0, refl: 0.26 + tint(u, v) * 0.06 }
  }
  if (detail === 2) {
    // Curtain wall: a tight mullion grid over continuous glass, with an opaque
    // spandrel at each floor slab. Bay and storey height vary per tower.
    const bayW = p.cwBay
    const floorH = p.cwFloor
    const bay = frac(u / bayW)
    const floor = frac(v / floorH)
    const storey = Math.floor(v / floorH)
    if (floor < 0.085 || floor > 0.93) {
      // Spandrel band, with a proud slab edge at its top.
      return { recess: floor > 0.9 ? -0.06 : -0.02, refl: 0.32 + tint(u * 0.7, v) * 0.08 }
    }
    if (bay > 0.015 && bay < 0.985) {
      // Mullions stand proud of the glass, with a transom across each storey.
      if (bay < 0.095 || bay > 0.905) return { recess: -0.07, refl: 0.46 }
      if (Math.abs(floor - 0.52) < 0.016) return { recess: -0.04, refl: 0.42 }
      // A whole lit floor now and then: the office block reads at night.
      if (tint(seed, storey * 1.37) > 0.82) return { recess: 0.18, refl: 0.72 + tint(u, v) * 0.45 }
      const t = tint(u, v)
      return { recess: 0.24 + t * 0.06, refl: 0.035 + t * 0.06 }
    }
    return { recess: 0, refl: wall * (0.9 + tint(u * 0.5, v * 0.11) * 0.2) }
  }
  // Punched windows on a varied bay. Some blocks use a ribbon window instead:
  // a wide horizontal band that gives the range image long unbroken glazing.
  const bayW = p.bayW
  const floorH = p.floorH
  const ribbon = p.ribbon
  const bay = frac(u / bayW)
  const floor = frac(v / floorH)
  const t = tint(u, v)
  const bayMid = p.bayMid
  const halfW = p.halfW
  const sill = p.sill
  const head = p.head

  // Pilasters break the wall into vertical bays; floor bands cross them. Both
  // stand proud, which is what catches the scanner on a real block.
  if (bay < 0.045 || bay > 0.955) return { recess: -0.16, refl: 0.42 + tint(u, v) * 0.08 }
  if (floor < 0.026 || floor > 0.972) return { recess: -0.1, refl: 0.46 + tint(u * 1.7, v) * 0.06 }

  if (floor > sill && floor < head && bay > bayMid - halfW && bay < bayMid + halfW) {
    // Sill and lintel stand proud of the glazing; the pane is split by slim
    // mullions and a few rooms are lit behind it.
    if (floor < sill + 0.03 || floor > head - 0.025) return { recess: -0.055, refl: 0.5 }
    const across = (bay - bayMid + halfW) * bayW
    const pane = ribbon ? 1.2 : 0.78
    if (frac(across / pane) < 0.09) return { recess: 0.02, refl: 0.38 }
    const litAt = p.litAt
    if (t > litAt) return { recess: 0.12, refl: 0.95 + t * 0.35 } // a lit room behind the glass
    if (t > litAt - 0.09) return { recess: 0.14, refl: 0.28 } // blind part-way down
    return { recess: 0.32 + t * 0.12, refl: 0.03 + t * 0.05 }
  }
  // Plain wall: grime, patch repairs and weather streaks keep the largest
  // surfaces from reading as one flat sheet of returns.
  const grime = tint(u * 0.37, v * 0.21)
  const streak = tint(u * 0.09, v * 1.7)
  return { recess: 0, refl: wall * (0.6 + grime * 0.25) * (0.86 + streak * 0.14) }
}
