import { Rng } from '../sim/rng'

/**
 * Channel state information of one 2.4 GHz Wi-Fi link in a room, computed by
 * summing propagation paths per OFDM subcarrier:
 *
 *   H(f) = Σ a_p · exp(-j 2π f d_p / c)
 *
 * Paths are the direct line, the four first-order wall reflections (image
 * method) and one bistatic scatter path per person. A person near the direct
 * line also shadows it. A person standing still still breathes, which moves the
 * chest a few millimetres and the scatter path length with it.
 */

const C = 299_792_458
/** channel 6 */
export const CENTER_HZ = 2.437e9
export const SPACING_HZ = 312.5e3
/** HT20 data and pilot subcarriers, −28…28 without DC */
export const SUBCARRIERS = Array.from({ length: 57 }, (_, i) => i - 28).filter((k) => k !== 0)
const LAMBDA = C / CENTER_HZ

export interface Room {
  width: number
  depth: number
  tx: [number, number]
  rx: [number, number]
  door: [number, number]
}

export const ROOM: Room = { width: 8, depth: 6, tx: [0.6, 2.4], rx: [7.4, 3.4], door: [4.2, 6] }

const WALL_REFLECTION = 0.42
/** radar cross-section of an adult at 2.4 GHz, m² */
const BODY_RCS = 1.5

export interface Person {
  x: number
  y: number
  tx: number
  ty: number
  speed: number
  /** seconds left standing still */
  pause: number
  breathPhase: number
  inside: boolean
}

export interface CsiPacket {
  t: number
  rssi: number
  /** linear amplitude per subcarrier, arbitrary units */
  amp: Float32Array
}

export interface WifiSimConfig {
  people: number
  /** receiver noise, dB below the direct path */
  snrDb: number
}

export class WifiSim {
  readonly room = ROOM
  people: Person[] = []
  private rng = new Rng(11)
  private t = 0
  private cfg: WifiSimConfig = { people: 2, snrDb: 38 }

  constructor() {
    this.configure(this.cfg)
  }

  configure(cfg: WifiSimConfig): void {
    this.cfg = cfg
    while (this.people.length < cfg.people) this.people.push(this.spawn())
    this.people.length = cfg.people
  }

  private spawn(): Person {
    // Everyone enters through the door and wanders.
    const [dx, dy] = this.room.door
    return {
      x: dx, y: dy - 0.2, tx: this.rng.range(1, this.room.width - 1), ty: this.rng.range(1, this.room.depth - 1),
      speed: this.rng.range(0.9, 1.4), pause: this.rng.range(0, 2),
      breathPhase: this.rng.range(0, Math.PI * 2), inside: true,
    }
  }

  /** Advance by dt seconds and return one packet. */
  step(dt: number): CsiPacket {
    this.t += dt
    for (const p of this.people) this.move(p, dt)
    return { t: this.t, ...this.channel() }
  }

  private move(p: Person, dt: number): void {
    if (p.pause > 0) {
      p.pause -= dt
      return
    }
    const dx = p.tx - p.x, dy = p.ty - p.y
    const d = Math.hypot(dx, dy)
    if (d < 0.1) {
      // Arrived: stand for a while, then pick somewhere else in the room.
      p.pause = this.rng.next() < 0.35 ? this.rng.range(2, 8) : this.rng.range(0, 1)
      p.tx = this.rng.range(0.8, this.room.width - 0.8)
      p.ty = this.rng.range(0.8, this.room.depth - 0.8)
      return
    }
    const s = Math.min(d, p.speed * dt)
    p.x += (dx / d) * s
    p.y += (dy / d) * s
  }

  private channel(): { rssi: number; amp: Float32Array } {
    const { width: W, depth: D, tx, rx } = this.room
    const paths: Array<[number, number]> = [] // [length m, amplitude]
    const losLen = Math.hypot(rx[0] - tx[0], rx[1] - tx[1])

    // Shadowing of the direct line by anyone standing near it.
    let shadow = 1
    for (const p of this.people) {
      const off = distanceToSegment(p.x, p.y, tx, rx)
      shadow *= 1 - 0.55 * Math.exp(-((off / 0.28) ** 2))
    }
    paths.push([losLen, (shadow * LAMBDA) / (4 * Math.PI * losLen)])

    // First-order wall reflections: mirror the transmitter in each wall.
    const images: Array<[number, number]> = [[-tx[0], tx[1]], [2 * W - tx[0], tx[1]], [tx[0], -tx[1]], [tx[0], 2 * D - tx[1]]]
    for (const [ix, iy] of images) {
      const len = Math.hypot(rx[0] - ix, rx[1] - iy)
      paths.push([len, (WALL_REFLECTION * LAMBDA) / (4 * Math.PI * len)])
    }

    // Bistatic scatter off each person, directly and by way of each wall (the
    // transmitter's images again); breathing moves the chest by ±5 mm.
    const sources: Array<[number, number, number]> = [[tx[0], tx[1], 1], ...images.map(([x, y]): [number, number, number] => [x, y, WALL_REFLECTION])]
    for (const p of this.people) {
      const breath = 0.005 * Math.sin(2 * Math.PI * 0.25 * this.t + p.breathPhase)
      const d2 = Math.hypot(p.x - rx[0], p.y - rx[1])
      for (const [sx, sy, g] of sources) {
        const d1 = Math.hypot(p.x - sx, p.y - sy)
        const a = (g * LAMBDA * Math.sqrt(BODY_RCS)) / ((4 * Math.PI) ** 1.5 * d1 * d2)
        paths.push([d1 + d2 + 2 * breath, a])
      }
    }

    const los = paths[0][1] / shadow
    const noise = los * 10 ** (-this.cfg.snrDb / 20)
    // Automatic gain control moves the whole packet a little; real receivers do this.
    const agc = 10 ** (this.rng.gauss() * 0.4 / 20)
    const amp = new Float32Array(SUBCARRIERS.length)
    let power = 0
    SUBCARRIERS.forEach((k, i) => {
      const f = CENTER_HZ + k * SPACING_HZ
      let re = 0, im = 0
      for (const [len, a] of paths) {
        const ph = (-2 * Math.PI * f * len) / C
        re += a * Math.cos(ph)
        im += a * Math.sin(ph)
      }
      re += noise * this.rng.gauss() * Math.SQRT1_2
      im += noise * this.rng.gauss() * Math.SQRT1_2
      const m = Math.hypot(re, im) * agc
      amp[i] = m / los
      power += m * m
    })
    // 20 dBm transmitter; free-space amplitudes are relative to an isotropic 1 W source.
    const rssi = 20 + 10 * Math.log10(power / SUBCARRIERS.length)
    return { rssi, amp }
  }
}

function distanceToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0], vy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy)))
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy))
}
