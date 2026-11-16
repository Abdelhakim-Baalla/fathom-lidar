import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { engine, type EngineState } from './engine'
import { clock, type Exhibit, type ExhibitKind } from './exhibits'
import type { Track } from './perception/track'
import { PhoneScan } from './scan/xr'
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
import { CloudView, type CameraPreset, type Layers } from './view/cloud'
import { CLASS_NAMES, PALETTE, type ColorMode } from './view/palettes'
import { RangeImage } from './view/rangeImage'
import { Spectrogram } from './view/spectrogram'
import { Timeline } from './view/timeline'
import { WifiView } from './view/wifiView'

type Feed = 'lidar' | 'wifi' | 'acoustic'
type Filter = 'all' | ExhibitKind

function useEngine() {
  return useSyncExternalStore((fn) => engine.subscribe(fn), () => engine.state)
}

function stored(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
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
const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 })

const COLOR_MODES: Array<{ id: ColorMode; label: string; legend: [string, string] }> = [
  { id: 'range', label: 'Range', legend: ['near', 'far'] },
  { id: 'intensity', label: 'Intensity', legend: ['dark', 'bright · reflector'] },
  { id: 'height', label: 'Height', legend: ['road', '24 m'] },
  { id: 'ring', label: 'Channel', legend: ['even', 'odd'] },
  { id: 'truth', label: 'Ground truth', legend: ['', ''] },
]

const TRUTH_KEYS = [CLASS.ground, CLASS.building, CLASS.vegetation, CLASS.pole, CLASS.car, CLASS.truck, CLASS.pedestrian, CLASS.cyclist]

const secure = location.protocol === 'https:'
const DEFAULT_BRIDGE = secure ? `wss://${location.host}/bridge` : 'ws://127.0.0.1:8765'
const CASE = (() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
})()

