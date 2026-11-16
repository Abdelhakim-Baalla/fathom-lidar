import type { SoundEvent } from './acoustic/analyse'

export type ExhibitKind = 'object' | 'wifi' | 'sound' | 'recording'

export interface Seal {
  name: string
  sha256: string
  bytes: number
  frames: number
  seconds: number
  sealedAt: string
}

/**
 * One numbered item in the register. Numbers run across every sensor in the
 * order things were confirmed, the way a scene's markers are numbered.
 * Times are seconds on the session clock.
 */
export interface Exhibit {
  source?: 'simulation' | 'sensor' | 'replay' | 'microphone'
  sourceRun?: number
  n: number
  kind: ExhibitKind
  start: number
  end: number
  open: boolean
  trackId?: number
  /** the class the track had when last seen, for closed object exhibits */
  cls?: number
  /** last known position of an object, metres in the odometry frame */
  at?: { x: number; y: number }
  sound?: SoundEvent
  wifi?: { peak: number; source: 'simulated' | 'esp32' }
  seal?: Seal
}

/** The session clock: seconds since the page opened. Shared by every sensor. */
const T0 = performance.now()
export const clock = (): number => (performance.now() - T0) / 1000
