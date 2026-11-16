import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { Engine } from './engine'
import { DEFAULT_ENVIRONMENT, PRESETS } from './sim/sensor'
import { Simulator } from './sim/simulator'
import type { FromWorker } from './sim/worker'
import type { CloudView } from './view/cloud'
import type { RangeImage } from './view/rangeImage'

class TestWorker {
  static current: TestWorker
  onmessage: ((event: { data: FromWorker }) => void) | null = null
  constructor() { TestWorker.current = this }
  postMessage = vi.fn()
  terminate = vi.fn()
}

let engine: Engine
const range = {
  setChannels: vi.fn(), setMaxRange: vi.fn(), setBeam: vi.fn(),
  setContacts: vi.fn(), push: vi.fn(),
}

beforeAll(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', TestWorker)
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  engine = (await import('./engine')).engine
})

afterAll(() => {
  engine.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function deliverPacket() {
  const packet = new Simulator(PRESETS[0].config, DEFAULT_ENVIRONMENT).step(0.01)
  TestWorker.current.onmessage!({ data: { type: 'packet', ...packet } })
}

it('keeps acquisition, controls and the range image working without a GPU view', () => {
  engine.attach(null, range as unknown as RangeImage)
  engine.useSimulator()
  engine.configure(PRESETS[0].config, DEFAULT_ENVIRONMENT)
  deliverPacket()
  expect(range.push).toHaveBeenCalledOnce()
  expect(engine.state.stats.receivedFrames).toBe(1)
  engine.setRunning(false)
  engine.setRunning(true)
  engine.restartSimulation()
  vi.advanceTimersByTime(500)
  expect(engine.state.stats.pointsHeld).toBe(0)
  expect(engine.state.stats.pointsPerSecond).toBeGreaterThan(0)
})

it('reattaches and detaches 3D without resetting acquisition or interrupting range frames', () => {
  engine.attach(null, range as unknown as RangeImage)
  engine.useSimulator()
  engine.configure(PRESETS[0].config, DEFAULT_ENVIRONMENT)
  const before = range.push.mock.calls.length
  const cloud = {
    exhibitOf: () => undefined,
    setOutline: vi.fn(), setMaxRange: vi.fn(), setBeam: vi.fn(),
    setRunning: vi.fn(), setTracks: vi.fn(), push: vi.fn(),
  }
  engine.setRunning(false)
  const received = engine.state.stats.receivedFrames
  engine.attachCloud(cloud as unknown as CloudView)
  expect(cloud.setRunning).toHaveBeenCalledWith(false)
  expect(cloud.setMaxRange).toHaveBeenCalledWith(PRESETS[0].config.maxRange)
  expect(engine.state.stats.receivedFrames).toBe(received)
  engine.setRunning(true)
  deliverPacket()
  expect(cloud.push).toHaveBeenCalledOnce()
  engine.attachCloud(null)
  deliverPacket()
  expect(cloud.push).toHaveBeenCalledOnce()
  expect(range.push).toHaveBeenCalledTimes(before + 2)
  expect(engine.state.stats.receivedFrames).toBe(received + 2)
})