export default function App() {
  const s = useEngine()
  const [feed, setFeedState] = useState<Feed>(() => {
    const h = location.hash.slice(1)
    return h === 'wifi' || h === 'acoustic' ? h : 'lidar'
  })
  const setFeed = (f: Feed) => {
    setFeedState(f)
    history.replaceState(null, '', f === 'lidar' ? location.pathname + location.search : `#${f}`)
  }
  const [presetId, setPresetId] = useState('c64')
  const [sensor, setSensor] = useState<SensorConfig>(PRESETS[2].config)
  const [env, setEnv] = useState<Environment>(DEFAULT_ENVIRONMENT)
  const [mode, setMode] = useState<ColorMode>('range')
  const [pointSize, setPointSize] = useState(2.6)
  const [held, setHeld] = useState(8)
  const [layers, setLayers] = useState<Layers>({ rings: true, tracks: true, sweep: true, outline: false })
  const [camera, setCamera] = useState<CameraPreset>('chase')
  const [selected, setSelected] = useState<number | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_BRIDGE)
  const [csiUrl, setCsiUrl] = useState(DEFAULT_BRIDGE)
  const [relay, setRelay] = useState(secure)
  const [fileError, setFileError] = useState('')
  const [xr, setXr] = useState<boolean | null>(null)
  const [spacing, setSpacing] = useState(10)
  const [sealed, setSealed] = useState<number | null>(null)

  const canvas = useRef<HTMLCanvasElement>(null)
  const labels = useRef<HTMLDivElement>(null)
  const rangeCanvas = useRef<HTMLCanvasElement>(null)
  const wifiCanvas = useRef<HTMLCanvasElement>(null)
  const soundCanvas = useRef<HTMLCanvasElement>(null)
  const timelineCanvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const views = useRef<{ cloud: CloudView; timeline: Timeline } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const cloud = new CloudView(canvas.current!, labels.current!)
    const range = new RangeImage(rangeCanvas.current!)
    const wifi = new WifiView(wifiCanvas.current!)
    const spectro = new Spectrogram(soundCanvas.current!, engine.listener.analyser, () => engine.listener.sampleRate)
    const timeline = new Timeline(timelineCanvas.current!, engine.exhibitsNow)
    views.current = { cloud, timeline }
    engine.attach(cloud, range)
    engine.attachInstruments(wifi, spectro, timeline)
    cloud.onSelect = (trackId) => setSelected(trackId === null ? null : engine.exhibitOfTrack(trackId) ?? null)
    timeline.onSelect = (n) => setSelected((cur) => (cur === n ? null : n))
    if (stored('fathom.sounds', false)) engine.setSounds(true)
    PhoneScan.supported().then(setXr)
    return () => {
      engine.detach()
      engine.detachInstruments()
      cloud.dispose()
      range.dispose()
      wifi.dispose()
      spectro.dispose()
      timeline.dispose()
      views.current = null
    }
  }, [])

  useEffect(() => engine.configure(sensor, env), [sensor, env])
  useEffect(() => views.current?.cloud.setColorMode(mode), [mode])
  useEffect(() => views.current?.cloud.setPointSize(pointSize), [pointSize])
  useEffect(() => {
    // A scan of a place keeps every point; a moving sensor holds a few revolutions.
    views.current?.cloud.setPersistence(s.accumulating ? 1e7 : held / sensor.rateHz + 0.02)
  }, [held, sensor.rateHz, s.accumulating])
  useEffect(() => views.current?.cloud.setLayers(layers), [layers])
  useEffect(() => views.current?.cloud.setCamera(camera), [camera])
  useEffect(() => { engine.listener.analyser.spacing = spacing / 100 }, [spacing])

  const byNumber = useMemo(() => new Map(s.exhibits.map((e) => [e.n, e])), [s.exhibits])
  const selectedExhibit = selected === null ? null : byNumber.get(selected) ?? null
  const selectedTrack = selectedExhibit?.kind === 'object' ? s.tracks.find((t) => t.id === selectedExhibit.trackId) ?? null : null

  useEffect(() => {
    views.current?.cloud.setSelected(selectedTrack?.id ?? null)
    if (views.current) views.current.timeline.selected = selected
  }, [selectedTrack?.id, selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, select, textarea, button')) return
      if (e.key === ' ') {
        e.preventDefault()
        engine.setRunning(!engine.state.running)
      } else if (e.key === 'Escape') setSelected(null)
      else if (e.key === '1') setCamera('chase')
      else if (e.key === '2') setCamera('plan')
      else if (e.key === '3') setCamera('side')
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const rows = useMemo(() => {
    const list = s.exhibits.filter((e) => filter === 'all' || e.kind === filter)
    return list.slice().reverse()
  }, [s.exhibits, filter])

  const choosePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!
    setPresetId(id)
    setSensor((cur) => ({ ...p.config, rateHz: cur.rateHz, rangeNoise: cur.rangeNoise, maxRange: Math.min(cur.maxRange, p.config.maxRange) }))
  }

  const toggleRecord = async () => {
    if (!s.recording) {
      engine.startRecording()
      engine.startRecordingCue()
      return
    }
    const out = await engine.stopRecording()
    if (!out) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(out.blob)
    a.download = out.seal.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    const n = engine.state.exhibits[engine.state.exhibits.length - 1]?.n ?? null
    setSealed(n)
    setSelected(n)
    setTimeout(() => setSealed(null), 1600)
  }

  const openFile = async (f: File | undefined) => {
    if (!f) return
    setFileError((await engine.openRecording(f)) ?? '')
  }

  const toggleSounds = () => {
    const on = !s.sounds
    engine.setSounds(on)
    store('fathom.sounds', on ? '1' : '0')
  }

  const sim = s.source === 'simulator'
  const legend = COLOR_MODES.find((m) => m.id === mode)!
  const counts = useMemo(() => {
    const c = { all: s.exhibits.length, object: 0, wifi: 0, sound: 0, recording: 0 }
    for (const e of s.exhibits) c[e.kind]++
    return c
  }, [s.exhibits])

  return (
    <div className="console">
      <header className="bar">
        <span className="wordmark"><Mark />Fathom</span>
        <span className="case">Case {CASE}</span>
        <nav className="feeds" aria-label="Sensor feeds">
          <FeedChip id="lidar" feed={feed} setFeed={setFeed} name="LiDAR" sim={s.stats.simulated && s.source !== 'scan'}
            live={s.running && (s.source !== 'bridge' || s.bridge === 'open')}
            stat={s.source === 'scan' ? `${compact.format(s.scan?.points ?? 0)} pts kept` : `${compact.format(s.stats.pointsPerSecond)} pts/s`} />
          <FeedChip id="wifi" feed={feed} setFeed={setFeed} name="Wi-Fi" sim={s.wifi.mode === 'simulated'}
            live={s.wifi.mode === 'simulated' || s.wifi.link === 'open'} alert={s.wifi.moving}
            stat={s.wifi.mode === 'off' ? 'off' : s.wifi.moving ? 'motion' : 'quiet'} />
          <FeedChip id="acoustic" feed={feed} setFeed={setFeed} name="Acoustic" sim={false}
            live={s.mic.state === 'on'} stat={s.mic.state === 'on' ? `${counts.sound} events` : 'off'} />
        </nav>
        <button className={`iconbtn ${s.sounds ? 'is-on' : ''}`} aria-pressed={s.sounds} onClick={toggleSounds}
          title="Interface sounds">
          <SpeakerIcon on={s.sounds} />
          <span className="sr">Interface sounds</span>
        </button>
        {s.stats.simulated && s.source !== 'scan' && <span className="sim-badge">Simulated</span>}
      </header>

      <aside className="rail" aria-label="Settings for the selected feed">
        {feed === 'lidar' && (
          <>
            <section>
              <h2>Source</h2>
              <label className="field">
                <span>Frames from</span>
                <select value={s.source} onChange={(e) => {
                  const v = e.target.value
                  if (v === 'simulator') engine.useSimulator()
                  else if (v === 'bridge') engine.connectBridge(bridgeUrl)
                  else if (v === 'recording') fileInput.current?.click()
                  else if (v === 'scan') engine.startScan(overlay.current!, relay ? bridgeUrl : null)
                }}>
                  <option value="simulator">Simulated city drive</option>
                  <option value="bridge">Sensor via bridge</option>
                  <option value="recording">Sealed recording file</option>
                  <option value="scan" disabled={!xr}>Phone room scan{xr === false ? ' (needs an ARCore phone)' : ''}</option>
                </select>
              </label>
              {(s.source === 'bridge' || xr) && (
                <form className="inline" onSubmit={(e) => { e.preventDefault(); engine.connectBridge(bridgeUrl) }}>
                  <label className="field">
                    <span>Bridge address</span>
                    <input value={bridgeUrl} onChange={(e) => setBridgeUrl(e.target.value)} spellCheck={false} />
                  </label>
                  {s.source === 'bridge' && <button type="submit" className="btn">Reconnect</button>}
                </form>
              )}
              {s.source === 'bridge' && (
                <p className={`note ${s.bridge === 'error' || s.bridge === 'closed' ? 'note--warn' : ''}`} role="status">
                  {s.bridge === 'error' || s.bridge === 'closed'
                    ? <>{s.bridgeMessage}. Start it with <code>uv run fathom-bridge</code> in <code>bridge/</code>.</>
                    : s.bridge === 'open' ? 'Receiving frames from the bridge.' : 'Connecting…'}
                </p>
              )}
              {xr && (
                <>
                  <Check label="Send the scan to the bridge too" checked={relay} onChange={setRelay} />
                  <button className="btn btn--primary btn--wide" onClick={() => engine.startScan(overlay.current!, relay ? bridgeUrl : null)}>
                    Scan this room
                  </button>
                  <p className="note">Walk slowly and sweep the phone across walls, floor and furniture. Depth comes from ARCore and is estimated on most phones.</p>
                </>
              )}
              {xr === false && (
                <p className="note">Room scans run on an Android phone with ARCore depth. Start <code>bun run dev:phone</code> and open its network address in Chrome on the phone.</p>
              )}
              {s.scanMessage && <p className="note" role="status">{s.scanMessage}</p>}
              {s.source === 'recording' && s.replay && (
                <p className="note">{fmt.format(s.replay.frames)} frames. Scrub in the strip below.</p>
              )}
              {fileError && <p className="note note--warn" role="alert">{fileError}</p>}
              <input ref={fileInput} type="file" accept=".fthm" hidden onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = '' }} />
            </section>

            {sim ? (
              <>
                <section>
                  <h2>Sensor</h2>
                  <label className="field">
                    <span>Beam layout</span>
                    <select value={presetId} onChange={(e) => choosePreset(e.target.value)}>
                      {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <Slider label="Rotation rate" value={sensor.rateHz} min={5} max={20} step={1} unit="Hz"
                    hint={`${fmt1.format(azimuthStepDeg(sensor))}° between columns`}
                    onChange={(v) => setSensor({ ...sensor, rateHz: v })} />
                  <Slider label="Maximum range" value={sensor.maxRange} min={40} max={200} step={10} unit="m"
                    onChange={(v) => setSensor({ ...sensor, maxRange: v })} />
                  <Slider label="Range noise, 1σ" value={Math.round(sensor.rangeNoise * 100)} min={0} max={15} step={1} unit="cm"
                    onChange={(v) => setSensor({ ...sensor, rangeNoise: v / 100 })} />
                  <p className="note">{fmt.format(pointsPerSecond(sensor))} rays per second at {sensor.channels} channels.</p>
                </section>
                <section>
                  <h2>Environment</h2>
                  <fieldset className="seg" aria-label="Weather">
                    {(['clear', 'rain', 'fog'] as Weather[]).map((w) => (
                      <label key={w}><input type="radio" name="weather" checked={env.weather === w} onChange={() => setEnv({ ...env, weather: w })} /><span>{w[0].toUpperCase() + w.slice(1)}</span></label>
                    ))}
                  </fieldset>
                  <Slider label="Vehicle speed" value={Math.round(env.egoSpeed * 3.6)} min={0} max={50} step={5} unit="km/h"
                    onChange={(v) => setEnv({ ...env, egoSpeed: v / 3.6 })} />
                </section>
              </>
            ) : s.source !== 'scan' && (
              <section>
                <h2>Sensor</h2>
                <p className="note">
                  {s.stats.seenChannels > 0
                    ? <>Configured on the device. Seen so far: {s.stats.seenChannels} channels, returns out to {s.stats.seenRange} m.</>
                    : 'Configured on the device. Its channel count and range appear here once frames arrive.'}
                </p>
              </section>
            )}
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
                    <li key={c}><i style={{ background: PALETTE.classes[c] }} />{CLASS_NAMES[c]}</li>
                  ))}
                </ul>
              ) : (
                <div className="ramp">
                  <div className="ramp__bar" style={{ background: rampCss(mode) }} />
                  <div className="ramp__ends"><span>{legend.legend[0]}</span><span>{legend.legend[1]}</span></div>
                </div>
              )}
              {!s.accumulating && <Slider label="Revolutions held" value={held} min={1} max={10} step={1} unit="" onChange={setHeld} />}
              <Slider label="Point size" value={pointSize} min={1} max={5} step={0.2} unit="px" onChange={setPointSize} decimals={1} />
              <div className="checks">
                <Check label="Range rings" checked={layers.rings} onChange={(v) => setLayers({ ...layers, rings: v })} />
                <Check label="Exhibit markers and boxes" checked={layers.tracks} onChange={(v) => setLayers({ ...layers, tracks: v })} />
                <Check label="Scan line" checked={layers.sweep} onChange={(v) => setLayers({ ...layers, sweep: v })} />
                {sim && <Check label="Building outlines" checked={layers.outline} onChange={(v) => setLayers({ ...layers, outline: v })} />}
              </div>
            </section>
          </>
        )}

        {feed === 'wifi' && (
          <>
            <section>
              <h2>Source</h2>
              <fieldset className="seg" aria-label="Wi-Fi source">
                {([['simulated', 'Simulated room'], ['esp32', 'ESP32'], ['off', 'Off']] as const).map(([id, label]) => (
                  <label key={id}><input type="radio" name="wifi" checked={s.wifi.mode === id}
                    onChange={() => engine.setWifiMode(id, csiUrl)} /><span>{label}</span></label>
                ))}
              </fieldset>
              {s.wifi.mode === 'simulated' && (
                <>
                  <Slider label="People in the room" value={s.wifi.people} min={0} max={4} step={1} unit=""
                    onChange={(v) => engine.setWifiPeople(v)} />
                  <p className="note">A transmitter and receiver 6.9 m apart on channel 6. Every packet is the sum of the direct path, four wall reflections and each person's scatter, per subcarrier.</p>
                </>
              )}
              {s.wifi.mode === 'esp32' && (
                <form className="inline" onSubmit={(e) => { e.preventDefault(); engine.setWifiMode('esp32', csiUrl) }}>
                  <label className="field">
                    <span>Bridge address</span>
                    <input value={csiUrl} onChange={(e) => setCsiUrl(e.target.value)} spellCheck={false} />
                  </label>
                  <button type="submit" className="btn">Connect</button>
                  <p className={`note ${s.wifi.link === 'error' || s.wifi.link === 'closed' ? 'note--warn' : ''}`} role="status">
                    {s.wifi.message}{s.wifi.link === 'error' || s.wifi.link === 'closed'
                      ? <>. Flash an ESP32 with Espressif's <code>csi_recv</code> example and run <code>uv run fathom-bridge --csi-serial /dev/ttyUSB0</code>.</>
                      : null}
                  </p>
                </form>
              )}
            </section>
            <section>
              <h2>Detector</h2>
              <dl className="facts">
                <div><dt>Motion index</dt><dd>{fmt1.format(s.wifi.index)} %</dd></div>
                <div><dt>Score over quiet floor</dt><dd>× {fmt1.format(s.wifi.score)}</dd></div>
                <div><dt>Received power</dt><dd>{s.wifi.mode === 'off' ? '—' : `${Math.round(s.wifi.rssi)} dBm`}</dd></div>
                <div><dt>Packets</dt><dd>{Math.round(s.wifi.packetsPerSecond)} /s</dd></div>
              </dl>
              <p className="note">One link senses that something moved near it. It does not locate or count people; the plan shows the simulation's ground truth for comparison.</p>
            </section>
          </>
        )}

        {feed === 'acoustic' && (
          <>
            <section>
              <h2>Microphone</h2>
              <button className={`btn btn--wide ${s.mic.state === 'on' ? '' : 'btn--primary'}`}
                onClick={() => engine.listen(s.mic.state !== 'on')} disabled={s.mic.state === 'asking'}>
                {s.mic.state === 'on' ? 'Stop listening' : s.mic.state === 'asking' ? 'Waiting for permission…' : 'Start listening'}
              </button>
              {s.mic.state === 'on' && (
                <p className="note">{s.mic.device} · {s.mic.stereo ? 'two channels, bearing on' : 'one channel, no bearing'}</p>
              )}
              {s.mic.message && <p className="note note--warn" role="alert">{s.mic.message}</p>}
              <Slider label="Microphone spacing" value={spacing} min={2} max={30} step={1} unit="cm"
                hint="Distance between the two capsules, for the bearing" onChange={setSpacing} />
            </section>
            <section>
              <h2>Detector</h2>
              <dl className="facts">
                <div><dt>Level</dt><dd>{s.mic.state === 'on' ? `${Math.round(engine.listener.analyser.levelDb)} dBFS` : '—'}</dd></div>
                <div><dt>Noise floor</dt><dd>{s.mic.state === 'on' ? `${Math.round(engine.listener.analyser.floorDb)} dBFS` : '—'}</dd></div>
                <div><dt>Opens at</dt><dd>{s.mic.state === 'on' ? `${Math.round(engine.listener.analyser.floorDb + 12)} dBFS` : 'floor + 12 dB'}</dd></div>
                <div><dt>Events logged</dt><dd>{counts.sound}</dd></div>
              </dl>
              <p className="note">An event opens 12 dB above the room's noise floor when the spectrum changes. Classes come from duration, brightness and pitch, so each is a likely reading. Levels are dBFS, relative to the converter, not sound pressure. Bearings are left or right of the microphone pair; front and back look the same to two microphones.</p>
              <p className="note">Interface sounds mute the detector while they play.</p>
            </section>
          </>
        )}
      </aside>

      <main className="view" aria-label="Point cloud">
        <canvas ref={canvas} tabIndex={0} aria-label="3D point cloud. Drag to orbit, scroll to zoom, arrow keys also orbit." />
        <div ref={labels} className="labels" aria-hidden />
        <fieldset className="seg seg--float" aria-label="Camera">
          {([['chase', 'Chase'], ['plan', 'Plan'], ['side', 'Side']] as const).map(([id, label], i) => (
            <label key={id} title={`Key ${i + 1}`}><input type="radio" name="camera" checked={camera === id} onChange={() => setCamera(id)} /><span>{label}</span></label>
          ))}
        </fieldset>
        {s.source === 'bridge' && s.bridge !== 'open' && (
          <div className="empty" role="status">
            <p className="empty__title">{s.bridge === 'connecting' ? 'Waiting for the bridge' : 'No frames from the bridge'}</p>
            <p>Run <code>uv run fathom-bridge --source synthetic</code> for a test room, <code>--source udp</code> with a VLP-16 on the network, or <code>--source relay</code> to watch a phone scan.</p>
          </div>
        )}
        {s.source === 'scan' && !s.scan && !s.scanMessage && (
          <div className="empty" role="status"><p className="empty__title">Starting the AR session</p><p>Allow camera access on the phone.</p></div>
        )}
        <div ref={overlay} className="xr-overlay">
          <p className="xr-overlay__count">{fmt.format(s.scan?.points ?? 0)} points</p>
          <p>{s.scan ? `${s.scan.depthWidth} × ${s.scan.depthHeight} depth · moved ${fmt1.format(s.scan.travelled)} m` : 'Point the phone at the room'}</p>
          <button className="btn btn--primary" onClick={() => engine.endScan()}>Finish scan</button>
        </div>
      </main>

      <aside className="panel" aria-label="Exhibit register">
        <div className="panel__head">
          <h2>Exhibit register</h2>
          <span className="count">{counts.all}</span>
        </div>
        <fieldset className="seg seg--small" aria-label="Show exhibits from">
          {([['all', 'All'], ['object', 'LiDAR'], ['wifi', 'Wi-Fi'], ['sound', 'Sound'], ['recording', 'Seals']] as const).map(([id, label]) => (
            <label key={id}><input type="radio" name="filter" checked={filter === id} onChange={() => setFilter(id)} /><span>{label}</span></label>
          ))}
        </fieldset>
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th scope="col">No.</th><th scope="col">Exhibit</th><th scope="col" className="num">Seen</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 80).map((e) => (
                <ExhibitRow key={e.n} e={e} s={s} selected={e.n === selected} justSealed={e.n === sealed}
                  onSelect={() => setSelected(e.n === selected ? null : e.n)} />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="note pad">
              {filter === 'all' || filter === 'object'
                ? s.accumulating ? 'A room scan keeps every point and logs no objects.' : 'Objects are logged once three revolutions in a row agree on them.'
                : filter === 'wifi' ? 'Motion near the Wi-Fi link is logged here.'
                : filter === 'sound' ? 'Start listening in the Acoustic feed to log sound events.'
                : 'Record, then stop: the file is sealed with its SHA-256 and logged here.'}
            </p>
          )}
        </div>
        <Detail exhibit={selectedExhibit} track={selectedTrack} ego={s.ego} onClose={() => setSelected(null)} />
      </aside>

      <footer className="strip">
        <div className="transport">
          <button className="btn btn--primary" onClick={() => engine.setRunning(!s.running)} aria-keyshortcuts="Space">
            {s.running ? 'Pause scan' : 'Resume scan'}
          </button>
          <button className={`btn ${s.recording ? 'btn--rec' : ''}`} onClick={toggleRecord} disabled={s.source === 'recording'}>
            {s.recording ? <><i className="recdot" aria-hidden />Stop and seal · {fmt1.format(s.recordedSeconds)} s</> : 'Record'}
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
          <span className="transport__meta num">
            {fmt1.format(s.stats.revolutionsPerSecond)} Hz · perception {Math.round(s.stats.perceptionMs)} ms · t {fmt1.format(s.stats.time)} s
          </span>
        </div>
        <figure className="instrument">
          <figcaption className="sr">{feed === 'lidar' ? 'Range image' : feed === 'wifi' ? 'Wi-Fi channel state' : 'Microphone spectrum'}</figcaption>
          <div className="instrument__pane" hidden={feed !== 'lidar'}>
            <span className="instrument__label">Range image · {sim ? sensor.channels : s.stats.seenChannels || '–'} rows × 360° · {sim ? `${sensor.rateHz} Hz` : 'live'}</span>
            <canvas ref={rangeCanvas} className="rangeimg" aria-label="Range image: one row per channel, one column per bearing" />
          </div>
          <div className="instrument__pane" hidden={feed !== 'wifi'}>
            <canvas ref={wifiCanvas} aria-label="Wi-Fi subcarrier amplitudes and motion score" />
          </div>
          <div className="instrument__pane" hidden={feed !== 'acoustic'}>
            <canvas ref={soundCanvas} aria-label="Microphone spectrogram and level" />
            {s.mic.state !== 'on' && <p className="instrument__empty">The spectrum appears here when the microphone is listening.</p>}
          </div>
        </figure>
        <figure className="timeline">
          <figcaption className="sr">Evidence timeline, last 60 seconds</figcaption>
          <canvas ref={timelineCanvas} aria-label="Evidence timeline: one lane per sensor, bars as long as each exhibit lasted. Click a bar to select it." />
        </figure>
      </footer>
    </div>
  )
}

