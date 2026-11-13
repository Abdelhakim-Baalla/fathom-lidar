import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { engine } from './engine'
import type { Track } from './perception/track'
import { CLASS } from './sim/scene'
import {
  azimuthStepDeg,
  DEFAULT_ENVIRONMENT,
  pointsPerSecond,
  PRESETS,
  type Environment,
  type SensorConfig,
  type Weather,
} from './sim/sensor'
import { CloudView, trackName, type CameraPreset, type Layers } from './view/cloud'
import { CLASS_NAMES, PALETTES, type ColorMode, type PaletteId } from './view/palettes'
import { RangeImage } from './view/rangeImage'

function useEngine() {
  return useSyncExternalStore((fn) => engine.subscribe(fn), () => engine.state)
}

function stored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode: the choice lasts for this visit */
  }
}

const fmt = new Intl.NumberFormat('en-GB')
const fmt1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

const COLOR_MODES: Array<{ id: ColorMode; label: string; legend: [string, string] }> = [
  { id: 'range', label: 'Range', legend: ['near', 'far'] },
  { id: 'intensity', label: 'Intensity', legend: ['dark', 'bright · reflector'] },
  { id: 'height', label: 'Height', legend: ['road', '24 m'] },
  { id: 'ring', label: 'Channel', legend: ['even', 'odd'] },
  { id: 'truth', label: 'Ground truth', legend: ['', ''] },
]

const TRUTH_KEYS = [CLASS.ground, CLASS.building, CLASS.vegetation, CLASS.pole, CLASS.car, CLASS.truck, CLASS.pedestrian, CLASS.cyclist]

type SortKey = 'id' | 'cls' | 'range' | 'speed'

