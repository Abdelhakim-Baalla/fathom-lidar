import { useEffect, useRef, useState } from 'react'
import { engine } from '../engine'
import type { Cue, CustomCue } from './cues'

export function AudioPanel({ volume, close, replay }: { volume: number; close: () => void; replay: () => void }) {
  const panel = useRef<HTMLElement>(null)
  const mounted = useRef(false)
  const trigger = useRef<HTMLElement | null>(null)
  const [slot, setSlot] = useState<CustomCue>('intro')
  const [names, setNames] = useState<Partial<Record<CustomCue, string>>>(() => ({ ...engine.cues.customNames }))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    mounted.current = true
    trigger.current = document.activeElement as HTMLElement
    panel.current?.querySelector<HTMLInputElement>('input')?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); trigger.current?.focus() } }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !panel.current?.contains(event.target) && !event.target.closest('.audio-settings')) close()
    }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside)
    return () => { mounted.current = false; document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside) }
  }, [close])
  const preview = async (cue: Cue) => {
    try { engine.setSounds(true); await engine.cues.prepare(); if (!mounted.current) return; engine.cues.stopSequence(); engine.cues.play(cue); setMessage('') }
    catch { setMessage('Audio unavailable in this browser.'); engine.setSounds(false) }
  }
  return <section ref={panel} className="audio-popover" aria-label="Audio settings">
    <div className="audio-panel__head"><h2>Audio</h2><button className="btn btn--small btn--quiet" onClick={() => { close(); trigger.current?.focus() }}>Close</button></div>
    <label className="slider"><span>Volume <output>{volume}%</output></span><input aria-label="Audio volume" type="range" min="0" max="100" step="5" value={volume} onChange={e => engine.setVolume(Number(e.target.value))} /></label>
    <div className="audio-tests">{([['scan', 'Scan'], ['motion', 'Radar'], ['alert', 'Warning']] as const).map(([cue, label]) => <button className="btn btn--small" key={cue} onClick={() => void preview(cue)}>{label}</button>)}</div>
    <button className="btn" onClick={replay}>Replay intro</button>
    <details className="audio-custom"><summary>Use your own audio</summary>
      <label className="field"><span>Replace sound</span><select disabled={busy} value={slot} onChange={e => { setSlot(e.target.value as CustomCue); setMessage('') }}><option value="intro">Intro · first 6.4 seconds</option><option value="scan">Scan · first 1.5 seconds</option><option value="alert">Warning · first 1.6 seconds</option></select></label>
      <label className="audio-file">{busy ? 'Reading audio…' : 'Choose WAV, MP3 or OGG'}<input aria-label="Choose custom audio file" type="file" accept="audio/*,.wav,.mp3,.ogg,.m4a" disabled={busy} onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ''
        if (!file) return
        const selectedSlot = slot
        setBusy(true)
        try { engine.setSounds(true); await engine.cues.importSound(selectedSlot, file); setNames(current => ({ ...current, [selectedSlot]: file.name })); setMessage('Audio loaded for this session.') }
        catch (error) { setMessage(error instanceof Error ? error.message : 'Could not read this audio file.') }
        finally { setBusy(false) }
      }} /></label>
      {names[slot] && <p className="audio-filename">{names[slot]}</p>}
      <button className="btn btn--small btn--quiet" disabled={busy} onClick={() => { engine.cues.clearSound(slot); setNames(current => ({ ...current, [slot]: undefined })); setMessage('Original sound restored.') }}>Restore original</button>
      <p className="note">Local files · this session only. <a href="https://blakesanchez.com/store/hud" target="_blank" rel="noreferrer">Reference soundtrack ↗</a></p>
    </details>
    {message && <p className="note" role="status">{message}</p>}
  </section>
}
