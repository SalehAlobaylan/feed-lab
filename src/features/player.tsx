import Hls from 'hls.js'
import { ArrowUpRight, FileText, Headphones, Info, Maximize2, Minimize2, Pause, Play, Radio, RotateCcw, RotateCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { playback, safeURL, type Item } from '../lib/feed'
import { sceneRecipe, SCENE_PALETTES } from '../lib/scene-generator'
import { activeTranscriptCueIndex, formatTranscriptTime, type TranscriptPresentation } from '../lib/transcript-model'
import { ItemActions, PreviewImage, PreviewSheet, textLanguage, type Interaction } from './consumer-preview'

export interface Progress { played: number; furthest: number; started: boolean; fallback: boolean; error?: string; type: 'hls' | 'mp4' | 'audio' }
type Display = 'listen' | 'transcript' | 'fit' | 'fill'
type TranscriptState = { status: 'loading' | 'failed' } | { status: 'ready'; data: TranscriptPresentation }
const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const clock = (seconds: number) => formatTranscriptTime(seconds) ?? '0:00'

function AudioScene({ item, playing }: { item: Item; playing: boolean }) {
  const recipe = sceneRecipe({ id: item.id, parentId: item.parent_id, profile: item.audio_scene_profile })
  const palette = SCENE_PALETTES[recipe.family]
  return <div className="pod-scene" aria-hidden="true" data-family={recipe.family} data-playing={playing}
    style={{ background: `linear-gradient(135deg,${palette[0]},${palette[1]},${palette[2]})` }}>
    {recipe.shapes.map((shape, index) => <span key={index} style={{
      left: shape.x * 100 + '%', top: shape.y * 100 + '%', width: shape.size * 100 + '%',
      aspectRatio: shape.kind === 'band' ? '3.125' : '1', opacity: shape.opacity,
      border: shape.kind === 'ring' ? '2px solid ' + palette[3] : undefined,
      background: shape.kind === 'ring' ? 'transparent' : palette[3],
      '--rotation': shape.rotation + 'deg', '--period': shape.periodMs + 'ms',
      '--drift-x': recipe.motion === 'restrained' ? '4px' : '10px',
      '--drift-y': recipe.motion === 'restrained' ? '-6px' : '-18px',
      '--drift-angle': recipe.motion === 'restrained' ? '2deg' : '6deg',
    } as CSSProperties} />)}
  </div>
}

export function Player({ item, media, report, observed, disabled, writesDisabled, display, onDisplay, onInteraction, readTranscript }: {
  item: Item
  media: React.RefObject<HTMLMediaElement | null>
  report: (label: string, detail: unknown) => void
  observed: (progress: Progress) => void
  disabled: boolean
  writesDisabled: boolean
  display: { audio: 'listen' | 'transcript'; video: 'fit' | 'fill' | 'transcript' }
  onDisplay: (audio: boolean, display: Display) => void
  onInteraction: (item: Item, kind: Interaction) => void
  readTranscript: (id: string, signal: AbortSignal) => Promise<TranscriptPresentation>
}) {
  const [fallback, setFallback] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [position, setPosition] = useState(0)
  const [scrub, setScrub] = useState<number | null>(null)
  const [duration, setDuration] = useState(item.duration_sec ?? 0)
  const [rate, setRate] = useState(1)
  const [sheet, setSheet] = useState<'about' | 'transcript' | null>(null)
  const [transcript, setTranscript] = useState<TranscriptState>()
  const [transcriptAttempt, setTranscriptAttempt] = useState(0)
  const { id } = item
  const { url, type, audio } = playback(item, fallback)
  const { url: fallbackURL, type: fallbackType } = playback(item, true)
  const callbacks = useRef({ report, observed, readTranscript })
  callbacks.current = { report, observed, readTranscript }
  const progress = useRef<Progress>({ played: 0, furthest: 0, started: false, fallback: false, type })
  const prior = useRef<{ seconds: number; wall: number } | null>(null)
  const resume = useRef({ seconds: 0, playing: false })
  const card = useRef<HTMLDivElement>(null)
  const scrubbing = useRef(false)
  const transcriptCache = useRef<{ id: string; data: TranscriptPresentation } | undefined>(undefined)
  const displayMode = audio ? display.audio : display.video
  const needsTranscript = displayMode === 'transcript' || sheet === 'transcript'
  const transcriptID = item.transcript_id
  useEffect(() => {
    if (!needsTranscript || !transcriptID) return
    if (transcriptCache.current?.id === transcriptID) {
      setTranscript({ status: 'ready', data: transcriptCache.current.data })
      return
    }
    const controller = new AbortController()
    setTranscript({ status: 'loading' })
    void callbacks.current.readTranscript(transcriptID, controller.signal).then(
      data => {
        if (controller.signal.aborted) return
        transcriptCache.current = { id: transcriptID, data }
        setTranscript({ status: 'ready', data })
      },
      () => { if (!controller.signal.aborted) setTranscript({ status: 'failed' }) },
    )
    return () => controller.abort()
  }, [needsTranscript, transcriptID, transcriptAttempt])
  useEffect(() => {
    const el = media.current
    if (!el || !url) return
    let hls: Hls | undefined
    let handled = false
    const failed = () => {
      if (handled) return
      handled = true
      if (!fallback && fallbackURL && fallbackURL !== url) {
        resume.current = { seconds: el.currentTime, playing: !el.paused }
        callbacks.current.report('Playback fallback', { item: id, from: type, to: fallbackType })
        setFallback(true)
      } else {
        progress.current.error = 'The browser could not play the approved source.'
        callbacks.current.observed({ ...progress.current })
        callbacks.current.report('Playback error', { item: id, type, code: el.error?.code })
      }
    }
    progress.current = { ...progress.current, fallback, type }
    prior.current = null
    const loaded = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration)
        callbacks.current.report('Playback metadata observed', { item: id, duration: el.duration, type, fallback, url })
      }
      if (fallback && resume.current.seconds) el.currentTime = Math.min(resume.current.seconds, el.duration || resume.current.seconds)
      if (fallback && resume.current.playing) void el.play().catch(() => callbacks.current.report('Playback needs a gesture', { item: id }))
    }
    el.addEventListener('error', failed)
    el.addEventListener('loadedmetadata', loaded)
    if (type === 'hls' && !el.canPlayType('application/vnd.apple.mpegurl') && Hls.isSupported()) {
      hls = new Hls()
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) failed() })
      hls.loadSource(url)
      hls.attachMedia(el)
    } else el.src = url
    callbacks.current.report('Playback source selected', { item: id, url, type, audio, fallback })
    return () => {
      el.removeEventListener('error', failed)
      el.removeEventListener('loadedmetadata', loaded)
      hls?.destroy()
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
  }, [audio, fallback, fallbackType, fallbackURL, id, media, type, url])
  useEffect(() => {
    if (!card.current || !url) return
    let attempted = false
    const watcher = new IntersectionObserver(([entry]) => {
      const el = media.current
      if (!el) return
      if (entry.intersectionRatio < 0.5) { el.pause(); return }
      if (attempted || fallback || document.hidden || !el.paused) return
      attempted = true
      void el.play().catch(error => {
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          callbacks.current.report('Playback needs a gesture', { item: id })
        }
      })
    }, { threshold: 0.5 })
    watcher.observe(card.current)
    return () => watcher.disconnect()
  }, [fallback, id, media, url])
  useEffect(() => {
    const pause = () => { if (document.hidden) { prior.current = null; media.current?.pause() } }
    document.addEventListener('visibilitychange', pause)
    return () => document.removeEventListener('visibilitychange', pause)
  }, [media])
  const reset = () => { prior.current = null }
  const update = () => {
    const el = media.current
    if (el) setPosition(el.currentTime)
    if (!el || el.paused || el.seeking || scrubbing.current || document.hidden || el.readyState < 2) { reset(); return }
    const now = performance.now()
    const previous = prior.current
    prior.current = { seconds: el.currentTime, wall: now }
    if (!previous) return
    const delta = el.currentTime - previous.seconds
    const wall = (now - previous.wall) / 1000
    if (delta <= 0 || wall > 3 || delta > wall * Math.abs(el.playbackRate) + 0.25) return
    const state = progress.current
    state.played += Math.min(delta, wall * Math.abs(el.playbackRate))
    state.furthest = Math.max(state.furthest, el.currentTime)
    if (!state.started && state.played >= 0.25) {
      state.started = true
      callbacks.current.report('Playback clock advanced', { item: item.id, ...state })
    }
    callbacks.current.observed({ ...state })
  }
  const waiting = () => { reset(); setBuffering(true); callbacks.current.report('Playback waiting', { item: id, type }) }
  const events = { 'data-playback-fallback': String(fallback), onTimeUpdate: update, onSeeking: reset,
    onPause: () => { reset(); setPlaying(false); setBuffering(false) },
    onPlaying: () => { setPlaying(true); setBuffering(false) }, onCanPlay: () => setBuffering(false),
    onEnded: () => setPlaying(false), onWaiting: waiting, onStalled: waiting,
    onRateChange: () => { reset(); setRate(media.current?.playbackRate ?? 1) } }
  const toggle = () => {
    const el = media.current
    if (!el) return
    if (!el.paused) { el.pause(); return }
    void el.play().catch(error => {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        report('Playback needs a gesture', { item: id })
      }
    })
  }
  const seek = (seconds: number) => {
    const el = media.current
    if (!el || el.readyState === 0) return
    const target = Math.max(0, Math.min(seconds, duration))
    el.currentTime = target
    setPosition(target)
  }
  const endScrub = () => { scrubbing.current = false; setScrub(null) }
  const displayTime = Math.min(scrub ?? position, duration)
  const playedPercent = duration ? displayTime / duration * 100 : 0
  const transcriptData = transcript?.status === 'ready' ? transcript.data : undefined
  const cues = transcriptData?.cues
  const active = cues ? activeTranscriptCueIndex(cues, position) : -1
  const visibleCues = useMemo(() => active >= 0 && cues ? cues.slice(Math.max(0, active - 1), active + 2) : [], [active, cues])
  const artwork = item.type === 'PODCAST' && (item.rendition_set_version ?? 1) <= 1 ? undefined : item.thumbnail_url
  const rail = audio ? [{ mode: 'listen', icon: Headphones }, { mode: 'transcript', icon: FileText }] as const :
    [{ mode: 'fit', icon: Minimize2 }, { mode: 'fill', icon: Maximize2 }, { mode: 'transcript', icon: FileText }] as const
  const transcriptMessage = !transcriptID ? 'لا يتوفر نص لهذه الحلقة.' :
    transcript?.status === 'loading' || !transcript ? 'جارٍ تحميل النص…' :
      transcriptData?.mode === 'reader' ? 'النص الكامل متاح للقراءة.' :
        transcriptData?.mode === 'unavailable' ? 'لا يتوفر نص لهذه الحلقة.' : 'استمع واستمتع.'
  const captions = transcript?.status === 'failed' ?
    <button disabled={disabled} onClick={() => setTranscriptAttempt(value => value + 1)}>Retry transcript</button> :
    visibleCues.length > 0 ? <div className="pod-cues">
      {visibleCues.map(cue => <p key={cue.id} dir="auto" className={cue === cues?.[active] ? 'active-cue' : ''}>{cue.text}</p>)}
    </div> : <p lang="ar" dir="rtl">{transcriptMessage}</p>
  return <div className="consumer-card pod-card" data-item-id={id} data-display={displayMode} ref={card}>
    {audio ? <>
      <AudioScene item={item} playing={playing && !buffering && !sheet} />
      <audio className="pod-audio" ref={node => { media.current = node }} preload="metadata" aria-hidden="true" {...events} />
    </> : <video className="pod-video" ref={node => { media.current = node }} playsInline preload="metadata" poster={safeURL(item.thumbnail_url)} {...events} />}
    <button className="pod-stage" aria-label={playing ? 'Pause episode' : 'Play episode'} disabled={disabled || !!sheet} onClick={toggle} />
    <div className="pod-rail" aria-label="Display mode" role="group" data-pager-control>
      {rail.map(({ mode, icon: Icon }) => <button key={mode} aria-label={mode[0].toUpperCase() + mode.slice(1)} aria-pressed={displayMode === mode}
        disabled={disabled} onClick={() => onDisplay(audio, mode)}><Icon /></button>)}
      <button aria-label="About" disabled={disabled} onClick={() => setSheet('about')}><Info /></button>
    </div>
    {audio ? <div className="pod-identity" dir="rtl">
      <PreviewImage className="pod-avatar" url={artwork} fallback={<Headphones />} />
      <div><p dir="auto">{item.source_name || item.author || 'صوت'}</p><h2 dir="auto">{item.title || 'Untitled item'}</h2></div>
    </div> : <div className={'pod-video-title' + (displayMode === 'transcript' ? ' reading' : '')} dir="rtl">
      <p><Radio size={15} /> {item.type || 'فيديو'} <span dir="ltr">{clock(duration)}</span></p>
      <h2 dir="auto" lang={textLanguage(item.title)}>{item.title || 'Untitled item'}</h2>
      {item.source_name && <p dir="auto">{item.source_name}</p>}
    </div>}
    {displayMode === 'transcript' && <div className="pod-transcript">
      <div className="pod-caption">{captions}</div>
      {transcriptID && <button className="pod-full-transcript" data-pager-control disabled={disabled} onClick={() => setSheet('transcript')}>فتح النص الكامل <ArrowUpRight size={14} /></button>}
    </div>}
    {audio ? <div className="pod-transport" data-pager-control>
      {progress.current.error && <p className="pod-error">{progress.current.error}</p>}
      <input type="range" aria-label="Playback position" dir="ltr" disabled={disabled || !duration}
        min="0" max={duration || 1} step="0.1" value={displayTime} aria-valuetext={clock(displayTime) + ' / ' + clock(duration)}
        style={{ '--played': playedPercent + '%' } as CSSProperties}
        onPointerDown={() => { scrubbing.current = true; setScrub(position) }}
        onPointerCancel={endScrub} onBlur={endScrub}
        onPointerUp={event => { if (scrubbing.current) seek(Number(event.currentTarget.value)); endScrub() }}
        onChange={event => {
          const value = Number(event.target.value)
          if (scrubbing.current) setScrub(value)
          else seek(value)
        }} />
      <div className="pod-times"><span>{clock(displayTime)}</span><span>−{clock(duration - displayTime)}</span></div>
      <div className="pod-transport-row">
        <button className="pod-speed" disabled={disabled} aria-label={'Playback speed ' + rate + '×'}
          onClick={() => { if (media.current) media.current.playbackRate = rates[(rates.indexOf(rate) + 1) % rates.length] ?? 1 }}>{rate}×</button>
        <button className="pod-skip" disabled={disabled} aria-label="Back 15 seconds" onClick={() => seek(position - 15)}><RotateCcw /><small>15</small></button>
        <button className="pod-play" disabled={disabled} aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
          {buffering ? <span className="pod-spinner" aria-label="Buffering" /> : playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </button>
        <button className="pod-skip" disabled={disabled} aria-label="Forward 15 seconds" onClick={() => seek(position + 15)}><RotateCw /><small>15</small></button>
      </div>
    </div> : <div className="pod-video-progress">
      {progress.current.error && <p className="pod-error">{progress.current.error}</p>}
      <div role="progressbar" aria-label="Playback position" aria-valuenow={playedPercent} aria-valuetext={clock(position) + ' / ' + clock(duration)}>
        <span style={{ width: playedPercent + '%' }} />
      </div>
    </div>}
    <ItemActions item={item} dock disabled={writesDisabled} onInteraction={onInteraction} onAbout={() => setSheet('about')} />
    {sheet && <PreviewSheet title={sheet === 'about' ? 'عن الحلقة' : 'النص الكامل'} onClose={() => setSheet(null)}>
      <div className="pod-sheet-tabs" role="group" aria-label="Episode details">
        <button aria-pressed={sheet === 'about'} onClick={() => setSheet('about')}>عن الحلقة</button>
        <button aria-pressed={sheet === 'transcript'} onClick={() => setSheet('transcript')}>النص</button>
      </div>
      {sheet === 'about' ? <div className="pod-about" dir="auto">
        <h3>{item.title}</h3>
        <p>{[item.source_name || item.author, clock(item.duration_sec ?? duration)].filter(Boolean).join(' · ')}</p>
        <p>{item.summary || item.excerpt}</p>
      </div> : transcriptData?.cues.length ? transcriptData.cues.map(cue =>
        <button className="sheet-row" key={cue.id} disabled={disabled} onClick={() => seek(cue.startSeconds ?? 0)}>
          <span dir="auto">{cue.text}</span><time>{clock(cue.startSeconds ?? 0)}</time>
        </button>
      ) : transcriptData?.text ? <p dir="auto">{transcriptData.text}</p> : captions}
    </PreviewSheet>}
  </div>
}
