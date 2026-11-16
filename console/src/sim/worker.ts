/// <reference lib="webworker" />
import { detect } from '../perception/detect'
import { Tracker, type Track } from '../perception/track'
import { BOX, CLASS } from './scene'
import { DEFAULT_ENVIRONMENT, PRESETS, type Environment, type SensorConfig } from './sensor'
import { Simulator } from './simulator'

export type ToWorker =
  | { type: 'configure'; sensor: SensorConfig; env: Environment }
  | { type: 'run'; running: boolean }
  | { type: 'restart' }
  /** one revolution from another source (bridge, recording) to detect and track */
  | { type: 'perceive'; points: Float32Array; count: number; x: number; y: number; time: number; range: number }
  | { type: 'resetTracks'; epoch: number }

export type FromWorker =
  | { type: 'outline'; boxes: Float32Array }
  | { type: 'packet'; frame: ArrayBuffer; truth: Uint8Array; rays: number }
  | { type: 'tracks'; epoch: number; tracks: Track[]; time: number; ms: number; x: number; y: number }

const ctx = self as unknown as DedicatedWorkerGlobalScope
const post = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer)

let sensor: SensorConfig = PRESETS[1].config
let env: Environment = DEFAULT_ENVIRONMENT
let sim = new Simulator(sensor, env)
const tracker = new Tracker()
let epoch = 0
let running = false
let last = performance.now()

/** Building footprints, for the optional ground-truth outline: cx, cy, cz, hx, hy, hz, yaw each. */
function sendOutline(): void {
  const b = sim.scene.statics.filter((p) => p.kind === BOX && p.cls === CLASS.building)
  const out = new Float32Array(b.length * 7)
  b.forEach((p, i) => out.set([p.cx, p.cy, p.cz, p.hx, p.hy, p.hz, Math.atan2(p.sin, p.cos)], i * 7))
  post({ type: 'outline', boxes: out }, [out.buffer])
}

function perceive(points: Float32Array, count: number, x: number, y: number, time: number, range: number): void {
  const t0 = performance.now()
  const tracks = tracker.update(detect(points, count, x, y, range), time)
  post({ type: 'tracks', epoch, tracks, time, ms: performance.now() - t0, x, y })
}

function tick(): void {
  const now = performance.now()
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  if (!running || dt <= 0) return
  const p = sim.step(dt)
  if (p.revolutionEnded) {
    perceive(sim.revPoints, sim.revCount, sim.pose.x, sim.pose.y, sim.time, sensor.maxRange)
    sim.revCount = 0
  }
  const truth = p.truth.slice()
  post({ type: 'packet', frame: p.frame, truth, rays: p.rays }, [p.frame, truth.buffer])
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  if (m.type === 'configure') {
    sensor = m.sensor
    env = m.env
    sim.setSensor(sensor)
    sim.setEnvironment(env)
  } else if (m.type === 'run') {
    running = m.running
    last = performance.now()
  } else if (m.type === 'restart') {
    sim = new Simulator(sensor, env)
    tracker.reset()
    sendOutline()
  } else if (m.type === 'perceive') {
    perceive(m.points, m.count, m.x, m.y, m.time, m.range)
  } else if (m.type === 'resetTracks') {
    epoch = m.epoch
    tracker.reset()
  }
}

sendOutline()
setInterval(tick, 1000 / 60)