export default function App() {
  const s = useEngine()
  const [palette, setPalette] = useState<PaletteId>(() => stored('fathom.palette', 'day', ['day', 'dusk', 'night'] as const))
  const [presetId, setPresetId] = useState('c32')
  const [sensor, setSensor] = useState<SensorConfig>(PRESETS[1].config)
  const [env, setEnv] = useState<Environment>(DEFAULT_ENVIRONMENT)
  const [mode, setMode] = useState<ColorMode>('range')
  const [pointSize, setPointSize] = useState(2.2)
  const [held, setHeld] = useState(1)
  const [layers, setLayers] = useState<Layers>({ contours: true, tracks: true, sweep: true, outline: false })
  const [camera, setCamera] = useState<CameraPreset>('chase')
  const [selected, setSelected] = useState<number | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'range', dir: 1 })
  const [bridgeUrl, setBridgeUrl] = useState('ws://127.0.0.1:8765')
  const [fileError, setFileError] = useState('')

  const canvas = useRef<HTMLCanvasElement>(null)
  const labels = useRef<HTMLDivElement>(null)
  const rangeCanvas = useRef<HTMLCanvasElement>(null)
  const views = useRef<{ cloud: CloudView; range: RangeImage } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const cloud = new CloudView(canvas.current!, labels.current!)
    const range = new RangeImage(rangeCanvas.current!)
    views.current = { cloud, range }
    engine.attach(cloud, range)
    cloud.onSelect = setSelected
    return () => {
      engine.detach()
      cloud.dispose()
      range.dispose()
      views.current = null
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.palette = palette
    store('fathom.palette', palette)
    views.current?.cloud.setPalette(palette)
    views.current?.range.setPalette(palette)
  }, [palette])

  useEffect(() => engine.configure(sensor, env), [sensor, env])
  useEffect(() => views.current?.cloud.setColorMode(mode), [mode])
  useEffect(() => views.current?.cloud.setPointSize(pointSize), [pointSize])
  useEffect(() => views.current?.cloud.setPersistence(held / sensor.rateHz + 0.02), [held, sensor.rateHz])
  useEffect(() => views.current?.cloud.setLayers(layers), [layers])
  useEffect(() => views.current?.cloud.setCamera(camera), [camera])
  useEffect(() => views.current?.cloud.setSelected(selected), [selected])

  // A selection disappears with its track.
  const selectedTrack = s.tracks.find((t) => t.id === selected) ?? null
  useEffect(() => {
    if (selected !== null && !s.tracks.some((t) => t.id === selected)) {
      const id = window.setTimeout(() => setSelected(null), 1200)
      return () => clearTimeout(id)
    }
  }, [s.tracks, selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, select, textarea, button')) return
      if (e.key === ' ') {
        e.preventDefault()
        engine.setRunning(!engine.state.running)
      } else if (e.key === 'Escape') setSelected(null)
      else if (e.key === '1') setCamera('chase')
      else if (e.key === '2') setCamera('chart')
      else if (e.key === '3') setCamera('side')
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const rows = useMemo(() => {
    const withRange = s.tracks.map((t) => ({
      t,
      range: Math.hypot(t.x - s.ego.x, t.y - s.ego.y),
      speed: Math.hypot(t.vx, t.vy),
    }))
    const k = sort.key
    withRange.sort((a, b) => {
      const v =
        k === 'id' ? a.t.id - b.t.id
        : k === 'cls' ? CLASS_NAMES[a.t.cls].localeCompare(CLASS_NAMES[b.t.cls])
        : k === 'range' ? a.range - b.range
        : a.speed - b.speed
      return v * sort.dir
    })
    return withRange
  }, [s.tracks, s.ego, sort])

  const choosePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!
    setPresetId(id)
    setSensor((cur) => ({ ...p.config, rateHz: cur.rateHz, rangeNoise: cur.rangeNoise, maxRange: Math.min(cur.maxRange, p.config.maxRange) }))
  }

  const toggleRecord = () => {
    if (!s.recording) {
      engine.startRecording()
      return
    }
    const blob = engine.stopRecording()
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `fathom-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.fthm`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  const openFile = async (f: File | undefined) => {
    if (!f) return
    setFileError((await engine.openRecording(f)) ?? '')
  }

  const sim = s.source === 'simulator'
  const legend = COLOR_MODES.find((m) => m.id === mode)!
  const sourceLabel =
    s.source === 'simulator' ? 'Simulated sensor'
    : s.source === 'bridge' ? bridgeStatus(s.bridge)
    : `Recording · ${s.replay?.name ?? ''}`

  return (
    <div className="console">
      <header className="bar">
        <span className="wordmark">Fathom</span>
        <span className={`source source--${s.source === 'bridge' ? s.bridge : 'ok'}`}>
          <span className="source__dot" aria-hidden />
          {sourceLabel}
        </span>
        {s.stats.simulated && <span className="badge">Simulated data</span>}
        <dl className="readout">
          <div><dt>Points per second</dt><dd>{fmt.format(Math.round(s.stats.pointsPerSecond / 100) * 100)}</dd></div>
          {sim && <div><dt>Return rate</dt><dd>{Math.round(s.stats.returnRate * 100)} %</dd></div>}
          <div><dt>Revolutions</dt><dd>{fmt1.format(s.stats.revolutionsPerSecond)} Hz</dd></div>
          <div><dt>Perception</dt><dd>{Math.round(s.stats.perceptionMs)} ms</dd></div>
        </dl>
        <fieldset className="seg seg--bar" aria-label="Chart palette">
          {(['day', 'dusk', 'night'] as const).map((p) => (
            <label key={p}>
              <input type="radio" name="palette" checked={palette === p} onChange={() => setPalette(p)} />
              <span>{p[0].toUpperCase() + p.slice(1)}</span>
            </label>
          ))}
        </fieldset>
      </header>

      <aside className="rail" aria-label="Sensor and display settings">
        <section>
          <h2>Source</h2>
          <fieldset className="seg" aria-label="Data source">
            <label><input type="radio" name="source" checked={s.source === 'simulator'} onChange={() => engine.useSimulator()} /><span>Simulator</span></label>
            <label><input type="radio" name="source" checked={s.source === 'bridge'} onChange={() => engine.connectBridge(bridgeUrl)} /><span>Bridge</span></label>
            <label><input type="radio" name="source" checked={s.source === 'recording'} onChange={() => fileInput.current?.click()} /><span>Recording</span></label>
          </fieldset>
          {s.source === 'bridge' && (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); engine.connectBridge(bridgeUrl) }}>
              <label className="field">
                <span>Bridge address</span>
                <input value={bridgeUrl} onChange={(e) => setBridgeUrl(e.target.value)} spellCheck={false} />
              </label>
              <button type="submit" className="btn">Connect</button>
              <p className={`note ${s.bridge === 'error' || s.bridge === 'closed' ? 'note--warn' : ''}`} role="status">
                {s.bridge === 'error' || s.bridge === 'closed'
                  ? <>{s.bridgeMessage}. Start it with <code>uv run fathom-bridge</code> in <code>bridge/</code>.</>
                  : s.bridge === 'open' ? 'Receiving frames from the bridge.' : 'Connecting…'}
              </p>
            </form>
          )}
          {s.source === 'recording' && s.replay && (
            <p className="note">{fmt.format(s.replay.frames)} frames. Scrub in the strip below.</p>
          )}
          {fileError && <p className="note note--warn" role="alert">{fileError}</p>}
          <input ref={fileInput} type="file" accept=".fthm" hidden onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = '' }} />
        </section>

        <section aria-disabled={!sim}>
          <h2>Sensor</h2>
          <label className="field">
            <span>Beam layout</span>
            <select value={presetId} onChange={(e) => choosePreset(e.target.value)} disabled={!sim}>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <Slider label="Rotation rate" value={sensor.rateHz} min={5} max={20} step={1} unit="Hz" disabled={!sim}
            hint={`${fmt1.format(azimuthStepDeg(sensor))}° between columns`}
            onChange={(v) => setSensor({ ...sensor, rateHz: v })} />
          <Slider label="Maximum range" value={sensor.maxRange} min={40} max={200} step={10} unit="m" disabled={!sim}
            onChange={(v) => setSensor({ ...sensor, maxRange: v })} />
          <Slider label="Range noise, 1σ" value={Math.round(sensor.rangeNoise * 100)} min={0} max={15} step={1} unit="cm" disabled={!sim}
            onChange={(v) => setSensor({ ...sensor, rangeNoise: v / 100 })} />
          <p className="note">{fmt.format(pointsPerSecond(sensor))} rays per second at {sensor.channels} channels.</p>
        </section>

        <section aria-disabled={!sim}>
          <h2>Environment</h2>
          <fieldset className="seg" aria-label="Weather" disabled={!sim}>
            {(['clear', 'rain', 'fog'] as Weather[]).map((w) => (
              <label key={w}><input type="radio" name="weather" checked={env.weather === w} onChange={() => setEnv({ ...env, weather: w })} /><span>{w[0].toUpperCase() + w.slice(1)}</span></label>
            ))}
          </fieldset>
          <Slider label="Vehicle speed" value={Math.round(env.egoSpeed * 3.6)} min={0} max={50} step={5} unit="km/h" disabled={!sim}
            onChange={(v) => setEnv({ ...env, egoSpeed: v / 3.6 })} />
        </section>

        <section>
          <h2>Display</h2>
          <label className="field">
            <span>Colour points by</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as ColorMode)}>
              {COLOR_MODES.filter((m) => m.id !== 'truth' || sim).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          {mode === 'truth' ? (
            <ul className="key">
              {TRUTH_KEYS.map((c) => (
                <li key={c}><i style={{ background: PALETTES[palette].classes[c] }} />{CLASS_NAMES[c]}</li>
              ))}
            </ul>
          ) : (
            <div className="ramp">
              <div className="ramp__bar" style={{ background: rampCss(palette, mode) }} />
              <div className="ramp__ends"><span>{legend.legend[0]}</span><span>{legend.legend[1]}</span></div>
            </div>
          )}
          <Slider label="Revolutions held" value={held} min={1} max={10} step={1} unit="" onChange={setHeld} />
          <Slider label="Point size" value={pointSize} min={1} max={5} step={0.2} unit="px" onChange={setPointSize} decimals={1} />
          <div className="checks">
            <Check label="Range contours" checked={layers.contours} onChange={(v) => setLayers({ ...layers, contours: v })} />
            <Check label="Tracked objects" checked={layers.tracks} onChange={(v) => setLayers({ ...layers, tracks: v })} />
            <Check label="Scan line" checked={layers.sweep} onChange={(v) => setLayers({ ...layers, sweep: v })} />
            {sim && <Check label="Building outlines" checked={layers.outline} onChange={(v) => setLayers({ ...layers, outline: v })} />}
          </div>
        </section>
      </aside>

      <main className="view" aria-label="Point cloud">
        <canvas ref={canvas} tabIndex={0} aria-label="3D point cloud. Drag to orbit, scroll to zoom, arrow keys also orbit." />
        <div ref={labels} className="labels" aria-hidden />
        <fieldset className="seg seg--float" aria-label="Camera">
          {([['chase', 'Chase'], ['chart', 'Chart'], ['side', 'Side']] as const).map(([id, label], i) => (
            <label key={id} title={`Key ${i + 1}`}><input type="radio" name="camera" checked={camera === id} onChange={() => setCamera(id)} /><span>{label}</span></label>
          ))}
        </fieldset>
        {s.source === 'bridge' && s.bridge !== 'open' && (
          <div className="empty" role="status">
            <p className="empty__title">{s.bridge === 'connecting' ? 'Waiting for the bridge' : 'No frames from the bridge'}</p>
            <p>Run <code>uv run fathom-bridge --source synthetic</code> for a test room, or <code>--source udp</code> with a VLP-16 on the network.</p>
          </div>
        )}
      </main>

      <aside className="panel" aria-label="Tracked objects">
        <div className="panel__head">
          <h2>Tracked objects</h2>
          <span className="count">{s.tracks.length}</span>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <SortHead k="id" label="Track" sort={sort} setSort={setSort} />
                <SortHead k="cls" label="Class" sort={sort} setSort={setSort} />
                <SortHead k="range" label="Range" sort={sort} setSort={setSort} num />
                <SortHead k="speed" label="Speed" sort={sort} setSort={setSort} num />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ t, range, speed }) => (
                <tr key={t.id} aria-selected={t.id === selected} onClick={() => setSelected(t.id === selected ? null : t.id)}>
                  <td><button className="rowbtn" onClick={(e) => { e.stopPropagation(); setSelected(t.id === selected ? null : t.id) }}>{trackName(t.id)}</button></td>
                  <td>{CLASS_NAMES[t.cls]}</td>
                  <td className="num">{fmt1.format(range)} m</td>
                  <td className="num">{speed < 0.5 ? 'still' : `${Math.round(speed * 3.6)} km/h`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="note pad">
              {s.running
                ? 'Objects appear here after three revolutions in a row agree on them.'
                : 'Paused. Resume the scan to track objects.'}
            </p>
          )}
        </div>
        <Detail track={selectedTrack} ego={s.ego} onClose={() => setSelected(null)} />
      </aside>

      <footer className="strip">
        <div className="transport">
          <button className="btn btn--primary" onClick={() => engine.setRunning(!s.running)} aria-keyshortcuts="Space">
            {s.running ? 'Pause scan' : 'Resume scan'}
          </button>
          <button className={`btn ${s.recording ? 'btn--rec' : ''}`} onClick={toggleRecord} disabled={s.source === 'recording'}>
            {s.recording ? `Stop and save · ${fmt1.format(s.recordedSeconds)} s` : 'Record'}
          </button>
          {sim && <button className="btn btn--quiet" onClick={() => engine.restartSimulation()}>Restart drive</button>}
          {s.replay && (
            <label className="scrub">
              <span className="sr">Recording position</span>
              <input type="range" min={0} max={s.replay.frames - 1} value={s.replay.index}
                onChange={(e) => engine.seekReplay(Number(e.target.value))} />
              <span className="num">{fmt.format(s.replay.index + 1)} / {fmt.format(s.replay.frames)}</span>
            </label>
          )}
        </div>
        <figure className="rangeimg">
          <canvas ref={rangeCanvas} aria-label="Range image: one row per channel, one column per bearing" />
          <figcaption>
            <span>Range image · {sensor.channels} channels × 360°</span>
            <span className="num">frame {fmt.format(s.stats.frameId)} · t {fmt1.format(s.stats.time)} s</span>
          </figcaption>
        </figure>
      </footer>
    </div>
  )
}

