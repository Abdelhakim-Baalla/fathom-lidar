/** Everything about the modelled sensor and the air it looks through. */
export interface SensorConfig {
  /** number of beams stacked vertically */
  channels: number
  /** upper and lower edge of the vertical field of view, degrees */
  fovUp: number
  fovDown: number
  /** rotation rate, revolutions per second */
  rateHz: number
  /** firing columns per second; fixed by the laser, so a faster spin means coarser azimuth steps */
  columnRate: number
  /** range at which a 10 % diffuse target is still detected in clear air, metres */
  range10: number
  /** hard instrumented limits, metres */
  minRange: number
  maxRange: number
  /** one-sigma range noise, metres */
  rangeNoise: number
  /** height of the optical centre above the road, metres */
  mountHeight: number
}

export type Weather = 'clear' | 'rain' | 'fog'

export interface Environment {
  weather: Weather
  /** ego speed along the loop, m/s; 0 parks the vehicle */
  egoSpeed: number
}

export interface SensorPreset {
  id: string
  name: string
  config: SensorConfig
}

const base = { columnRate: 18000, minRange: 0.9, mountHeight: 1.9, rangeNoise: 0.02 }

/** Generic beam layouts in the shape of common spinning sensors; not vendor models. */
export const PRESETS: SensorPreset[] = [
  { id: 'c16', name: '16 channels, ±15°', config: { ...base, channels: 16, fovUp: 15, fovDown: -15, rateHz: 10, range10: 60, maxRange: 100 } },
  { id: 'c32', name: '32 channels, +15° to −25°', config: { ...base, channels: 32, fovUp: 15, fovDown: -25, rateHz: 10, range10: 80, maxRange: 120 } },
  { id: 'c64', name: '64 channels, +11° to −25°', config: { ...base, channels: 64, fovUp: 11, fovDown: -25, rateHz: 10, range10: 90, maxRange: 120 } },
  { id: 'c128', name: '128 channels, +15° to −25°', config: { ...base, channels: 128, fovUp: 15, fovDown: -25, rateHz: 10, range10: 100, maxRange: 120 } },
]

export const DEFAULT_ENVIRONMENT: Environment = { weather: 'clear', egoSpeed: 8 }

/** Beam elevations in radians, lowest first, evenly spread over the field of view. */
export function beamElevations(c: SensorConfig): Float32Array {
  const out = new Float32Array(c.channels)
  for (let i = 0; i < c.channels; i++) {
    const f = c.channels === 1 ? 0.5 : i / (c.channels - 1)
    out[i] = ((c.fovDown + (c.fovUp - c.fovDown) * f) * Math.PI) / 180
  }
  return out
}

/** Azimuth step between firing columns, degrees. */
export function azimuthStepDeg(c: SensorConfig): number {
  return (360 * c.rateHz) / c.columnRate
}

export function pointsPerSecond(c: SensorConfig): number {
  return c.channels * c.columnRate
}

/** Two-way extinction coefficient (1/m) and chance of a droplet return per ray. */
export function atmosphere(w: Weather): { alpha: number; backscatter: number; meanDepth: number } {
  if (w === 'rain') return { alpha: 0.004, backscatter: 0.012, meanDepth: 9 }
  if (w === 'fog') return { alpha: 0.016, backscatter: 0.05, meanDepth: 5 }
  return { alpha: 0, backscatter: 0, meanDepth: 1 }
}
