import { CLASS } from '../sim/scene'
import type { Detection } from './detect'

export interface Track {
  id: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  length: number
  width: number
  height: number
  yaw: number
  cls: number
  /** revolutions this object has been followed */
  age: number
  hits: number
  misses: number
  points: number
}

const ALPHA = 0.5
const BETA = 0.18
const CONFIRM_HITS = 3
const MAX_MISSES = 4

/** Larger classes win: a partial view can make a car look like a cyclist, never the reverse. */
const RANK: Record<number, number> = {
  [CLASS.pedestrian]: 1,
  [CLASS.cyclist]: 2,
  [CLASS.car]: 3,
  [CLASS.truck]: 4,
}

interface Internal extends Track {
  votes: Record<number, number>
}

/** Nearest-neighbour association with an alpha-beta constant-velocity filter. */
export class Tracker {
  private tracks: Internal[] = []
  private nextId = 1
  private lastTime: number | null = null

  reset(): void {
    this.tracks = []
    this.lastTime = null
  }

  update(detections: Detection[], time: number): Track[] {
    const dt = this.lastTime === null ? 0 : Math.max(1e-3, time - this.lastTime)
    this.lastTime = time

    for (const t of this.tracks) {
      t.x += t.vx * dt
      t.y += t.vy * dt
    }

    // Greedy: closest pairs first.
    const pairs: Array<[number, number, number]> = []
    this.tracks.forEach((t, ti) => {
      const gate = 1.6 + 0.35 * t.length + Math.hypot(t.vx, t.vy) * dt * 0.5
      detections.forEach((d, di) => {
        const dist = Math.hypot(d.x - t.x, d.y - t.y)
        if (dist < gate) pairs.push([dist, ti, di])
      })
    })
    pairs.sort((a, b) => a[0] - b[0])
    const usedT = new Set<number>(), usedD = new Set<number>()
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue
      usedT.add(ti)
      usedD.add(di)
      this.correct(this.tracks[ti], detections[di], dt)
    }

    this.tracks.forEach((t, ti) => {
      if (!usedT.has(ti)) t.misses++
      t.age++
    })
    detections.forEach((d, di) => {
      if (usedD.has(di)) return
      this.tracks.push({
        id: this.nextId++,
        x: d.x, y: d.y, z: d.z, vx: 0, vy: 0,
        length: d.length, width: d.width, height: d.height, yaw: d.yaw,
        cls: d.cls, age: 0, hits: 1, misses: 0, points: d.points,
        votes: { [d.cls]: 1 },
      })
    })
    this.tracks = this.tracks.filter((t) => t.misses <= MAX_MISSES)

    return this.tracks
      .filter((t) => t.hits >= CONFIRM_HITS && t.misses <= 2)
      .map(({ votes: _votes, ...t }) => t)
  }

  private correct(t: Internal, d: Detection, dt: number): void {
    const rx = d.x - t.x, ry = d.y - t.y
    t.x += ALPHA * rx
    t.y += ALPHA * ry
    if (dt > 0) {
      t.vx += (BETA / dt) * rx
      t.vy += (BETA / dt) * ry
    }
    t.z = d.z
    // Extents only grow quickly; the best view so far is the best estimate of size.
    t.length = Math.max(d.length, t.length * 0.985)
    t.width = Math.max(d.width, t.width * 0.985)
    t.height = Math.max(d.height, t.height * 0.985)
    const speed = Math.hypot(t.vx, t.vy)
    t.yaw = speed > 1.5 && t.hits > 4 ? Math.atan2(t.vy, t.vx) : d.yaw
    t.votes[d.cls] = (t.votes[d.cls] ?? 0) + 1
    let cls = t.cls
    for (const key of Object.keys(t.votes)) {
      const c = Number(key)
      if (t.votes[c] >= 3 && (RANK[c] ?? 0) > (RANK[cls] ?? 0)) cls = c
    }
    t.cls = cls
    t.hits++
    t.misses = 0
    t.points = d.points
  }
}
