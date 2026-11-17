import type { EngineState } from './engine'

const ASSETS = `${import.meta.env.BASE_URL}identity/`
export function InstrumentIcon({ name, size = 20 }: { name: string; size?: number }) {
  return <svg width={size} height={size} aria-hidden="true"><use href={`${ASSETS}fathom-icons.svg#icon-${name}`} /></svg>
}

export function Aperture() {
  return <svg className="aperture" viewBox="0 0 400 400" aria-hidden="true">
    <g fill="none" stroke="currentColor">
      <circle cx="200" cy="200" r="160" strokeDasharray="1 7.38" strokeWidth="6" />
      <circle cx="200" cy="200" r="140" opacity=".4" />
      <circle cx="200" cy="200" r="98" opacity=".2" />
      <path d="M200 22v32m0 292v32M22 200h32m292 0h32" />
      <path d="M93 93l11 11m192 192 11 11M93 307l11-11m192-192 11-11" opacity=".5" />
      <path d="M64 116a160 160 0 0 1 52-52M284 336a160 160 0 0 0 52-52" strokeWidth="3" />
    </g>
    <image href={`${ASSETS}fathom-mark.svg`} x="156" y="156" width="88" height="88" />
    <g fill="currentColor" textAnchor="middle" fontSize="10" fontFamily="sans-serif">
      <text x="200" y="16">0°</text><text x="385" y="204">90°</text><text x="200" y="396">180°</text><text x="15" y="204">270°</text>
    </g>
  </svg>
}

export function Acquisition({ state, connect, demo, microphone }: { state: EngineState; connect: () => void; demo: () => void; microphone: () => void }) {
  const connected = state.bridge === 'open'
  return <section className="acquisition" aria-label="Connect a sensor">
    <Aperture />
    <div className="acquisition__copy">
      <h2>{connected ? 'Link established.' : state.bridge === 'connecting' ? 'Establishing link.' : 'The field, measured.'}</h2>
      <p>{connected ? 'Awaiting sensor frames.' : 'LiDAR · Wi-Fi CSI · Acoustic'}</p>
      <div className="acquisition__actions">
        <button className="btn btn--primary" onClick={connect} disabled={state.bridge === 'connecting'}>{connected ? 'Reconnect sensor' : 'Connect sensor'}</button>
        <button className="btn" onClick={microphone}>Use microphone</button>
        <button className="btn btn--quiet acquisition__demo" onClick={demo}>Explore simulation ↗</button>
      </div>
    </div>
  </section>
}

export function SessionExport({ state }: { state: EngineState }) {
  const exportSession = () => {
    const report = {
      product: 'Fathom Field Systems', format: 'fathom-session-v1', exportedAt: new Date().toISOString(),
      description: 'Session observations. Object and sound classes are heuristic. A recording hash checks file integrity, not authenticity or chain of custody.',
      activeSource: state.source, simulated: state.stats.simulated,
      exhibits: state.exhibits,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url; a.download = `fathom-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <button className="btn btn--small btn--quiet" onClick={exportSession} disabled={!state.exhibits.length}>Export log</button>
}
