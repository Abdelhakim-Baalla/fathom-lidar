import { CLASS } from '../sim/scene'

export type PaletteId = 'day' | 'dusk' | 'night'
export type ColorMode = 'range' | 'intensity' | 'height' | 'ring' | 'truth'

/** Colours the 3D view needs; the shell reads the same values from CSS custom properties. */
export interface Palette {
  water: string
  ink: string
  contour: string
  /** depth tints, nearest band first */
  tints: string[]
  computed: string
  outline: string
  ramps: Record<Exclude<ColorMode, 'truth'>, string[]>
  /** retroreflector colour, used above intensity 100 */
  retro: string
  classes: Record<number, string>
}

const light: Pick<Palette, 'ramps' | 'retro' | 'classes'> = {
  ramps: {
    range: ['#0a2b45', '#1b5f8c', '#3f8fb5', '#7fb2c8'],
    intensity: ['#bdb7a2', '#8b8d85', '#48545e', '#121c26'],
    height: ['#66757c', '#2c7a52', '#84952a', '#bf8a18', '#a34e28', '#6c281b'],
    ring: ['#14202b', '#2b7fb8'],
  },
  retro: '#c27700',
  classes: {
    [CLASS.ground]: '#a3a79f',
    [CLASS.building]: '#2c4a63',
    [CLASS.vegetation]: '#2c7a52',
    [CLASS.pole]: '#7a5a2a',
    [CLASS.car]: '#1d66a8',
    [CLASS.truck]: '#c2571a',
    [CLASS.pedestrian]: '#c0262d',
    [CLASS.cyclist]: '#0e8686',
    [CLASS.weather]: '#cbc5b2',
  },
}

const dark: Pick<Palette, 'ramps' | 'retro' | 'classes'> = {
  ramps: {
    range: ['#e9f5fa', '#8cc6e2', '#4390b6', '#28607f'],
    intensity: ['#2c3943', '#5f6c72', '#a9a896', '#f4ecd6'],
    height: ['#74838a', '#4db583', '#b7c84c', '#f0b93c', '#e27c4a', '#cf5a42'],
    ring: ['#efe7cf', '#5aa9d6'],
  },
  retro: '#ffc34d',
  classes: {
    [CLASS.ground]: '#5a676d',
    [CLASS.building]: '#8fb4d1',
    [CLASS.vegetation]: '#4db583',
    [CLASS.pole]: '#c9a467',
    [CLASS.car]: '#5aa9e6',
    [CLASS.truck]: '#f0894a',
    [CLASS.pedestrian]: '#ff6b6b',
    [CLASS.cyclist]: '#3fd0c9',
    [CLASS.weather]: '#3d4a52',
  },
}

export const PALETTES: Record<PaletteId, Palette> = {
  day: {
    water: '#f6f8f3', ink: '#14202b', contour: '#2b6f96',
    tints: ['#b5d6e9', '#c9e1ee', '#dcecf2', '#eaf3f4'],
    computed: '#a61b82', outline: '#14202b', ...light,
  },
  dusk: {
    water: '#1c2730', ink: '#ece4cc', contour: '#6aa6c6',
    tints: ['#25485f', '#223f52', '#203746', '#1e2f3b'],
    computed: '#f472c8', outline: '#ece4cc', ...dark,
  },
  night: {
    water: '#070c10', ink: '#cfc8b0', contour: '#3f7896',
    tints: ['#0f2c3d', '#0d2432', '#0b1c27', '#09151d'],
    computed: '#e65cb8', outline: '#cfc8b0', ...dark,
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

function hex(c: string): [number, number, number] {
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

/** Top of the height scale, metres above the road. */
export const HEIGHT_MAX = 24
