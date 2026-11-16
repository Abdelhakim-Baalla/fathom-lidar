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
  /** facade relief: 0 plain, 1 punched windows, 2 curtain wall, 3 shopfront */
  detail: number
}

function box(
  cx: number, cy: number, cz: number,
  lx: number, ly: number, lz: number,
  yaw: number, refl: number, cls: number, specular = false, detail = 0,
): Prim {
  const hx = lx / 2, hy = ly / 2
  return {
    kind: BOX, cx, cy, cz, hx, hy, hz: lz / 2,
    cos: Math.cos(yaw), sin: Math.sin(yaw),
    refl, cls, porosity: 0, specular, br: Math.hypot(hx, hy), detail,
  }
}

function cylinder(cx: number, cy: number, z0: number, z1: number, r: number, refl: number, cls: number): Prim {
  return {
    kind: CYLINDER, cx, cy, cz: (z0 + z1) / 2, hx: r, hy: r, hz: (z1 - z0) / 2,
    cos: 1, sin: 0, refl, cls, porosity: 0, specular: false, br: r, detail: 0,
  }
}

function sphere(cx: number, cy: number, cz: number, r: number, refl: number, cls: number, porosity: number): Prim {
  return {
    kind: SPHERE, cx, cy, cz, hx: r, hy: r, hz: r,
    cos: 1, sin: 0, refl, cls, porosity, specular: false, br: r, detail: 0,
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

/** Deterministic 0..1 noise for surface texture; cheap enough for every return. */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return n - Math.floor(n)
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
    const fine = hash2(x * 3.1, y * 3.1)
    const wear = hash2(x * 7.3, y * 5.9)
    if (across < 0.09) {
      // A worn centre line, not a perfect strip of vinyl.
      return wear > 0.09 ? 0.5 + fine * 0.14 : 0.13
    }
    if (across > 6.72 && across < 6.9) return wear > 0.08 ? 0.44 + fine * 0.12 : 0.12
    if (along > 9.5 && along < 12.5) {
      // Zebra crossing: 55 cm bars with ragged worn edges, separated by
      // asphalt. The wear is what keeps close range paint from blowing out.
      const bar = ((acrossPos % 1.1) + 1.1) % 1.1
      if (bar < 0.55 && wear > 0.14) return 0.43 + fine * 0.15
      return 0.095 + fine * 0.02
    }
    // Patched asphalt, wheel polish and the odd drain lid keep the road from
    // reading as one flat band of returns.
    const cell = hash2(Math.floor((onX ? x : y) / 3.2), Math.floor((onX ? y : x) / 3.2))
    let r = 0.085 + cell * 0.035 + fine * 0.012
    if (across > 2.4 && across < 4.6) r += 0.018 // polished wheel tracks
    if (hash2(Math.floor(x / 7.5), Math.floor(y / 7.5)) > 0.94) r += 0.12 // repair patch
    if (across > 5.2 && across < 5.75 && ((along * 0.5) % 1) < 0.22) r = 0.34 // drain grate
    return r
  }
  if (dx < WALK_OUTER || dy < WALK_OUTER) {
    // Concrete slabs: seams every 1.6 m along the kerb, a little staining.
    const along = dx < WALK_OUTER ? y : x
    const across = dx < WALK_OUTER ? x : y
    const seam = hash2(Math.floor(along / 1.6), Math.floor(across / 1.6))
    const edge = Math.abs((along / 1.6) % 1 - 0.5) > 0.47
    const grain = hash2(x * 5.3, y * 4.7)
    return edge ? 0.19 : 0.27 + seam * 0.07 + grain * 0.035
  }
  const park = x > 0 && x < PITCH && y > 0 && y < PITCH
  const mottled = hash2(x * 0.7, y * 0.7)
  if (park) {
    // A ring path and four radial walks give the park a plan, not just grass.
    // Paths are pale compacted gravel, so they read above the lawn.
    const pr = Math.hypot(x - 40, y - 40)
    if (pr < 5.6) return 0.58 + mottled * 0.1
    if (pr > 23.1 && pr < 25.3) return 0.56 + mottled * 0.1
    if (pr > 5.6 && pr < 25.3) {
      const ang = Math.atan2(y - 40, x - 40)
      const f = ((ang / (Math.PI / 2)) % 1 + 1) % 1
      if (Math.min(f, 1 - f) * (Math.PI / 2) * pr < 1.15) return 0.56 + mottled * 0.1
    }
    return 0.34 + mottled * 0.18
  }
  return 0.17 + mottled * 0.09
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

/** The elevation of a block that looks onto the nearest street. */
function streetFace(
  cx: number, cy: number, fx: number, fy: number,
): { nx: number; ny: number; x: number; y: number; len: number } | null {
  const hx = fx / 2, hy = fy / 2
  const faces = [
    { d: Math.abs(cx + hx - nearestRoad(cx + hx)), nx: 1, ny: 0, x: cx + hx, y: cy, len: fy },
    { d: Math.abs(cx - hx - nearestRoad(cx - hx)), nx: -1, ny: 0, x: cx - hx, y: cy, len: fy },
    { d: Math.abs(cy + hy - nearestRoad(cy + hy)), nx: 0, ny: 1, x: cx, y: cy + hy, len: fx },
    { d: Math.abs(cy - hy - nearestRoad(cy - hy)), nx: 0, ny: -1, x: cx, y: cy - hy, len: fx },
  ]
  faces.sort((a, b) => a.d - b.d)
  return faces[0].d < 30 ? faces[0] : null
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
          const glass = rng.next() < (tall ? 0.55 : 0.1)
          const cx = x0 + wx * (a + 0.5), cy = y0 + wy * (b + 0.5)
          const style = glass ? 2 : 1
          const refl = glass ? 0.13 : rng.range(0.22, 0.46)
          const shop = !glass && rng.next() < 0.45

          // A recessed shopfront under the upper floors: one strong eave line,
          // glazing that returns weakly, and a pavement that reads as covered.
          const base = shop ? 3.4 : 0
          if (shop) {
            statics.push(box(cx, cy, base / 2, lx - 0.7, ly - 0.7, base, 0, 0.13, CLASS.building, false, 3))
          }

          // Tall blocks step back as they rise, so the skyline is built from
          // real massing rather than one extruded rectangle.
          const tiers = tall ? 3 : 1
          let z0 = base
          let fx = lx, fy = ly
          for (let t = 0; t < tiers; t++) {
            const share = tiers === 1 ? 1 : t === 0 ? 0.52 : t === 1 ? 0.3 : 0.18
            const th = (h - base) * share
            statics.push(box(cx, cy, z0 + th / 2, fx, fy, th, 0, refl, CLASS.building, glass, style))
            z0 += th
            if (t < tiers - 1) {
              // A cornice slab marks the setback.
              statics.push(box(cx, cy, z0 + 0.09, fx + 0.5, fy + 0.5, 0.18, 0, 0.3, CLASS.building))
              fx *= 0.86
              fy *= 0.86
            }
          }

          // Parapet wall around the roof. Thin, tall and dark, it gives laser
          // returns the crisp roof edge that a bare box never has.
          if (h < 50) {
            const top = h + 0.45
            statics.push(box(cx, cy + fy / 2 - 0.12, top, fx, 0.24, 0.9, 0, 0.34, CLASS.building))
            statics.push(box(cx, cy - fy / 2 + 0.12, top, fx, 0.24, 0.9, 0, 0.34, CLASS.building))
            statics.push(box(cx + fx / 2 - 0.12, cy, top, 0.24, fy - 0.48, 0.9, 0, 0.34, CLASS.building))
            statics.push(box(cx - fx / 2 + 0.12, cy, top, 0.24, fy - 0.48, 0.9, 0, 0.34, CLASS.building))
          }

          // Rooftop plant: air handlers, a stair head, sometimes a mast.
          const units = rng.int(1, 2)
          for (let k = 0; k < units; k++) {
            const uw = rng.range(1.4, 3.2), ud = rng.range(1.2, 2.4), uh = rng.range(0.8, 1.8)
            statics.push(box(
              cx + rng.range(-fx * 0.28, fx * 0.28), cy + rng.range(-fy * 0.28, fy * 0.28), h + uh / 2,
              uw, ud, uh, 0, 0.3, CLASS.building,
            ))
          }
          if (h > 38) statics.push(cylinder(cx + fx * 0.2, cy - fy * 0.2, h, h + rng.range(5, 11), 0.07, 0.5, CLASS.pole))

          // Street-facing articulation: balconies, shop canopies and downpipes
          // are real geometry, so the scanner catches their undersides and
          // edges instead of reading a single flat facade plane.
          const face = streetFace(cx, cy, fx, fy)
          if (face) {
            const { nx, ny } = face
            const faceX = face.x, faceY = face.y
            const along = face.len
            if (shop) {
              const ax = faceX + nx * 0.75, ay = faceY + ny * 0.75
              statics.push(box(ax, ay, 3.62, nx ? 1.4 : 4.4, ny ? 1.4 : 4.4, 0.16, 0, 0.32, CLASS.building))
              // A pair of canvas awnings over the shopfront glazing.
              for (const s of [-1, 1]) {
                const ox = faceX + nx * 0.62 - (ny ? s * along * 0.24 : 0)
                const oy = faceY + ny * 0.62 + (nx ? s * along * 0.24 : 0)
                statics.push(box(ox, oy, 2.94, nx ? 1.25 : 3.1, ny ? 1.25 : 3.1, 0.1, 0, 0.46, CLASS.building))
              }
            }
            if (!glass && h < 34) {
              const floors = Math.min(6, Math.max(2, Math.floor((h - base) / 3.15)))
              for (let f = 2; f <= floors; f += 2) {
                for (const s of [-1, 1]) {
                  const z = base + f * 3.15 - 0.12
                  const off = 0.62
                  const ex = faceX + nx * off - (ny ? s * along * 0.22 : 0)
                  const ey = faceY + ny * off + (nx ? s * along * 0.22 : 0)
                  statics.push(box(ex, ey, z, nx ? 1.2 : 2.35, ny ? 1.2 : 2.35, 0.15, 0, 0.36, CLASS.building))
                  statics.push(box(
                    ex + nx * 0.56, ey + ny * 0.56, z + 0.55,
                    nx ? 0.06 : 2.35, ny ? 0.06 : 2.35, 0.95, 0, 0.22, CLASS.building,
                  ))
                }
              }
            }
            // Rainwater downpipes at the ends of the street elevation.
            for (const s of [-1, 1]) {
              const px = faceX + nx * 0.16 - (ny ? s * (along * 0.42) : 0)
              const py = faceY + ny * 0.16 + (nx ? s * (along * 0.42) : 0)
              statics.push(cylinder(px, py, 0, h, 0.075, 0.4, CLASS.building))
            }
          }
          if (h < 20 && rng.next() < 0.3) {
            // Rooftop water tank: a silhouette the skyline lacks otherwise.
            const tx = cx + rng.range(-fx * 0.2, fx * 0.2)
            const ty = cy + rng.range(-fy * 0.2, fy * 0.2)
            statics.push(cylinder(tx, ty, h, h + 2.2, 1.05, 0.3, CLASS.building))
          }
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

  // Raised pavements give every street a section: a 12 cm kerb, three metres of
  // concrete, then the building line. Without them a road is just a colour.
  const CUTS = [MAP_MIN, ...ROAD_LINES, MAP_MAX]
  for (const line of ROAD_LINES) {
    for (const alongY of [true, false]) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < CUTS.length - 1; k++) {
          const a = CUTS[k] + 11, b = CUTS[k + 1] - 11
          if (b - a < 12) continue
          const along = (a + b) / 2, span = b - a
          const off = line + side * (ROAD_HALF + 1.5)
          statics.push(box(
            alongY ? off : along, alongY ? along : off, 0.06,
            alongY ? 3 : span, alongY ? span : 3, 0.12,
            0, 0.3, CLASS.ground,
          ))
        }
      }
    }
  }

  // Traffic signals at the loop corners: a mast arm over the carriageway and
  // three retroreflective lenses. They are the brightest fixed returns in the
  // scene, exactly as they are to a real sensor.
  const signals: Array<[number, number, number]> = [
    [2.6, 2.6, 0], [77.4, 2.6, Math.PI / 2], [77.4, 77.4, Math.PI], [2.6, 77.4, -Math.PI / 2],
  ]
  for (const [sx, sy, yaw] of signals) {
    const c = Math.cos(yaw), s = Math.sin(yaw)
    statics.push(cylinder(sx, sy, 0, 6.2, 0.11, 0.32, CLASS.pole))
    // Arm reaches 5.2 m over the road, signal head at its end.
    statics.push(box(sx + c * 2.6, sy + s * 2.6, 6.05, 5.2, 0.14, 0.14, yaw, 0.32, CLASS.pole))
    const hx = sx + c * 5, hy = sy + s * 5
    statics.push(box(hx, hy, 5.55, 0.34, 0.3, 1.05, yaw, 0.22, CLASS.pole))
    for (let k = 0; k < 3; k++) {
      statics.push(box(hx + c * 0.19, hy + s * 0.19, 5.92 - k * 0.32, 0.06, 0.2, 0.24, yaw, 2.4, CLASS.pole))
    }
  }

  // A bus shelter on the park side, and small street furniture that catches
  // the beam at close range.
  {
    const sx = 11.4, sy = 43
    statics.push(box(sx, sy, 2.62, 1.7, 5.2, 0.12, 0, 0.34, CLASS.building))
    statics.push(box(sx + 0.7, sy - 2.3, 1.3, 0.12, 0.12, 2.6, 0, 0.32, CLASS.pole))
    statics.push(box(sx + 0.7, sy + 2.3, 1.3, 0.12, 0.12, 2.6, 0, 0.32, CLASS.pole))
    statics.push(box(sx + 0.8, sy, 1.45, 0.06, 4.8, 1.7, 0, 0.1, CLASS.building, false, 3))
    statics.push(box(sx - 0.1, sy, 0.48, 0.5, 3.4, 0.09, 0, 0.3, CLASS.pole))
  }
  const bins: Array<[number, number]> = [[10.2, 5.6], [9.8, 74.2], [70.4, 9.8], [74.6, 70.2], [14, 41.8]]
  for (const [bx, by] of bins) {
    statics.push(cylinder(bx, by, 0, 0.95, 0.26, 0.28, CLASS.pole))
    statics.push(cylinder(bx, by, 0.95, 1.02, 0.3, 0.2, CLASS.pole))
  }
  const hydrants: Array<[number, number]> = [[-6.2, 34], [86.2, 46], [34, -6.4], [46, 86.4]]
  for (const [hx, hy] of hydrants) {
    statics.push(cylinder(hx, hy, 0, 0.72, 0.17, 0.55, CLASS.pole))
    statics.push(sphere(hx, hy, 0.76, 0.17, 0.5, CLASS.pole, 0))
  }
  // Park benches, and bollards along the crossings.
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.25
    const bx = 40 + Math.cos(a) * 17.5, by = 40 + Math.sin(a) * 17.5
    const yaw = a + Math.PI / 2
    const c = Math.cos(yaw), s = Math.sin(yaw)
    statics.push(box(bx, by, 0.46, 0.58, 1.9, 0.08, yaw, 0.34, CLASS.pole))
    statics.push(box(bx - s * 0.28, by + c * 0.28, 0.76, 0.06, 1.9, 0.5, yaw, 0.34, CLASS.pole))
    statics.push(cylinder(bx + c * 0.7 - s * 0.22, by + s * 0.7 + c * 0.22, 0, 0.45, 0.05, 0.3, CLASS.pole))
    statics.push(cylinder(bx - c * 0.7 - s * 0.22, by - s * 0.7 + c * 0.22, 0, 0.45, 0.05, 0.3, CLASS.pole))
  }
  for (const [jx, jy] of [[3, 3], [77, 3], [77, 77], [3, 77]]) {
    for (let k = 0; k < 5; k++) {
      const bx = jx + (k - 2) * 1.6
      statics.push(cylinder(bx, jy + (jy < 40 ? -10.6 : 10.6), 0, 0.85, 0.09, 0.42, CLASS.pole))
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
