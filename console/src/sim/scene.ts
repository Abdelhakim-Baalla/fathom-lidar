import { Rng } from './rng'

/** Ground-truth classes. Only the simulator knows these; they never travel in a frame. */
export const CLASS = {
  ground: 0,
  building: 1,
  vegetation: 2,
  pole: 3,
  car: 4,
  truck: 5,
  pedestrian: 6,
  cyclist: 7,
  weather: 8,
} as const

export const BOX = 0
export const CYLINDER = 1
export const SPHERE = 2

/** One ray-castable solid. Boxes rotate about z only; cylinders are vertical. */
export interface Prim {
  kind: number
  cx: number
  cy: number
  cz: number
  /** box half extents; cylinder: hx = radius, hz = half height; sphere: hx = radius */
  hx: number
  hy: number
  hz: number
  cos: number
  sin: number
  /** diffuse reflectivity 0..1; above 1 means retroreflective */
  refl: number
  cls: number
  /** chance a ray slips through (foliage) */
  porosity: number
  /** glass: returns only near normal incidence */
  specular: boolean
  /** bounding radius in the ground plane, for culling */
  br: number
}

function box(
  cx: number, cy: number, cz: number,
  lx: number, ly: number, lz: number,
  yaw: number, refl: number, cls: number, specular = false,
): Prim {
  const hx = lx / 2, hy = ly / 2
  return {
    kind: BOX, cx, cy, cz, hx, hy, hz: lz / 2,
    cos: Math.cos(yaw), sin: Math.sin(yaw),
    refl, cls, porosity: 0, specular, br: Math.hypot(hx, hy),
  }
}

function cylinder(cx: number, cy: number, z0: number, z1: number, r: number, refl: number, cls: number): Prim {
  return {
    kind: CYLINDER, cx, cy, cz: (z0 + z1) / 2, hx: r, hy: r, hz: (z1 - z0) / 2,
    cos: 1, sin: 0, refl, cls, porosity: 0, specular: false, br: r,
  }
}

function sphere(cx: number, cy: number, cz: number, r: number, refl: number, cls: number, porosity: number): Prim {
  return {
    kind: SPHERE, cx, cy, cz, hx: r, hy: r, hz: r,
    cos: 1, sin: 0, refl, cls, porosity, specular: false, br: r,
  }
}

// ── City layout ────────────────────────────────────────────────────────────

export const PITCH = 80
export const ROAD_HALF = 7
export const WALK_OUTER = 10
export const MAP_MIN = -160
export const MAP_MAX = 240
const ROAD_LINES = [-80, 0, 80, 160]

function nearestRoad(v: number): number {
  const k = Math.min(2, Math.max(-1, Math.round(v / PITCH)))
  return k * PITCH
}

/** Ground reflectivity at a point: asphalt, paint, concrete, grass. */
export function groundReflectivity(x: number, y: number): number {
  const rx = nearestRoad(x), ry = nearestRoad(y)
  const dx = Math.abs(x - rx), dy = Math.abs(y - ry)
  const onX = dx < ROAD_HALF // road running along y
  const onY = dy < ROAD_HALF // road running along x
  if (onX && onY) return 0.1
  if (onX || onY) {
    const across = onX ? dx : dy
    const along = onX ? dy : dx
    const acrossPos = onX ? x : y
    if (across < 0.09) return 0.72 // centre line
    if (across > 6.75 && across < 6.9) return 0.68 // edge line
    if (along > 9.5 && along < 12.5) {
      // zebra crossing just before each junction
      return ((acrossPos % 1) + 1) % 1 < 0.5 ? 0.74 : 0.1
    }
    return 0.1
  }
  if (dx < WALK_OUTER || dy < WALK_OUTER) return 0.32
  const park = x > 0 && x < PITCH && y > 0 && y < PITCH
  return park ? 0.46 : 0.22
}

// ── Ego path: clockwise loop around the park block, driving on the right ───

const LOOP_LO = 3
const LOOP_HI = PITCH - 3
const LOOP_R = 7
const LOOP_STRAIGHT = LOOP_HI - LOOP_LO - 2 * LOOP_R
const LOOP_ARC = (Math.PI / 2) * LOOP_R
export const LOOP_LENGTH = 4 * (LOOP_STRAIGHT + LOOP_ARC)