function bridgeStatus(b: string): string {
  if (b === 'open') return 'Bridge connected'
  if (b === 'connecting') return 'Connecting to bridge'
  return 'Bridge offline'
}

function rampCss(p: PaletteId, mode: ColorMode): string {
  const pal = PALETTES[p]
  if (mode === 'ring') return `linear-gradient(90deg, ${pal.ramps.ring[0]} 50%, ${pal.ramps.ring[1]} 50%)`
  if (mode === 'intensity') return `linear-gradient(90deg, ${pal.ramps.intensity.join(', ')} 80%, ${pal.retro} 80%)`
  const stops = pal.ramps[mode as 'range' | 'height']
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

function Slider(props: {
  label: string; value: number; min: number; max: number; step: number; unit: string
  onChange: (v: number) => void; disabled?: boolean; hint?: string; decimals?: number
}) {
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100
  return (
    <label className="field slider">
      <span className="slider__row">
        <span>{props.label}</span>
        <output className="num">{props.decimals ? props.value.toFixed(props.decimals) : props.value}{props.unit && ` ${props.unit}`}</output>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        disabled={props.disabled} style={{ '--fill': `${pct}%` } as React.CSSProperties}
        onChange={(e) => props.onChange(Number(e.target.value))} />
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function SortHead({ k, label, sort, setSort, num }: {
  k: SortKey; label: string; num?: boolean
  sort: { key: SortKey; dir: 1 | -1 }; setSort: (s: { key: SortKey; dir: 1 | -1 }) => void
}) {
  const active = sort.key === k
  return (
    <th className={num ? 'num' : ''} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => setSort({ key: k, dir: active ? (sort.dir === 1 ? -1 : 1) : 1 })}>
        {label}
        <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden className={active ? 'on' : ''}>
          <path d={active && sort.dir === -1 ? 'M1 3.5 4 .5l3 3' : 'M1 6.5l3 3 3-3'} fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </th>
  )
}

function Detail({ track, ego, onClose }: { track: Track | null; ego: { x: number; y: number }; onClose: () => void }) {
  if (!track) {
    return (
      <section className="detail detail--empty">
        <p>Select an object in the table or click its box in the view to read its measurements.</p>
      </section>
    )
  }
  const range = Math.hypot(track.x - ego.x, track.y - ego.y)
  const speed = Math.hypot(track.vx, track.vy)
  const heading = ((90 - (Math.atan2(track.vy, track.vx) * 180) / Math.PI) % 360 + 360) % 360
  return (
    <section className="detail" aria-live="polite">
      <div className="detail__head">
        <h3>{trackName(track.id)} <span>{CLASS_NAMES[track.cls]}</span></h3>
        <button className="btn btn--quiet btn--small" onClick={onClose}>Clear</button>
      </div>
      <dl>
        <div><dt>Range</dt><dd>{fmt1.format(range)} m</dd></div>
        <div><dt>Speed</dt><dd>{speed < 0.5 ? 'still' : `${fmt1.format(speed)} m/s`}</dd></div>
        <div><dt>Heading</dt><dd>{speed < 0.5 ? '—' : `${String(Math.round(heading)).padStart(3, '0')}°`}</dd></div>
        <div><dt>Size</dt><dd>{fmt1.format(track.length)} × {fmt1.format(track.width)} × {fmt1.format(track.height)} m</dd></div>
        <div><dt>Points</dt><dd>{fmt.format(track.points)}</dd></div>
        <div><dt>Followed for</dt><dd>{fmt.format(track.age)} rev</dd></div>
      </dl>
    </section>
  )
}
