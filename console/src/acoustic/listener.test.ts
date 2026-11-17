import { afterEach, expect, it, vi } from 'vitest'
import { Listener } from './listener'

afterEach(() => vi.unstubAllGlobals())
it('releases a late permission grant when listening was stopped while waiting', async () => {
  let grant!: (stream: MediaStream) => void
  const stop = vi.fn()
  const pending = new Promise<MediaStream>(resolve => { grant = resolve })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pending } })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const listener = new Listener()
  const request = listener.start()
  expect(listener.state).toBe('asking')
  listener.stop()
  grant({ getTracks: () => [{ stop }] } as unknown as MediaStream)
  await request
  expect(stop).toHaveBeenCalledOnce()
  expect(listener.state).toBe('off')
})