const LOOP_STARTS = [
  [LOOP_LO, LOOP_LO + LOOP_R],
  [LOOP_LO + LOOP_R, LOOP_HI],
  [LOOP_HI, LOOP_HI - LOOP_R],
  [LOOP_HI - LOOP_R, LOOP_LO],
]
const LOOP_CENTRES = [
  [LOOP_LO + LOOP_R, LOOP_HI - LOOP_R],
  [LOOP_HI - LOOP_R, LOOP_HI - LOOP_R],
  [LOOP_HI - LOOP_R, LOOP_LO + LOOP_R],
  [LOOP_LO + LOOP_R, LOOP_LO + LOOP_R],
]

export interface Pose {
  x: number
  y: number
  yaw: number
}

export function loopPose(distance: number, out: Pose): Pose {
  let s = distance % LOOP_LENGTH
  if (s < 0) s += LOOP_LENGTH
  const side = LOOP_STRAIGHT + LOOP_ARC
  const k = Math.min(3, Math.floor(s / side))
  const u = s - k * side
  const heading = Math.PI / 2 - (k * Math.PI) / 2
  if (u < LOOP_STRAIGHT) {
    out.x = LOOP_STARTS[k][0] + Math.cos(heading) * u
    out.y = LOOP_STARTS[k][1] + Math.sin(heading) * u
    out.yaw = heading
  } else {
    const phi = heading + Math.PI / 2 - (u - LOOP_STRAIGHT) / LOOP_R
    out.x = LOOP_CENTRES[k][0] + Math.cos(phi) * LOOP_R
    out.y = LOOP_CENTRES[k][1] + Math.sin(phi) * LOOP_R
    out.yaw = phi - Math.PI / 2
  }
  return out
}

// ── Actors ─────────────────────────────────────────────────────────────────

interface Part {
  prim: Prim
  /** offset in the actor frame: forward, left, up (centre height) */
  fx: number
  fy: number
}

export interface Actor {
  cls: number
  parts: Part[]
  /** true: the road is a line x = const and the actor travels along y */
  alongY: boolean
  line: number
  lane: number
  dir: 1 | -1
  speed: number
  s0: number
  /** current pose, for the ground-truth overlay */
  x: number
  y: number
  yaw: number
  length: number
  width: number
  height: number
}

function part(prim: Prim, fx: number, fy = 0): Part {
  return { prim, fx, fy }
}

function carParts(rng: Rng): { parts: Part[]; l: number; w: number; h: number } {
  const l = rng.range(4.0, 4.8), w = rng.range(1.72, 1.9), h = rng.range(1.42, 1.62)
  const paint = rng.pick([0.08, 0.12, 0.3, 0.55, 0.75, 0.82])
  const bodyTop = 0.92
  return {
    l, w, h,
    parts: [
      part(box(0, 0, (0.22 + bodyTop) / 2, l, w, bodyTop - 0.22, 0, paint, CLASS.car), 0),
      part(box(0, 0, (bodyTop + h) / 2, l * 0.52, w * 0.9, h - bodyTop, 0, paint * 0.8 + 0.04, CLASS.car), -l * 0.06),
    ],
  }
}

function truckParts(rng: Rng): { parts: Part[]; l: number; w: number; h: number } {
  const cargo = rng.range(5.6, 7.4)
  const l = cargo + 2.4
  return {
    l, w: 2.5, h: 3.5,
    parts: [
      part(box(0, 0, 0.8 + 1.35, cargo, 2.5, 2.7, 0, rng.range(0.4, 0.8), CLASS.truck), -1.2),
      part(box(0, 0, 0.35 + 1.2, 2.2, 2.4, 2.4, 0, rng.range(0.15, 0.6), CLASS.truck), l / 2 - 1.1),
    ],
  }
}

function busParts(rng: Rng): { parts: Part[]; l: number; w: number; h: number } {
  const l = rng.range(10.5, 12)
  return {
    l, w: 2.55, h: 3.1,
    parts: [part(box(0, 0, 0.3 + 1.4, l, 2.55, 2.8, 0, rng.range(0.3, 0.7), CLASS.truck), 0)],
  }
}

