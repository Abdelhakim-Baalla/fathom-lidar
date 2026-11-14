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
  ink: '#ebe5d6',
  scale: '#3b4348',
  exhibit: '#f2c230',
  seal: '#e0332f',
  radio: '#5b86ff',
  sound: '#ebe5d6',
  outline: '#8a9196',
  ramps: {
    // Near returns bright label-stock, far returns sink into the locker grey.
    range: ['#d9d3c4', '#a3b1b4', '#627985', '#34495a'],
    intensity: ['#2a3237', '#59656b', '#a3a69c', '#efe8d6'],
    height: ['#59656b', '#4f9a86', '#a8b85a', '#e1b248', '#e27c4a', '#d0503f'],
    ring: ['#ebe5d6', '#7f95a0'],
  },
  retro: '#f2c230',
  classes: {
    [CLASS.ground]: '#4a5257',
    [CLASS.building]: '#9aa9b2',
    [CLASS.vegetation]: '#4f9a86',
    [CLASS.pole]: '#c9a467',
    [CLASS.car]: '#5b86ff',
    [CLASS.truck]: '#e27c4a',
    [CLASS.pedestrian]: '#f2c230',
    [CLASS.cyclist]: '#3fc4bb',
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
