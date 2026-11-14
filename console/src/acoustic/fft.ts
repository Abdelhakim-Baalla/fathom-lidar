/** In-place iterative radix-2 FFT. `re` and `im` have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
}

const hannCache = new Map<number, Float64Array>()
export function hann(n: number): Float64Array {
  let w = hannCache.get(n)
  if (!w) {
    w = new Float64Array(n)
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    hannCache.set(n, w)
  }
  return w
}

/**
 * Time difference of arrival between two channels by generalised cross-correlation
 * with phase transform (GCC-PHAT). Returns the lag in samples, positive when the
 * right channel hears the sound later, and the peak's height over the mean of the searched lags.
 */
export function gccPhat(left: Float32Array, right: Float32Array, maxLag: number): { lag: number; strength: number } {
  const n = left.length
  const w = hann(n)
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n)
  for (let i = 0; i < n; i++) { ar[i] = left[i] * w[i]; br[i] = right[i] * w[i] }
  fft(ar, ai)
  fft(br, bi)
  // conj(L) · R, whitened, so the peak sits at the lag of R relative to L
  for (let i = 0; i < n; i++) {
    const re = ar[i] * br[i] + ai[i] * bi[i]
    const im = ar[i] * bi[i] - ai[i] * br[i]
    const m = Math.hypot(re, im) || 1
    ar[i] = re / m
    ai[i] = im / m
  }
  fft(ar, ai, true)
  let best = 0, bestV = -Infinity, sum = 0
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = ar[(lag + n) % n]
    sum += Math.abs(v)
    if (v > bestV) { bestV = v; best = lag }
  }
  return { lag: best, strength: Math.max(0, bestV) / (sum / (2 * maxLag + 1) + 1e-12) }
}
