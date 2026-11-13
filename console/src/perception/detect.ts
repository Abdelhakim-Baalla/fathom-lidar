import { CLASS } from '../sim/scene'

export interface Detection {
  x: number
  y: number
  /** box centre height */
  z: number
  length: number
  width: number
  height: number
  yaw: number
  cls: number
  points: number
}

const GROUND_CELL = 1.0
const CELL = 0.3
const GROUND_CLEARANCE = 0.3
const MAX_OBJECT_TOP = 4.5
const MAX_FOOTPRINT = 16
const MIN_POINTS = 6

/** Size class from a fitted box. Partial views shrink boxes, so these are lower bounds on truth. */
export function classify(length: number, width: number, height: number): number {
  if (length < 1.1 && width < 1.0 && height > 1.1 && height < 2.15) return CLASS.pedestrian
  if (length >= 1.1 && length < 2.4 && width < 0.95 && height > 1.1 && height < 2.1) return CLASS.cyclist
  if (length >= 2.4 && length < 5.8 && width > 0.9 && width < 2.4 && height > 0.9 && height < 2.2) return CLASS.car
  if (length >= 5.2 && length < 14 && width > 1.2 && width < 3.4 && height >= 2.2 && height < 4.4) return CLASS.truck
  return -1
}

/**
 * One revolution of points in the odometry frame → boxed objects.
 * Ground is whatever sits within a hand's width of the lowest return nearby;
 * the rest is clustered on an occupancy grid and fitted with a rectangle.
 */
export function detect(points: Float32Array, count: number, cx: number, cy: number, range: number): Detection[] {
  const gN = Math.ceil((2 * range) / GROUND_CELL)
  const gx0 = cx - range, gy0 = cy - range
  const low = new Float32Array(gN * gN).fill(Infinity)
  for (let i = 0; i < count; i++) {
    const ix = Math.floor((points[i * 3] - gx0) / GROUND_CELL)
    const iy = Math.floor((points[i * 3 + 1] - gy0) / GROUND_CELL)
    if (ix < 0 || iy < 0 || ix >= gN || iy >= gN) continue
    const z = points[i * 3 + 2]
    const k = iy * gN + ix
    if (z < low[k]) low[k] = z
  }
  // Lowest return in the 3 × 3 neighbourhood, so an object does not become its own ground.
  const floor = new Float32Array(gN * gN)
  for (let y = 0; y < gN; y++) {
    for (let x = 0; x < gN; x++) {
      let m = Infinity
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= gN) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= gN) continue
          const v = low[yy * gN + xx]
          if (v < m) m = v
        }
      }
      floor[y * gN + x] = m
    }
  }

  const N = Math.ceil((2 * range) / CELL)
  const label = new Int32Array(N * N) // 0 empty, -1 occupied, >0 cluster id
  const cellOf = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    const px = points[i * 3], py = points[i * 3 + 1], pz = points[i * 3 + 2]
    const gx = Math.floor((px - gx0) / GROUND_CELL), gy = Math.floor((py - gy0) / GROUND_CELL)
    if (gx < 0 || gy < 0 || gx >= gN || gy >= gN) continue
    const f = floor[gy * gN + gx]
    if (pz < f + GROUND_CLEARANCE || pz > f + MAX_OBJECT_TOP) continue
    const k = Math.floor((py - gy0) / CELL) * N + Math.floor((px - gx0) / CELL)
    label[k] = -1
    cellOf[i] = k
  }

  // Connected components over occupied cells, 8-neighbourhood.
  let clusters = 0
  const stack: number[] = []
  const tooBig: boolean[] = [false]
  for (let start = 0; start < label.length; start++) {
    if (label[start] !== -1) continue
    const id = ++clusters
    let minX = N, maxX = 0, minY = N, maxY = 0
    label[start] = id
    stack.push(start)
    while (stack.length) {
      const k = stack.pop()!
      const x = k % N, y = (k - x) / N
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= N) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= N) continue
          const j = yy * N + xx
          if (label[j] === -1) {
            label[j] = id
            stack.push(j)
          }
        }
      }
    }
    tooBig.push(Math.max(maxX - minX, maxY - minY) * CELL > MAX_FOOTPRINT)
  }

  const xs: number[][] = [], ys: number[][] = []
  const zLo: number[] = [], zHi: number[] = []
  for (let c = 0; c <= clusters; c++) {
    xs.push([]); ys.push([]); zLo.push(Infinity); zHi.push(-Infinity)
  }
  for (let i = 0; i < count; i++) {
    const k = cellOf[i]
    if (k < 0) continue
    const id = label[k]
    if (tooBig[id]) continue
    xs[id].push(points[i * 3])
    ys[id].push(points[i * 3 + 1])
    const z = points[i * 3 + 2]
    if (z < zLo[id]) zLo[id] = z
    if (z > zHi[id]) zHi[id] = z
  }

  const out: Detection[] = []
  for (let id = 1; id <= clusters; id++) {
    const n = xs[id].length
    if (n < MIN_POINTS) continue
    const fit = fitRectangle(xs[id], ys[id])
    // Sit the box on the ground under it, not on the lowest return.
    const gx = Math.floor((fit.x - gx0) / GROUND_CELL), gy = Math.floor((fit.y - gy0) / GROUND_CELL)
    const ground = gx >= 0 && gy >= 0 && gx < gN && gy < gN ? floor[gy * gN + gx] : zLo[id]
    const base = Number.isFinite(ground) ? Math.min(ground, zLo[id]) : zLo[id]
    const height = zHi[id] - base
    const cls = classify(fit.length, fit.width, height)
    if (cls < 0) continue
    out.push({
      x: fit.x, y: fit.y, z: base + height / 2,
      length: fit.length, width: fit.width, height, yaw: fit.yaw, cls, points: n,
    })
  }
  return out
}

/**
 * Search-based rectangle fit (closeness criterion, Zhang et al. 2017): sweep the
 * heading through a quarter turn and keep the rectangle whose edges the points
 * hug most tightly. Unlike minimum area, this stays stable on the L-shaped
 * views a LiDAR gets of a vehicle.
 */
export function fitRectangle(xs: number[], ys: number[]): {
  x: number; y: number; length: number; width: number; yaw: number
} {
  const step = Math.max(1, Math.floor(xs.length / 240))
  let best = -Infinity
  let out = { x: 0, y: 0, length: 0, width: 0, yaw: 0 }
  for (let deg = 0; deg < 90; deg += 3) {
    const a = (deg * Math.PI) / 180
    const c = Math.cos(a), s = Math.sin(a)
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (let i = 0; i < xs.length; i += step) {
      const u = xs[i] * c + ys[i] * s, v = -xs[i] * s + ys[i] * c
      if (u < u0) u0 = u
      if (u > u1) u1 = u
      if (v < v0) v0 = v
      if (v > v1) v1 = v
    }
    let score = 0
    for (let i = 0; i < xs.length; i += step) {
      const u = xs[i] * c + ys[i] * s, v = -xs[i] * s + ys[i] * c
      const d = Math.min(u - u0, u1 - u, v - v0, v1 - v)
      score += 1 / Math.max(d, 0.05)
    }
    if (score > best) {
      best = score
      const du = u1 - u0, dv = v1 - v0
      const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2
      out = {
        x: mu * c - mv * s,
        y: mu * s + mv * c,
        length: Math.max(du, dv),
        width: Math.min(du, dv),
        yaw: du >= dv ? a : a + Math.PI / 2,
      }
    }
  }
  return out
}
