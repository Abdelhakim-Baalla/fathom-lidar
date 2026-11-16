import { expect, it } from 'vitest'
import { liveTrack } from './observation'
import type { Exhibit } from './exhibits'
import type { Track } from './perception/track'
it('never associates a historic observation with a reused tracker ID', () => {
  const e: Exhibit = { n: 1, kind: 'object', start: 0, end: 1, open: true, trackId: 1, sourceRun: 3 }
  const t = { id: 1 } as Track
  expect(liveTrack(e, [t], 4)).toBeNull()
  expect(liveTrack({ ...e, open: false }, [t], 3)).toBeNull()
  expect(liveTrack(e, [t], 3)).toBe(t)
})