function FeedChip(props: {
  id: Feed; feed: Feed; setFeed: (f: Feed) => void; name: string; stat: string; live: boolean; sim: boolean; alert?: boolean
}) {
  const on = props.feed === props.id
  return (
    <button className={`feed ${on ? 'is-on' : ''} ${props.alert ? 'is-alert' : ''}`} aria-pressed={on} onClick={() => props.setFeed(props.id)}>
      <i className={`feed__dot ${props.live ? 'is-live' : ''}`} aria-hidden />
      <span className="feed__name">{props.name}</span>
      <span className="feed__stat num">{props.stat}</span>
      {props.sim && <span className="feed__sim">sim</span>}
    </button>
  )
}

function age(e: Exhibit): string {
  if (e.open) return 'now'
  const s = Math.max(0, clock() - e.end)
  return s < 60 ? `${Math.round(s)} s ago` : `${Math.floor(s / 60)} min ago`
}

function exhibitText(e: Exhibit, s: EngineState): { title: string; measure: string } {
  if (e.kind === 'object') {
    const t = s.tracks.find((x) => x.id === e.trackId)
    const name = CLASS_NAMES[t?.cls ?? e.cls ?? 0]
    if (!t || !e.open) return { title: name, measure: 'left the scan' }
    const range = Math.hypot(t.x - s.ego.x, t.y - s.ego.y), speed = Math.hypot(t.vx, t.vy)
    return { title: name, measure: `${fmt1.format(range)} m · ${speed < 0.5 ? 'still' : `${Math.round(speed * 3.6)} km/h`} · ${fmt.format(t.points)} pts` }
  }
  if (e.kind === 'wifi') {
    return { title: 'Motion near the link', measure: `× ${fmt1.format(e.wifi?.peak ?? 0)} peak · ${fmt1.format(e.end - e.start)} s` }
  }
  if (e.kind === 'sound' && e.sound) {
    const b = e.sound.bearing
    return {
      title: `${e.sound.cls}${e.sound.cls === 'Footsteps' ? ` × ${e.sound.count}` : ''}`,
      measure: `+${Math.round(e.sound.overFloorDb)} dB over floor${b === null ? '' : ` · ${bearingText(b)}`}`,
    }
  }
  return { title: 'Sealed recording', measure: `sha256 ${e.seal?.sha256.slice(0, 12) ?? ''}…` }
}

