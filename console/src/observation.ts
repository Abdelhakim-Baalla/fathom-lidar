import type { Exhibit } from './exhibits'
import type { Track } from './perception/track'
/** Tracker IDs repeat after reset. Only active-run, open observations may resolve them. */
export function liveTrack(exhibit: Exhibit | null, tracks: Track[], sourceRun: number): Track | null {
  if (!exhibit || exhibit.kind !== 'object' || !exhibit.open || exhibit.sourceRun !== sourceRun) return null
  return tracks.find(t => t.id === exhibit.trackId) ?? null
}
