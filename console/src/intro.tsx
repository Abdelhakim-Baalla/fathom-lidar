import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { engine } from './engine'
import './intro.css'

const ticks = Array.from({ length: 120 }, (_, i) => i)
const bars = Array.from({ length: 36 }, (_, i) => 8 + ((i * 17 + i * i * 3) % 48))

/** Decorative identity sequence, never live telemetry. */
function Reticle() {
  return <svg className="intro__reticle" viewBox="0 0 720 720" aria-hidden="true">
    <g fill="none" stroke="currentColor">
      <path className="reticle-frame" d="M60 150V60h90m420 0h90v90M60 570v90h90m420 0h90v-90M24 360h112m448 0h112M360 24v112m0 448v112" />
      <circle className="reticle-hairline" cx="360" cy="360" r="296" />
      <g className="reticle-ticks">{ticks.map(i => <path key={i} d={`M360 74v${i % 10 === 0 ? 17 : i % 5 === 0 ? 10 : 4}`} transform={`rotate(${i * 3} 360 360)`} />)}</g>
      <g className="reticle-orbit reticle-orbit--outer"><circle cx="360" cy="360" r="268" strokeWidth="4" strokeDasharray="140 42 8 42 230 100" /><circle cx="360" cy="360" r="257" strokeDasharray="2 13" strokeWidth="2" /></g>
      <g className="reticle-orbit reticle-orbit--middle"><circle cx="360" cy="360" r="230" strokeWidth="12" strokeDasharray="84 96 4 20" /><circle cx="360" cy="360" r="214" strokeWidth="1" strokeDasharray="320 50" /></g>
      <g className="reticle-orbit reticle-orbit--inner"><circle cx="360" cy="360" r="181" strokeWidth="2" strokeDasharray="180 60 90 24" /><circle cx="360" cy="360" r="168" strokeWidth="6" strokeDasharray="2 14" /></g>
      <g className="reticle-cross"><path d="M230 285v-55h55m150 0h55v55M230 435v55h55m150 0h55v-55" /><circle cx="360" cy="360" r="116" strokeDasharray="1 10" /></g>
      <g className="reticle-sweep"><path d="M360 360V95" /><path d="M360 360 405 100" opacity=".3" /><path d="M360 360 448 110" opacity=".1" /></g>
    </g>
    <g className="reticle-contacts" fill="currentColor"><rect x="204" y="186" width="5" height="5" /><rect x="501" y="402" width="5" height="5" /><rect x="277" y="540" width="5" height="5" /></g>
  </svg>
}

function Sideband({ side }: { side: 'left' | 'right' }) {
  return <svg className={`intro__sideband intro__sideband--${side}`} viewBox="0 0 180 420" aria-hidden="true">
    <g fill="none" stroke="currentColor"><path d="M0 0h180M0 105h180M0 210h180M0 315h180M0 420h180" opacity=".25" />
      <path d="M0 54h20l7-18 10 39 9-57 12 63 8-42 10 15h28l9-21 12 38 10-28 8 11h37" />
      <circle cx="45" cy="157" r="27" /><path d="M45 121v72M9 157h72M92 140h88m-88 17h65m-65 17h80" opacity=".6" />
      <path d="M0 367h15l8-22 8 42 8-26 8 6h25l7-16 8 30 7-14h38l10-28 8 48 9-20h21" />
    </g><g fill="currentColor">{bars.map((height, i) => <rect key={i} x={i * 5} y={287 - height} width="2" height={height} opacity={.25 + (i % 4) * .2} />)}</g>
  </svg>
}

export const Intro = memo(function Intro({ replay = 0 }: { replay?: number }) {
  const [open, setOpen] = useState(() => {
    try { return sessionStorage.getItem('fathom.intro.v2') !== 'seen' } catch { return true }
  })
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [audioError, setAudioError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)
  const panel = useRef<HTMLDialogElement>(null)
  const close = useCallback(() => {
    generation.current++
    if (timer.current) clearTimeout(timer.current)
    engine.cues.stopSequence()
    panel.current?.close()
    setOpen(false)
    setPlaying(false)
    setLoading(false)
    try { sessionStorage.setItem('fathom.intro.v2', 'seen') } catch { /* optional storage */ }
  }, [])
  useEffect(() => { if (replay) { setOpen(true); setAudioError('') } }, [replay])
  useEffect(() => {
    if (!open) return
    const dialog = panel.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    const visibility = () => { if (document.hidden) close() }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      generation.current++
      if (timer.current) clearTimeout(timer.current)
      engine.cues.stopSequence()
      dialog.close()
      document.removeEventListener('visibilitychange', visibility)
      if (previous?.isConnected && previous !== document.body) previous.focus()
      else document.querySelector<HTMLButtonElement>('.feeds button')?.focus()
    }
  }, [open, close])
  const begin = async () => {
    const ticket = ++generation.current
    setLoading(true)
    setAudioError('')
    try {
      engine.setSounds(true)
      await engine.cues.prepare()
      if (ticket !== generation.current) return
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      setPlaying(true)
      setLoading(false)
      if (reduced) engine.cues.play('connect')
      else engine.cues.intro()
      timer.current = setTimeout(close, reduced ? 800 : 6400)
    } catch {
      if (ticket !== generation.current) return
      setLoading(false)
      engine.setSounds(false)
      setAudioError('Audio unavailable. Try again or enter silently.')
    }
  }
  if (!open) return null
  return <dialog ref={panel} className={`intro ${playing ? 'intro--playing' : ''}`} aria-label="Fathom introduction" onCancel={e => { e.preventDefault(); close() }}>
    <div className="intro__header"><img src={`${import.meta.env.BASE_URL}identity/fathom-mark.svg`} alt="" width="28" height="28" /><button className="btn btn--quiet" onClick={close}>Skip intro <kbd>Esc</kbd></button></div>
    <div className="intro__stage">
      <Sideband side="left" /><Reticle /><Sideband side="right" />
      <div className="intro__identity">
        <img className="intro__mark" src={`${import.meta.env.BASE_URL}identity/fathom-mark.svg`} alt="" width="64" height="64" />
        <img className="intro__wordmark" src={`${import.meta.env.BASE_URL}identity/fathom-wordmark.svg`} width="350" height="72" alt="Fathom" />
        <p className="intro__descriptor">FIELD SYSTEMS</p>
      </div>
      <div className="intro__scan" aria-hidden="true" />
    </div>
    <div className="intro__controls">
      <button className="btn btn--primary" disabled={playing || loading} onClick={() => void begin()}>{loading ? 'Preparing audio…' : playing ? 'Opening console…' : 'Enter with audio'}</button>
      <button className="btn btn--quiet" onClick={() => { engine.setSounds(false); close() }}>Enter silently</button>
      {audioError && <p role="status" className="intro__error">{audioError}</p>}
    </div>
    <div className="intro__footer"><span>SPATIAL / RADIO / ACOUSTIC</span><span>FATHOM</span></div>
    <div className="intro__progress" aria-hidden="true" />
  </dialog>
})
