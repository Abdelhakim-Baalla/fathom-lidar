import { CLASS } from '../sim/scene'

export type ColorMode = 'range' | 'intensity' | 'height' | 'ring' | 'truth'

/**
 * Colours the canvases need. The shell reads the same values from CSS custom
 * properties in index.css; keep the two in step.
 */
export interface Palette {
  /** the scene's background: an unlit evidence room */
  ground: string
  ink: string
  /** range rings and distance marks */
  scale: string
  /** exhibits: markers, boxes, selection */
  exhibit: string
  /** recording, seals */
  seal: string
  /** Wi-Fi data */
  radio: string
  /** acoustic data */
  sound: string
  outline: string
  ramps: Record<Exclude<ColorMode, 'truth'>, string[]>
  /** retroreflector colour, used above intensity 100 */
  retro: string
  classes: Record<number, string>
}

export const PALETTE: Palette = {
  ground: '#090b0c',
  ink: '#f4f4f5',
  scale: '#3b4348',
  exhibit: '#f48142',
  seal: '#e06c55',
  radio: '#9eafc6',
  sound: '#f4f4f5',
  outline: '#8a9196',
  ramps: {
    // Near returns bright label-stock, far returns sink into the locker grey.
    range: ['#f4f4f5', '#c2c6cc', '#828995', '#414954'],
    intensity: ['#2b2d33', '#646972', '#b6bac1', '#f4f4f5'],
    height: ['#626975', '#a0a8b4', '#e0e2e6', '#ffbb8d', '#f48142', '#d4523b'],
    ring: ['#f4f4f5', '#7f95a0'],
  },
  retro: '#f48142',
  classes: {
    [CLASS.ground]: '#4a5257',
    [CLASS.building]: '#9aa9b2',
    [CLASS.vegetation]: '#8c859b',
    [CLASS.pole]: '#cfb5a3',
    [CLASS.car]: '#9eafc6',
    [CLASS.truck]: '#e27c4a',
    [CLASS.pedestrian]: '#f48142',
    [CLASS.cyclist]: '#d3c9ed',
    [CLASS.weather]: '#2e363b',
  },
}

export const CLASS_NAMES: Record<number, string> = {
  [CLASS.ground]: 'Ground',
  [CLASS.building]: 'Building',
  [CLASS.vegetation]: 'Vegetation',
  [CLASS.pole]: 'Pole or sign',
  [CLASS.car]: 'Car',
  [CLASS.truck]: 'Truck or bus',
  [CLASS.pedestrian]: 'Pedestrian',
  [CLASS.cyclist]: 'Cyclist',
  [CLASS.weather]: 'Droplet',
}

export function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 256-entry RGBA lookup for a colour mode; the shader and the range image share it. */
export function buildRamp(p: Palette, mode: ColorMode): Uint8Array {
  const out = new Uint8Array(256 * 4)
  if (mode === 'truth') {
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = hex(p.classes[i >> 4] ?? p.classes[CLASS.ground])
      out.set([r, g, b, 255], i * 4)
    }
    return out
  }
  const stops = p.ramps[mode].map(hex)
  // Intensity keeps the top fifth of the scale for retroreflectors.
  const span = mode === 'intensity' ? 204 : 255
  for (let i = 0; i < 256; i++) {
    let rgb: number[]
    if (mode === 'ring') {
      rgb = stops[i < 128 ? 0 : 1]
    } else if (i > span) {
      rgb = hex(p.retro)
    } else {
      const f = (i / span) * (stops.length - 1)
      const k = Math.min(stops.length - 2, Math.floor(f))
      const u = f - k
      rgb = [0, 1, 2].map((c) => stops[k][c] + (stops[k + 1][c] - stops[k][c]) * u)
    }
    out.set([rgb[0], rgb[1], rgb[2], 255], i * 4)
  }
  return out
}

/** A ramp sampled at t in 0..1, as an rgb() string, for 2D canvases. */
export function rampColor(stops: string[], t: number): [number, number, number] {
  const s = stops.map(hex)
  const f = Math.min(0.9999, Math.max(0, t)) * (s.length - 1)
  const k = Math.floor(f), u = f - k
  return [0, 1, 2].map((c) => Math.round(s[k][c] + (s[k + 1][c] - s[k][c]) * u)) as [number, number, number]
}

/** Top of the height scale, metres above the road. */
export const HEIGHT_MAX = 24