function bearingText(b: number): string {
  return Math.abs(b) < 4 ? 'ahead' : `${Math.round(Math.abs(b))}° ${b < 0 ? 'left' : 'right'}`
}

function ExhibitRow({ e, s, selected, justSealed, onSelect }: {
  e: Exhibit; s: EngineState; selected: boolean; justSealed: boolean; onSelect: () => void
}) {
  const { title, measure } = exhibitText(e, s)
  return (
    <tr aria-selected={selected} className={`${e.open ? '' : 'is-closed'} ${justSealed ? 'is-sealed' : ''}`} onClick={onSelect}>
      <td><button className={`tag tag--${e.kind}`} onClick={(ev) => { ev.stopPropagation(); onSelect() }} aria-label={`Exhibit ${e.n}`}>{e.n}</button></td>
      <td>
        <span className="row__title">{title}{e.kind === 'sound' && <em> likely</em>}</span>
        <span className="row__measure num">{measure}</span>
      </td>
      <td className="num row__age">{age(e)}</td>
    </tr>
  )
}

function rampCss(mode: ColorMode): string {
  const pal = PALETTE
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

function Detail({ exhibit, track, ego, onClose }: {
  exhibit: Exhibit | null; track: Track | null; ego: { x: number; y: number }; onClose: () => void
}) {
  if (!exhibit) {
    return (
      <section className="detail detail--empty">
        <p>Select an exhibit in the register, on its marker in the scan, or on the timeline to read its evidence.</p>
      </section>
    )
  }
  const head = (title: string, sub: string) => (
    <div className="detail__head">
      <span className={`tag tag--big tag--${exhibit.kind}`}>{exhibit.n}</span>
      <h3>{title} <span>{sub}</span></h3>
      <button className="btn btn--quiet btn--small" onClick={onClose}>Clear</button>
    </div>
  )
  const when = (
    <>
      <div><dt>Logged</dt><dd>{fmt1.format(exhibit.start)} s into the session</dd></div>
      <div><dt>Lasted</dt><dd>{exhibit.open ? 'still open' : `${fmt1.format(exhibit.end - exhibit.start)} s`}</dd></div>
    </>
  )

  if (exhibit.kind === 'object') {
    const name = CLASS_NAMES[track?.cls ?? exhibit.cls ?? 0]
    if (!track) {
      return (
        <section className="detail" aria-live="polite">
          {head(name, 'left the scan')}
          <dl>{when}</dl>
        </section>
      )
    }
    const range = Math.hypot(track.x - ego.x, track.y - ego.y)
    const speed = Math.hypot(track.vx, track.vy)
    const heading = ((90 - (Math.atan2(track.vy, track.vx) * 180) / Math.PI) % 360 + 360) % 360
    return (
      <section className="detail" aria-live="polite">
        {head(name, 'LiDAR track')}
        <dl>
          <div><dt>Range</dt><dd>{fmt1.format(range)} m</dd></div>
          <div><dt>Speed</dt><dd>{speed < 0.5 ? 'still' : `${fmt1.format(speed)} m/s`}</dd></div>
          <div><dt>Heading</dt><dd>{speed < 0.5 ? '—' : `${String(Math.round(heading)).padStart(3, '0')}°`}</dd></div>
          <div><dt>Size</dt><dd>{fmt1.format(track.length)} × {fmt1.format(track.width)} × {fmt1.format(track.height)} m</dd></div>
          <div><dt>Points in box</dt><dd>{fmt.format(track.points)}</dd></div>
          <div><dt>Followed for</dt><dd>{fmt.format(track.age)} rev</dd></div>
        </dl>
      </section>
    )
  }
  if (exhibit.kind === 'wifi') {
    return (
      <section className="detail" aria-live="polite">
        {head('Motion near the link', exhibit.wifi?.source === 'esp32' ? 'ESP32 CSI' : 'simulated CSI')}
        <dl>
          {when}
          <div><dt>Peak score</dt><dd>× {fmt1.format(exhibit.wifi?.peak ?? 0)} over the quiet floor</dd></div>
        </dl>
      </section>
    )
  }
  if (exhibit.kind === 'sound' && exhibit.sound) {
    const e = exhibit.sound
    return (
      <section className="detail" aria-live="polite">
        {head(e.cls, 'likely, from its features')}
        <dl>
          {when}
          <div><dt>Peak level</dt><dd>{fmt1.format(e.peakDb)} dBFS</dd></div>
          <div><dt>Over the noise floor</dt><dd>+{fmt1.format(e.overFloorDb)} dB</dd></div>
          <div><dt>Brightness</dt><dd>{fmt.format(Math.round(e.centroidHz))} Hz centroid</dd></div>
          <div><dt>Pitch</dt><dd>{e.pitchHz ? `${Math.round(e.pitchHz)} Hz, ${Math.round(e.voicedShare * 100)} % voiced` : 'none'}</dd></div>
          <div><dt>Bearing</dt><dd>{e.bearing === null ? 'mono input or unclear' : bearingText(e.bearing)}</dd></div>
          {e.cls === 'Footsteps' && <div><dt>Steps</dt><dd>{e.count}</dd></div>}
        </dl>
      </section>
    )
  }
  const seal = exhibit.seal!
  return (
    <section className="detail" aria-live="polite">
      {head('Sealed recording', `${fmt.format(seal.frames)} frames`)}
      <dl>
        <div><dt>File</dt><dd className="wrap">{seal.name}</dd></div>
        <div><dt>Length</dt><dd>{fmt1.format(seal.seconds)} s · {fmt1.format(seal.bytes / 1048576)} MB</dd></div>
        <div><dt>Sealed</dt><dd>{seal.sealedAt.replace('T', ' ').slice(0, 19)} UTC</dd></div>
      </dl>
      <p className="hash"><span>SHA-256</span><code>{seal.sha256}</code></p>
      <button className="btn btn--small" onClick={() => navigator.clipboard?.writeText(seal.sha256)}>Copy hash</button>
    </section>
  )
}

function Mark() {
  // A scene marker: a folded tent seen from the front.
  return (
    <svg className="mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M9 1.5 17 16.5H1Z" fill={PALETTE.exhibit} />
      <path d="M9 1.5 9 16.5" stroke="#0d1012" strokeWidth="1.2" />
    </svg>
  )
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 6.5h3l4-3.5v12l-4-3.5h-3z" strokeLinejoin="round" />
      {on ? <path d="M12 6.2a4 4 0 0 1 0 5.6M14 4.2a7 7 0 0 1 0 9.6" strokeLinecap="round" />
        : <path d="M12.5 7l4 4m0-4-4 4" strokeLinecap="round" />}
    </svg>
  )
}
