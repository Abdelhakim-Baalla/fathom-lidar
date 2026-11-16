import type { Track } from './perception/track'
/** A configurable distance rule, not a threat classifier or collision predictor. */
export function nearbyTracks(tracks: Track[], ego: { x: number; y: number }, radius: number): number[] {
  if (!Number.isFinite(radius) || radius <= 0) return []
  return tracks.filter(t => t.hits >= 8 && t.misses === 0 && Number.isFinite(t.x) && Number.isFinite(t.y) && Math.hypot(t.x - ego.x, t.y - ego.y) < radius).map(t => t.id)
}