function placeActor(a: Actor, t: number): void {
  const span = MAP_MAX - MAP_MIN
  let s = (a.s0 + a.dir * a.speed * t - MAP_MIN) % span
  if (s < 0) s += span
  s += MAP_MIN
  const yaw = a.alongY ? (a.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : a.dir > 0 ? 0 : Math.PI
  a.x = a.alongY ? a.line + a.lane : s
  a.y = a.alongY ? s : a.line + a.lane
  a.yaw = yaw
  const c = Math.cos(yaw), sn = Math.sin(yaw)
  for (const p of a.parts) {
    p.prim.cx = a.x + c * p.fx - sn * p.fy
    p.prim.cy = a.y + sn * p.fx + c * p.fy
    p.prim.cos = c
    p.prim.sin = sn
  }
}

// ── Scene ──────────────────────────────────────────────────────────────────

export interface Scene {
  /** static solids followed by every actor part */
  prims: Prim[]
  statics: Prim[]
  actors: Actor[]
  update(t: number): void
}

function nearJunction(v: number, margin: number): boolean {
  return Math.abs(v - nearestRoad(v)) < margin
}

export function buildScene(seed = 7): Scene {
  const rng = new Rng(seed)
  const statics: Prim[] = []

  // Buildings fill every block except the park at the centre of the loop.
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const x0 = i * PITCH + 11, x1 = (i + 1) * PITCH - 11
      const y0 = j * PITCH + 11, y1 = (j + 1) * PITCH - 11
      if (i === 0 && j === 0) continue
      const nx = rng.int(1, 3), ny = rng.int(1, 2)
      const wx = (x1 - x0) / nx, wy = (y1 - y0) / ny
      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < ny; b++) {
          if (rng.next() < 0.08) continue // empty lot
          const inset = rng.range(0, 2.5)
          const lx = wx - 3 - inset, ly = wy - 3 - inset
          const tall = rng.next() < 0.18
          const h = tall ? rng.range(32, 60) : rng.range(8, 24)
          const glass = rng.next() < (tall ? 0.6 : 0.12)
          statics.push(box(
            x0 + wx * (a + 0.5), y0 + wy * (b + 0.5), h / 2, lx, ly, h, 0,
            glass ? 0.12 : rng.range(0.24, 0.62), CLASS.building, glass,
          ))
        }
      }
    }
  }

  // The park: scattered trees, a pavilion, benches.
  const trees: Array<[number, number]> = []
  let guard = 0
  while (trees.length < 34 && guard++ < 2000) {
    const x = rng.range(14, PITCH - 14), y = rng.range(14, PITCH - 14)
    if (Math.abs(x - 40) < 8 && Math.abs(y - 40) < 7) continue
    if (trees.some(([tx, ty]) => Math.hypot(tx - x, ty - y) < 6)) continue
    trees.push([x, y])
  }
  statics.push(box(40, 40, 2.1, 9, 6.5, 4.2, 0.3, 0.5, CLASS.building))
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2
    statics.push(box(40 + Math.cos(a) * 12, 40 + Math.sin(a) * 12, 0.45, 1.7, 0.55, 0.9, a + Math.PI / 2, 0.35, CLASS.pole))
  }

  // Street trees, lamp posts and signs along both kerbs of every road.
  for (const line of ROAD_LINES) {
    for (const alongY of [true, false]) {
      for (const side of [-1, 1]) {
        let n = 0
        for (let s = MAP_MIN + 6; s < MAP_MAX; s += 8, n++) {
          if (nearJunction(s, 13)) continue
          const off = line + side * 9.3
          const x = alongY ? off : s, y = alongY ? s : off
          if (n % 4 === 2) {
            statics.push(cylinder(x, y, 0, 7.5, 0.09, 0.35, CLASS.pole))
            if (n % 8 === 2) {
              // retroreflective sign plate facing along the road
              statics.push(box(x, y, 2.5, 0.06, 0.7, 0.7, alongY ? Math.PI / 2 : 0, 2.6, CLASS.pole))
            }
          } else if (n % 2 === 0) {
            trees.push([x, y])
          }
        }
      }
    }
  }
  for (const [x, y] of trees) {
    const trunk = rng.range(2.4, 3.6), crown = rng.range(1.7, 2.7)
    statics.push(cylinder(x, y, 0, trunk + 0.4, rng.range(0.14, 0.24), 0.28, CLASS.vegetation))
    statics.push(sphere(x, y, trunk + crown * 0.85, crown, 0.52, CLASS.vegetation, 0.42))
  }

  // Parked cars along the kerbs.
  for (const line of ROAD_LINES) {
    for (const alongY of [true, false]) {
      for (const side of [-1, 1]) {
        for (let s = MAP_MIN + 4; s < MAP_MAX; s += 6.2) {
          if (nearJunction(s, 17) || rng.next() > 0.3) continue
          const off = line + side * 5.95
          const x = alongY ? off : s, y = alongY ? s : off
          const yaw = (alongY ? Math.PI / 2 : 0) + (side * (alongY ? 1 : -1) > 0 ? 0 : Math.PI)
          const c = Math.cos(yaw), sn = Math.sin(yaw)
          for (const p of carParts(rng).parts) {
            p.prim.cx = x + c * p.fx
            p.prim.cy = y + sn * p.fx
            p.prim.cos = c
            p.prim.sin = sn
            statics.push(p.prim)
          }
        }
      }
    }
  }

  const actors: Actor[] = []
  const add = (
    cls: number, shape: { parts: Part[]; l: number; w: number; h: number },
    alongY: boolean, line: number, lane: number, dir: 1 | -1, speed: number,
  ) => {
    actors.push({
      cls, parts: shape.parts, alongY, line, lane, dir, speed,
      s0: rng.range(MAP_MIN, MAP_MAX), x: 0, y: 0, yaw: 0,
      length: shape.l, width: shape.w, height: shape.h,
    })
  }
  const vehicle = () => {
    const r = rng.next()
    return r < 0.72
      ? { cls: CLASS.car, shape: carParts(rng) }
      : r < 0.9
        ? { cls: CLASS.truck, shape: truckParts(rng) }
        : { cls: CLASS.truck, shape: busParts(rng) }
  }

  // Oncoming lanes on the four loop roads (the ego keeps its own lane to itself).
  const oncoming: Array<[boolean, number, number, 1 | -1]> = [
    [true, 0, -3, -1],
    [false, 80, 3, -1],
    [true, 80, 3, 1],
    [false, 0, -3, 1],
  ]
  for (const [alongY, line, lane, dir] of oncoming) {
    for (let k = 0; k < 3; k++) {
      const v = vehicle()
      add(v.cls, v.shape, alongY, line, lane, dir, rng.range(6, 12.5))
    }
  }
  // Both lanes on the outer roads.
  for (const line of [-80, 160]) {
    for (const alongY of [true, false]) {
      for (const dir of [1, -1] as const) {
        const v = vehicle()
        const lane = alongY ? dir * 3 : -dir * 3
        add(v.cls, v.shape, alongY, line, lane, dir, rng.range(7, 13))
      }
    }
  }
  // Pedestrians on the pavements.
  for (let k = 0; k < 18; k++) {
    const h = rng.range(1.55, 1.9)
    const shape = {
      l: 0.5, w: 0.5, h,
      parts: [part(cylinder(0, 0, 0, h, rng.range(0.2, 0.26), rng.range(0.25, 0.55), CLASS.pedestrian), 0)],
    }
    add(
      CLASS.pedestrian, shape, rng.next() < 0.5, rng.pick([0, 80, 0, 80, -80, 160]),
      rng.pick([-1, 1]) * rng.range(7.8, 8.7), rng.pick([-1, 1] as const), rng.range(0.9, 1.7),
    )
  }
  // Cyclists riding against the loop on the far side of the loop roads.
  for (const [alongY, line, lane, dir] of oncoming) {
    const shape = {
      l: 1.75, w: 0.6, h: 1.75,
      parts: [
        part(box(0, 0, 0.55, 1.7, 0.45, 0.9, 0, 0.3, CLASS.cyclist), 0),
        part(cylinder(0, 0, 0.75, 1.75, 0.24, 0.4, CLASS.cyclist), -0.1),
      ],
    }
    add(CLASS.cyclist, shape, alongY, line, Math.sign(lane) * 4.75, dir, rng.range(3.5, 6))
  }

  const prims = [...statics]
  for (const a of actors) for (const p of a.parts) prims.push(p.prim)

  const scene: Scene = {
    prims,
    statics,
    actors,
    update(t) {
      for (const a of actors) placeActor(a, t)
    },
  }
  scene.update(0)
  return scene
}
