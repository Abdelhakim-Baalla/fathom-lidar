import type { Track } from '../perception/track'
import type { Frame } from '../protocol/frame'
import type { CameraPreset, Layers } from './cloud'
import type { ColorMode } from './palettes'

/** Common acquisition contract for the GPU and sampled software point views. */
export interface PointView {
  onSelect: (id: number | null) => void
  exhibitOf: (trackId: number) => number | undefined
  pointsHeld: number
  push(frame: Frame, truth: Uint8Array | null): void
  clear(): void
  setTracks(tracks: Track[], time: number): void
  setSelected(id: number | null): void
  setRunning(running: boolean): void
  setMaxRange(range: number): void
  setBeam(up: number, down: number): void
  setOutline(boxes: Float32Array | null): void
  setColorMode(mode: ColorMode): void
  setPointSize(size: number): void
  setPersistence(seconds: number): void
  setLayers(layers: Layers): void
  setCamera(camera: CameraPreset): void
  dispose(): void
}
