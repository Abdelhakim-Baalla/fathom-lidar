/** Small seeded generator (mulberry32) so scenes and noise are reproducible. */
export class Rng {
  private s: number
  private spare: number | null = null

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1))
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]
  }

  /** Standard normal (Box–Muller, cached pair). */
  gauss(): number {
    if (this.spare !== null) {
      const v = this.spare
      this.spare = null
      return v
    }
    let u = 0
    while (u < 1e-12) u = this.next()
    const r = Math.sqrt(-2 * Math.log(u))
    const a = 2 * Math.PI * this.next()
    this.spare = r * Math.sin(a)
    return r * Math.cos(a)
  }
}
