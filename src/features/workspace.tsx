import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Zap } from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent } from 'react'
import { health, lab, owner, RequestError, type Health, type Identities, type Scope } from '../lib/client'
import { fitRunEvidence, isFeedResponse, redact, type CheckResult, type CheckSettings, type Evidence, type FeedCapture, type FeedSnapshot, type InspectionSnapshot, type RunDraft, type SavedRun, type Verdict } from '../lib/evidence'
import { adapt, consumption, playback, validID, type Item, type Page } from '../lib/feed'
import { belongs, comparisonFields, responseRow } from '../lib/inspection'
import { ArticleReader, FeedHeader, NewsPreview, SavedLibrary, type Interaction, type Reader, type Surface } from './consumer-preview'
import { Player, type Progress } from './player'
import { ItemInspector, transcriptQuery } from './item-inspector'
import { Check, requireCheck, scenarios, type Scenario } from './scenarios'
import { FeedComparisonView } from './feed-comparison'

type Capture = (entry: Evidence) => void
type RequestContext = { signal?: AbortSignal; record: Capture; actionId?: string }
type RuxTarget = { id: string; journey: string; actionId?: string; captureId?: string; item?: Item }
function itemEvidence(entry: Evidence, item?: Item, actionId?: string): Evidence {
  return {
    ...entry, captureId: item?.capture?.id ?? entry.captureId,
    itemId: item?.id ?? entry.itemId, storyId: item?.story_id ?? entry.storyId,
    actionId: actionId ?? entry.actionId,
  }
}
function withItem(ctx: RequestContext, item: Item, actionId = ctx.actionId ?? crypto.randomUUID()): RequestContext {
  return { ...ctx, actionId, record: entry => ctx.record(itemEvidence(entry, item, actionId)) }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The operation could not finish.'
const emptyProgress: Progress = { played: 0, furthest: 0, started: false, fallback: false, type: 'mp4' }
const now = () => new Date().toISOString()
const frame = () => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, 100)
  requestAnimationFrame(() => { clearTimeout(timer); resolve() })
})
async function waitForPreview(matches: () => boolean, signal?: AbortSignal) {
  const deadline = performance.now() + 1000
  do {
    signal?.throwIfAborted()
    if (matches()) return true
    await frame()
  } while (performance.now() < deadline)
  signal?.throwIfAborted()
  return false
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const visibleHeight = (rect: DOMRect) => Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top))
type IdentitySlot = keyof Identities
type AuthAction = 'login' | 'quick-sign-in' | 'refresh' | 'logout'
type RefreshIdentity = (options?: { throwOnError?: boolean }) => Promise<{ data?: Identities }>
type FeedFilters = Pick<CheckSettings, 'duration' | 'language' | 'windowName' | 'savedFilter' | 'savedSort'>
type FeedIssue = {
  feed: Surface; message: string; session?: 'expired' | 'stale'
  operation: 'load' | 'page' | 'freshness'; filters?: FeedFilters; ordinary?: boolean
}

function feedSnapshot(page: Page, config: Health, evidence: Evidence[]): FeedSnapshot {
  const pages = page.captures.slice(0, 200)
  const retained = new Set(pages.map(capture => capture.id))
  const available = new Set(evidence.filter(isFeedResponse).map(entry => entry.captureId))
  return {
    environment: config.environment, runtime: config.runtime_id, pages, rows: page.rows.filter(row => retained.has(row.captureId)).slice(0, 1200),
    hasMore: !!page.cursor, omitted: page.omissions.length, missingResponses: pages.filter(capture => !available.has(capture.id)).map(capture => capture.id),
    rowsTrimmed: page.captures.length > 200 || page.rows.length > 1200 || undefined,
  }
}

function SignIn({ config, identities, onChange, locked, promptConsumer, busy, onBusy }: {
  config: Health; identities: Identities; onChange: (slot: IdentitySlot, action: AuthAction) => Promise<void>;
  locked: boolean; promptConsumer: boolean; busy: boolean; onBusy: (busy: boolean) => void
}) {
  const [slot, setSlot] = useState<IdentitySlot>('operator')
  const [problem, setProblem] = useState('')
  const panel = useRef<HTMLDetailsElement>(null)
  const summary = useRef<HTMLElement>(null)
  const quickSignIn = useRef<HTMLButtonElement>(null)
  const email = useRef<HTMLInputElement>(null)
  const state = identities[slot]
  const signedIn = state.state === 'signed-in'
  useEffect(() => {
    if (promptConsumer) {
      setSlot('consumer')
      setProblem('')
      if (panel.current) panel.current.open = true
    } else if (identities.operator.state === 'expired') setSlot('operator')
  }, [promptConsumer, identities.operator.state])
  useEffect(() => {
    if (promptConsumer && slot === 'consumer') (quickSignIn.current ?? email.current)?.focus()
  }, [promptConsumer, slot])
  async function submit(action: AuthAction, fields?: FormData) {
    if (locked) return
    setProblem(''); onBusy(true)
    try {
      await lab(config, '/api/auth', { method: 'POST', body: JSON.stringify({
        slot, action, email: fields?.get('email'), password: fields?.get('password'),
      }) })
      await onChange(slot, action)
      if (slot === 'consumer' && identities.operator.state === 'signed-in' && panel.current) {
        panel.current.open = false
        summary.current?.focus()
      }
    } catch (error) { setProblem(errorText(error)) } finally { onBusy(false) }
  }
  return <details ref={panel} className="identity" open={identities.operator.state !== 'signed-in' || undefined}>
    <summary ref={summary}><span>IAM identities</span><ChevronDown size={15} aria-hidden="true" /></summary>
    <div className="identity-fields">
      <div className="identity-heading">
        <div><h2>{signedIn ? `${slot === 'operator' ? 'Operator' : 'Consumer'} session` : `Sign in as ${slot}`}</h2>
          <p className="hint">{slot === 'operator' ? 'Access feed diagnostics and saved investigations.' : 'Use this account for the feed preview and Saved.'}</p>
        </div>
        <label>Account <select aria-label="Account" value={slot} onChange={e => { setSlot(e.target.value as IdentitySlot); setProblem('') }} disabled={locked}>
          <option value="operator">Operator</option><option value="consumer">Consumer</option>
        </select></label>
      </div>
      {signedIn ? <div className="identity-current">
        <bdi>{state.email || 'Signed in'}</bdi>
        <button disabled={locked} onClick={() => void submit('logout')}>Sign out {slot}</button>
      </div> : <>
        {config.quickSignIn && <div className="identity-quick">
          <div><strong>Local account</strong><p className="hint">Uses the account configured for this launch.</p></div>
          <button ref={quickSignIn} className="primary quick-sign-in" disabled={locked}
            onClick={() => void submit('quick-sign-in')}><Zap size={16} aria-hidden="true" />Quick Sign In</button>
        </div>}
        <form key={slot} className="inline" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void submit('login', new FormData(event.currentTarget)) }}>
          {config.quickSignIn && <p className="identity-manual-label hint">Use email and password</p>}
          <label>Email <input ref={email} name="email" type="email" autoComplete="username" required /></label>
          <label>Password <input name="password" type="password" autoComplete="current-password" required /></label>
          <button disabled={locked}>Sign in</button>
          {state.state === 'expired' && <button type="button" disabled={locked} onClick={() => void submit('refresh')}>Refresh session</button>}
        </form>
      </>}
      {busy && <p className="hint" role="status">Connecting to IAM…</p>}
      {problem && <p className="problem" role="alert">{problem}</p>}
    </div>
  </details>
}

export function Workspace({ rerunId }: { rerunId?: string }) {
  const query = useQuery({ queryKey: ['health'], queryFn: health, staleTime: Infinity, retry: false })
  const config = query.data
  const identities = useQuery({
    queryKey: ['identities', config?.runtime_id], enabled: !!config, retry: false,
    queryFn: () => lab<Identities>(config!, '/api/identity'),
  })
  if (!config || !identities.data) {
    const error = query.error ?? identities.error
    return <main className="workspace">
      <p role={error ? 'alert' : 'status'}>{error ? errorText(error) : 'Connecting to the selected Wahb launch…'}</p>
      {error && <button onClick={() => window.location.reload()}>Retry connection</button>}
    </main>
  }
  return <Lab key={config.runtime_id + '/' + (rerunId ?? '')} config={config} identities={identities.data} refreshIdentity={identities.refetch} rerunId={rerunId} />
}

function Lab({ config, identities, refreshIdentity, rerunId }: { config: Health; identities: Identities; refreshIdentity: RefreshIdentity; rerunId?: string }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<Scope['mode']>('inspect')
  const [signed, setSigned] = useState(false)
  const [reloadConsumerFeed, setReloadConsumerFeed] = useState(false)
  const [session, setSession] = useState(() => crypto.randomUUID())
  const [surface, setSurface] = useState<Surface>('pods')
  const [duration, setDuration] = useState('')
  const [language, setLanguage] = useState('')
  const [windowName, setWindowName] = useState('today')
  const [savedFilter, setSavedFilter] = useState<NonNullable<CheckSettings['savedFilter']>>('all')
  const [savedSort, setSavedSort] = useState<NonNullable<CheckSettings['savedSort']>>('saved_desc')
  const filters = { duration, language, windowName, savedFilter, savedSort }
  const [page, setPage] = useState<Page | null>(null)
  const [position, setPosition] = useState(0)
  const [reader, setReader] = useState<Reader | null>(null)
  const [savedMedia, setSavedMedia] = useState<Item | null>(null)
  const savedScroll = useRef(0)
  const [audioDisplay, setAudioDisplay] = useState<'listen' | 'transcript'>('transcript')
  const [videoDisplay, setVideoDisplay] = useState<'fit' | 'fill' | 'transcript'>('fit')
  const [progress, setProgress] = useState(emptyProgress)
  const observed = useRef(emptyProgress)
  const media = useRef<HTMLMediaElement | null>(null)
  const phone = useRef<HTMLElement | null>(null)
  const touchStart = useRef<number | null>(null)
  const lastSwipe = useRef(0)
  const [mobileView, setMobileView] = useState<'preview' | 'details'>('preview')
  const [inspectionEpoch, setInspectionEpoch] = useState(0)
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [evidenceCount, setEvidenceCount] = useState(0)
  const [pin, setPin] = useState<{ operator: string; capture: FeedSnapshot; evidence: Evidence[] }>()
  const baseline = pin?.operator === identities.operator.id ? pin : undefined
  const [showComparison, setShowComparison] = useState(false)
  const [comparisonNote, setComparisonNote] = useState('')
  const [loadedSearch, setLoadedSearch] = useState('')
  const [checkResults, setCheckResults] = useState<CheckResult[]>([])
  const [preparedRerun, setPreparedRerun] = useState<CheckSettings>()
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [authenticating, setAuthenticating] = useState(false)
  const [loadingFeed, setLoadingFeed] = useState<Surface>()
  const [feedIssue, setFeedIssue] = useState<FeedIssue>()
  const [freshness, setFreshness] = useState<'available' | 'current'>()
  const [expired, setExpired] = useState(false)
  const [scenario, setScenario] = useState<Scenario>('pods')
  const [restore, setRestore] = useState(true)
  const [active, setActive] = useState(false)
  const [latestRun, setLatestRun] = useState<string>()
  const abort = useRef<AbortController | null>(null)
  const running = useRef<AbortController | null>(null)
  const pageRun = useRef<string | undefined>(undefined)
  const scenarioEvidence = useRef<Evidence[] | null>(null)
  const delivered = useRef(new Set<string>())
  const sequence = useRef(0)
  const scopeRevision = useRef(0)
  const scope: Scope = { health: config, mode, signed, consumerID: signed ? identities.consumer.id : undefined, operatorID: identities.operator.id, session }
  const current = page?.items[position]
  const selected = reader?.item ?? current
  const playingItem = surface === 'pods' || savedMedia ? current : undefined
  const mediaKey = playingItem ?
    JSON.stringify([playingItem.id, playingItem.capture?.id, playback(playingItem, false), playback(playingItem, true)]) : undefined
  const operatorReady = identities.operator.state === 'signed-in'
  const needsConsumerSignIn = signed && identities.consumer.state !== 'signed-in'
  const locked = busy || active || authenticating
  const rerun = useQuery({
    queryKey: ['runs', config.runtime_id, identities.operator.id, rerunId],
    enabled: Boolean(rerunId && operatorReady), retry: false,
    queryFn: ({ signal }) => lab<SavedRun>(config, '/api/runs?id=' + encodeURIComponent(rerunId!), { signal }),
  })
  useEffect(() => {
    if (pin && pin.operator !== identities.operator.id) {
      setPin(undefined); setShowComparison(false); setComparisonNote('')
    }
  }, [pin, identities.operator.id])
  const evidenceSizes = useRef(new WeakMap<Evidence, number>())
  const append: Capture = input => {
    const entry = { ...input, id: input.id ?? crypto.randomUUID() }
    setEvidenceCount(count => count + 1)
    scenarioEvidence.current?.push(entry)
    evidenceSizes.current.set(entry, new TextEncoder().encode(JSON.stringify(entry)).byteLength)
    setEvidence(previous => {
      let bytes = 0
      return [entry, ...previous].slice(0, 45).filter(value => {
        bytes += evidenceSizes.current.get(value) ?? 0
        return bytes < 4.5 * 1024 * 1024
      })
    })
  }
  const record = (label: string, detail: unknown) => append({ at: now(), label, detail: redact(detail) })
  function reset() {
    scopeRevision.current++
    abort.current?.abort()
    media.current?.pause()
    setReader(null); setSavedMedia(null); setPage(null); setPosition(0); setProgress(emptyProgress)
    savedScroll.current = 0
    setEvidence([]); setEvidenceCount(0); setInspectionEpoch(value => value + 1); setMobileView('preview')
    setSession(crypto.randomUUID())
    setReloadConsumerFeed(false)
    setPreparedRerun(undefined); setCheckResults([]); setLoadedSearch('')
    setFeedIssue(undefined); setFreshness(undefined)
    delivered.current.clear()
    sequence.current = 0
    setLatestRun(undefined); setProblem(''); setNotice('')
    observed.current = emptyProgress
    void queryClient.cancelQueries({ queryKey: ['feed'] })
    queryClient.removeQueries({ queryKey: ['feed'] })
    void queryClient.cancelQueries({ queryKey: ['inspector'] })
    queryClient.removeQueries({ queryKey: ['inspector'] })
  }
  useEffect(() => {
    const interrupt = () => { running.current?.abort(); abort.current?.abort() }
    const leave = () => {
      interrupt()
      const id = pageRun.current
      if (!id) return
      const query = new URLSearchParams({ id, interrupt: '1', launch: config.runtime_id })
      const path = '/api/runs?' + query
      if (!navigator.sendBeacon?.(path)) void fetch(path, { method: 'POST', keepalive: true }).catch(() => {})
    }
    const visibility = () => { if (document.hidden) leave() }
    window.addEventListener('pagehide', leave)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      interrupt()
      window.removeEventListener('pagehide', leave)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [config.runtime_id])
  useEffect(() => {
    observed.current = emptyProgress
    setProgress(emptyProgress)
    setReader(null)
  }, [current?.id, surface, mediaKey])
  useEffect(() => {
    setExpired(false)
    if (!page?.expiresAt || !page.session_id) return
    const timer = setTimeout(() => setExpired(true), Math.min(2 ** 31 - 1, Math.max(0, Date.parse(page.expiresAt) - Date.now())))
    return () => clearTimeout(timer)
  }, [page?.session_id, page?.expiresAt])
  const request = <T,>(path: string, ctx: RequestContext, options?: {
    method?: 'POST' | 'DELETE'; query?: Record<string, string>; body?: object
  }) => owner<T>(scope, path, { ...options, ...ctx })

  function matchingPreview(item: Item, reader = false) {
    const preview = phone.current
    if (preview?.dataset.previewCapture !== item.capture?.id || preview?.dataset.previewRow !== item.responseRow) return null
    const body = preview?.querySelector<HTMLElement>(reader ? '.article-reader' :
      '.consumer-card[data-item-id], [data-saved-id="' + item.id + '"]')
    return (body?.dataset.itemId ?? body?.dataset.savedId) === item.id ? body : null
  }

  async function verifyPreview(item: Item, ctx: RequestContext, reader = false) {
    const mounted = await waitForPreview(() => !!matchingPreview(item, reader), ctx.signal)
    requireCheck(mounted, 'unverified', reader ? 'The article did not mount in the preview.' : 'The returned item did not mount in the preview.')
    withItem(ctx, item).record({ at: now(), label: reader ? 'Verified reader mount' : 'Verified feed card mount',
      detail: { response_row: item.responseRow } })
  }
  async function action(work: (ctx: RequestContext) => Promise<void>) {
    if (locked) return false
    setProblem(''); setNotice(''); setLatestRun(undefined); setBusy(true)
    const controller = new AbortController()
    abort.current = controller
    const revision = scopeRevision.current
    try { await work({ signal: controller.signal, record: entry => {
      if (revision === scopeRevision.current) append(entry)
    } }); return true }
    catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof RequestError && error.status === 401) refreshIdentity()
        if (error instanceof RequestError && error.status === 409 && /launch changed/i.test(error.message)) {
          reset(); setPin(undefined); setShowComparison(false); setComparisonNote('')
        }
        setProblem(errorText(error))
      }
      return false
    }
    finally { if (abort.current === controller) { abort.current = null; setBusy(false) } }
  }

  async function rux(phase: 'feed' | 'pagination' | 'startup' | 'reader', feed: 'pods' | 'news', outcome: string,
    ctx: RequestContext, details: { item?: Item; elapsed?: number; progress?: Progress; feedSessionId?: string } = {}) {
    if (details.item) ctx = withItem(ctx, details.item)
    const event = {
      schema_version: 2, event_id: crypto.randomUUID(), journey_id: crypto.randomUUID(),
      event_type: 'journey_terminal', occurred_at: now(), session_id: session, page_load_id: session,
      sequence: sequence.current++, release: 'dev', surface: feed, phase, outcome,
      content_id: details.item?.id, story_id: details.item?.story_id, playback_type: details.progress?.type,
      feed_session_id: details.feedSessionId,
      client: { platform: 'web', browser_family: 'other', device_class: 'unknown', network_class: 'unknown' },
      measurements: { duration_ms: Math.min(120000, Math.round(details.elapsed ?? 0)), visible: !document.hidden,
        observed_playback_ms: details.progress ? Math.round(details.progress.played * 1000) : undefined,
        fallback_used: details.progress?.fallback },
    }
    ctx.record({ at: now(), label: 'RUX browser observation', detail: { event, delivery: mode === 'test' ? 'Sending' : 'Inspect mode' } })
    if (mode === 'inspect') return
    try {
      const receipt = await request<{ disabled?: boolean; accepted?: number; duplicate?: number }>('/experience/events', ctx,
        { method: 'POST', body: { schema_version: 2, events: [event] } })
      ctx.record({ at: now(), label: 'RUX ingest receipt', detail: { ...receipt, event_id: event.event_id, exact_persistence: 'Unverified until readback' } })
      if (receipt.accepted || receipt.duplicate) {
        return { id: event.event_id, journey: event.journey_id, actionId: ctx.actionId, captureId: details.item?.capture?.id, item: details.item }
      }
    } catch (error) {
      ctx.record({ at: now(), label: 'RUX delivery unverified', detail: { event_id: event.event_id, error: errorText(error) } })
    }
  }
  async function verifyRux(ctx: RequestContext, target?: RuxTarget) {
    requireCheck(target, 'unverified', 'No accepted event is available for exact RUX readback.')
    if (target.item) ctx = withItem(ctx, target.item, target.actionId)
    const result = await request<{ data?: { event_id?: string; journey_id?: string }[] }>('/admin/experience/evidence/events', ctx, {
      query: { journey_id: target.journey, client_platform: 'web', limit: '20' },
    })
    const match = Array.isArray(result.data) && result.data.find(row => row.event_id === target.id && row.journey_id === target.journey)
    ctx.record({ at: now(), actionId: target.actionId, captureId: target.captureId,
      label: 'RUX exact event readback', detail: match || { event_id: target.id, status: 'unverified' } })
    requireCheck(match, 'unverified', 'CMS did not return the exact event ID.')
  }
  async function load(feed: Surface, ctx: RequestContext, previous?: Page, ordinary = false,
    selection: FeedFilters = filters, locateOnly = false) {
    const started = performance.now()
    const query: Record<string, string> = previous?.captures[0] ? { ...previous.captures[0].query } : { limit: '6' }
    delete query.contract
    if (previous?.cursor) query.cursor = previous.cursor
    if (!previous && feed === 'pods' && selection.duration) query.duration = selection.duration
    if (!previous && feed === 'pods' && selection.language) query.content_language = selection.language
    if (!previous && feed === 'news') query.window = selection.windowName
    if (!previous && feed === 'saved') {
      query.feed = selection.savedFilter ?? 'all'
      query.sort = selection.savedSort ?? 'saved_desc'
    }
    const path = feed === 'pods' ? (ordinary || (previous && !previous.session_id) ? '/feed/pods' :
      previous?.session_id ? '/feed/pods/sessions/' + previous.session_id : '/feed/pods/sessions')
      : feed === 'news' ? '/feed/news' : '/interactions/bookmarks'
    const method = feed === 'pods' && !ordinary && !previous ? 'POST' : undefined
    const capture: FeedCapture = {
      id: crypto.randomUUID(), at: now(), surface: feed, mode,
      consumer: signed ? scope.consumerID || 'Signed-in consumer' : 'Anonymous · ' + session,
      query: { ...query, ...(feed === 'pods' ? { contract: path === '/feed/pods' ? 'ordinary' : 'frozen' } : {}) },
    }
    const recordCapture = ctx.record
    const actionId = crypto.randomUUID()
    ctx = { ...ctx, actionId, record: entry => recordCapture({ ...entry, actionId: entry.actionId ?? actionId, captureId: entry.captureId ?? capture.id }) }
    let next: Page
    try {
      const raw = await queryClient.fetchQuery({
        queryKey: ['feed', config.runtime_id, mode, signed ? scope.consumerID : session, path, query, crypto.randomUUID()],
        queryFn: ({ signal }) => request<unknown>(path, {
          ...ctx, signal: ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal,
        }, { method, query }),
        gcTime: 60_000,
      })
      const payload = raw as { session_id?: unknown } | null
      if (typeof payload?.session_id === 'string' && validID(payload.session_id) && path.startsWith('/feed/pods/sessions')) {
        capture.session = payload.session_id
      }
      next = adapt(raw, feed, capture)
      const snapshotRow = (item: Item): Item => ({
        ...item, capturedFields: comparisonFields(responseRow(raw, item.responseRow)),
        members: item.members?.map(snapshotRow), related: item.related?.map(snapshotRow),
      })
      next.items = next.items.map(snapshotRow)
      if (path.startsWith('/feed/pods/sessions')) {
        requireCheck(next.session_id && validID(next.session_id), 'failed', 'CMS returned an invalid frozen session identity.')
        requireCheck(!previous || previous.session_id === next.session_id, 'failed', 'The next page belongs to a different frozen session.')
      } else {
        next.session_id = undefined
      }
      if (previous && next.cursor) {
        requireCheck(next.cursor !== previous.cursor && !previous.captures.some(capture => capture.query.cursor === next.cursor),
          'failed', 'The feed returned a repeated cursor.')
      }
    } catch (error) {
      if (!ctx.signal?.aborted) {
        const session = feed === 'pods' && previous?.session_id && error instanceof RequestError
          ? error.status === 410 ? 'expired' : error.status === 409 && /session.*stale/i.test(error.message) ? 'stale' : undefined : undefined
        setFeedIssue(old => ({ feed, message: errorText(error), session: session ?? (old?.feed === feed ? old.session : undefined),
          operation: previous ? 'page' : 'load', filters: selection, ordinary }))
      }
      if (!ctx.signal?.aborted && feed !== 'saved' && !ordinary) await rux(previous ? 'pagination' : 'feed', feed, 'failed', ctx, { elapsed: performance.now() - started })
      throw error
    }
    ctx.signal?.throwIfAborted()
    const all: Page = previous ? {
      ...next, session_id: next.session_id || previous.session_id, expiresAt: next.expiresAt || previous.expiresAt,
      items: [...previous.items, ...next.items], captures: [...previous.captures, ...next.captures], rows: [...previous.rows, ...next.rows],
      omissions: [...previous.omissions, ...next.omissions], omitted: next.omitted,
    } : next
    ctx.record({ at: now(), label: 'Preview adaptation', detail: {
      surface: feed, returned: next.items.map(item => item.id), omitted: next.omitted, omission_rows: next.omissions,
      session_id: next.session_id, cursor: next.cursor,
    } })
    if (locateOnly) return all
    const nextPosition = previous ? Math.max(0, Math.min(next.items.length ? previous.items.length : position, all.items.length - 1)) : 0
    setFeedIssue(undefined)
    if (!previous) setFreshness(undefined)
    if (feed === 'saved' && !previous) savedScroll.current = 0
    setSurface(feed); setPage(all); setPosition(nextPosition)
    setReader(null); setSavedMedia(null)
    const expected = next.items[0]
    try {
      if (expected) await verifyPreview(expected, ctx)
    } catch (error) {
      if (!ctx.signal?.aborted && feed !== 'saved' && !ordinary) {
        await rux(previous ? 'pagination' : 'feed', feed, 'failed', ctx, { item: expected, elapsed: performance.now() - started, feedSessionId: next.session_id })
      }
      throw error
    }
    if (!ctx.signal?.aborted && feed !== 'saved' && !ordinary) {
      const outcome = expected ? 'success' : previous ? 'end_of_feed' : 'empty'
      await rux(previous ? 'pagination' : 'feed', feed, outcome, ctx, {
        item: next.items[0], elapsed: performance.now() - started, feedSessionId: next.session_id,
      })
    }
    return all
  }
  async function openReader(item: Item, ctx: RequestContext, coverage = item.members ?? []) {
    ctx = withItem(ctx, item)
    const start = performance.now()
    try {
      const response = await request<{ data?: Partial<Item> & { translated_title?: string; translated_body_text?: string; translation_language?: string } }>(
        '/content/' + item.id, ctx)
      const result = response.data ?? {}
      ctx.signal?.throwIfAborted()
      requireCheck(!result.id || result.id === item.id, 'unverified', 'CMS returned a different article ID.')
      const text = firstText(result.translated_body_text, result.body_text, result.excerpt, item.excerpt)
      requireCheck(text, 'unverified', 'CMS returned no readable article text.')
      setReader({
        item: {
          ...item, thumbnail_url: firstText(result.thumbnail_url, item.thumbnail_url),
          original_url: firstText(result.original_url, item.original_url),
          source_name: firstText(result.source_name, item.source_name),
          source_image_url: firstText(result.source_image_url, item.source_image_url),
          body_text: text, author: firstText(result.author, item.author), published_at: firstText(result.published_at, item.published_at),
          is_bookmarked: typeof result.is_bookmarked === 'boolean' ? result.is_bookmarked : item.is_bookmarked,
        },
        title: firstText(result.translated_title, result.title, item.title) ?? 'Article', text, coverage,
        translation: result.translated_body_text || result.translated_title ? firstText(result.translation_language) ?? 'Translated text returned' : undefined,
      })
      await verifyPreview(item, ctx, true)
      await rux('reader', 'news', 'success', ctx, { item, elapsed: performance.now() - start })
    } catch (error) {
      if (!ctx.signal?.aborted) await rux('reader', 'news', 'failed', ctx, { item, elapsed: performance.now() - start })
      throw error
    }
  }
  async function readInteraction(item: Item, type: Interaction, ctx: RequestContext) {
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let count = 0; count < 10; count++) {
      const result = adapt(await request<unknown>('/interactions/' + (type === 'like' ? 'likes' : 'bookmarks'), ctx, {
        query: { limit: '50', ...(cursor ? { cursor } : {}) },
      }), 'saved')
      if (result.items.some(value => value.id === item.id)) return true
      requireCheck(!result.omitted.length, 'unverified', 'Interaction readback contained malformed rows.')
      if (!result.cursor) return false
      requireCheck(!seen.has(result.cursor), 'unverified', 'Interaction readback cursor repeated.')
      seen.add(result.cursor); cursor = result.cursor
    }
    throw new Check('unverified', 'Interaction readback reached its page limit.')
  }
  async function setInteraction(item: Item, type: Interaction, desired: boolean, ctx: RequestContext) {
    ctx = withItem(ctx, item)
    if (desired) {
      const result = await request<{ data?: { id?: string; content_item_id?: string; interaction_type?: string } }>('/interactions', ctx, {
        method: 'POST', body: { content_item_id: item.id, interaction_type: type },
      })
      requireCheck(result.data?.id && result.data.content_item_id === item.id && result.data.interaction_type === type,
        'unverified', 'CMS did not return the matching saved interaction.')
    } else {
      await request('/interactions', ctx, { method: 'DELETE', query: { content_item_id: item.id, type } })
    }
    const actual = await readInteraction(item, type, ctx)
    ctx.record({ at: now(), label: 'Signal persistence readback', detail: { item: item.id, type, expected: desired, actual } })
    requireCheck(actual === desired, 'failed', 'Interaction readback disagrees with the requested state.')
    const flag = type === 'like' ? 'is_liked' : 'is_bookmarked'
    const update = (value: Item) => ({
      ...value, [flag]: actual,
      like_count: flag === 'is_liked' && typeof value.like_count === 'number' ?
        Math.max(0, value.like_count + Number(actual) - Number(!!value.is_liked)) : value.like_count,
    })
    setReader(previous => previous?.item.id === item.id ? { ...previous, item: update(previous.item) } : previous)
    if (surface === 'saved' && type === 'bookmark' && !actual) {
      setPage(previous => previous && ({ ...previous, items: previous.items.filter(value => value.id !== item.id) }))
      const removed = page?.items.findIndex(value => value.id === item.id) ?? -1
      setPosition(previous => Math.max(0, Math.min(previous - Number(removed >= 0 && removed < previous), (page?.items.length ?? 1) - 2)))
      setSavedMedia(previous => previous?.id === item.id ? null : previous)
      setReader(previous => previous?.item.id === item.id ? null : previous)
      return
    }
    setPage(previous => previous && ({
      ...previous, items: previous.items.map(value => value.id === item.id ? update(value) : {
        ...value, related: value.related?.map(related => related.id === item.id ? update(related) : related),
        members: value.members?.map(member => member.id === item.id ? update(member) : member),
      }),
    }))
  }
  async function sendView(item: Item, ctx: RequestContext, feedSessionId = page?.session_id) {
    ctx = withItem(ctx, item)
    const card = matchingPreview(item)
    requireCheck(card, 'blocked', 'Open the item in the visible feed card.')
    await reveal(card)
    const rect = card.getBoundingClientRect()
    const fraction = rect.height ? visibleHeight(rect) / rect.height : 0
    requireCheck(!document.hidden && fraction >= 0.5, 'blocked', 'Keep the active feed card visible.')
    ctx.signal?.throwIfAborted()
    const key = 'view/' + mode + '/' + (signed ? scope.consumerID : session) + '/' + (feedSessionId ?? '') + '/' + item.id
    if (delivered.current.has(key)) throw new Check('blocked', 'This item already sent a view in this preview session.')
    ctx.record({ at: now(), label: 'View observed', detail: { item: item.id, feed_session_id: feedSessionId, visible_fraction: fraction } })
    if (mode === 'inspect') return
    const result = await request<{ data?: { id?: string; content_item_id?: string; interaction_type?: string } }>('/interactions', ctx, {
      method: 'POST', body: { content_item_id: item.id, interaction_type: 'view',
        metadata: feedSessionId ? { feed_session_id: feedSessionId } : undefined },
    })
    requireCheck(result.data?.id && result.data.content_item_id === item.id && result.data.interaction_type === 'view', 'unverified', 'No matching saved view was returned.')
    delivered.current.add(key)
    ctx.record({ at: now(), label: 'View persisted', detail: result.data })
  }
  async function sendConsumption(item: Item, ctx: RequestContext) {
    ctx = withItem(ctx, item)
    requireCheck(matchingPreview(item), 'blocked', 'Open the measured item in the feed preview.')
    const state = observed.current
    const metadata = consumption(state.played, state.furthest, item.duration_sec || 0)
    requireCheck(metadata, 'blocked', 'Play the item until the qualifying threshold is reached.')
    ctx.record({ at: now(), label: 'Consumption observed', detail: { item: item.id, ...metadata } })
    if (mode === 'inspect') return
    const result = await request<{ data?: { id?: string; content_item_id?: string; interaction_type?: string } }>('/interactions', ctx, {
      method: 'POST', body: { content_item_id: item.id, interaction_type: metadata.consumption_classification, metadata },
    })
    requireCheck(result.data?.id && result.data.content_item_id === item.id && result.data.interaction_type === metadata.consumption_classification,
      'unverified', 'No matching saved consumption interaction was returned.')
    ctx.record({ at: now(), label: 'Consumption persisted', detail: result.data })
  }
  async function play(item: Item, ctx: RequestContext, qualify = false, feedSessionId = page?.session_id) {
    ctx = withItem(ctx, item)
    await verifyPreview(item, ctx)
    const start = performance.now()
    if (phone.current) await reveal(phone.current)
    let el = media.current
    for (let i = 0; !el && i < 15 && !ctx.signal?.aborted; i++) { await wait(100); el = media.current }
    requireCheck(el, 'blocked', 'Open a playable Pods item.')
    async function startMedia(element: HTMLMediaElement) {
      ctx.signal?.throwIfAborted()
      const pending = element.play()
      let interrupt: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([pending, new Promise<never>((_, reject) => {
          interrupt = () => reject(new DOMException('Playback interrupted', 'AbortError'))
          timer = setTimeout(() => reject(new Error('The player did not start in time.')), 12_000)
          ctx.signal?.addEventListener('abort', interrupt, { once: true })
          if (ctx.signal?.aborted) interrupt()
        })])
      } finally {
        clearTimeout(timer)
        if (interrupt) ctx.signal?.removeEventListener('abort', interrupt)
      }
    }
    try {
      try {
        await startMedia(el)
      } catch (error) {
        ctx.signal?.throwIfAborted()
        const primary = playback(item, false).url
        const alternate = playback(item, true).url
        if (!alternate || alternate === primary || el.dataset.playbackFallback === 'true' ||
            (error instanceof DOMException && error.name === 'NotAllowedError')) throw error
        // The failing primary can reject play before React attaches its fallback.
        const deadline = performance.now() + 1000
        while (media.current?.dataset.playbackFallback !== 'true' && performance.now() < deadline) {
          ctx.signal?.throwIfAborted()
          await wait(50)
        }
        const fallback = media.current
        if (!fallback || fallback.dataset.playbackFallback !== 'true') throw error
        await startMedia(fallback)
      }
    } catch (error) {
      ctx.signal?.throwIfAborted()
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError'
      await rux('startup', 'pods', blocked ? 'autoplay_blocked' : 'failed', ctx, { item, elapsed: performance.now() - start, feedSessionId })
      throw new Check(blocked ? 'blocked' : 'failed', blocked ? 'The browser requires a play gesture. Start the item, then rerun the check.' : errorText(error))
    }
    let receipt = false
    let target: RuxTarget | undefined
    const previous = observed.current.played
    const deadline = start + (qualify ? 65_000 : 15_000)
    while (performance.now() < deadline) {
      ctx.signal?.throwIfAborted()
      const state = observed.current
      if (state.error) {
        await rux('startup', 'pods', 'failed', ctx, { item, elapsed: performance.now() - start, progress: state, feedSessionId })
        throw new Check('failed', state.error)
      }
      if (state.played - previous >= 0.25 && !receipt) {
        receipt = true
        target = await rux('startup', 'pods', 'success', ctx, { item, elapsed: performance.now() - start, progress: state, feedSessionId })
      }
      if (receipt && (!qualify || consumption(state.played, state.furthest, item.duration_sec || 0))) return target
      await wait(200)
    }
    if (!receipt) await rux('startup', 'pods', 'timeout', ctx, { item, elapsed: performance.now() - start, progress: observed.current, feedSessionId })
    throw new Check('failed', qualify ? 'Playback did not reach the qualifying threshold in time.' : 'The media clock did not advance in time.')
  }

  const runDraft = (title: string, verdict: Verdict, entries: Evidence[]): RunDraft => ({
    title, mode, consumer: signed ? scope.consumerID || 'Signed-in consumer' : 'Anonymous · ' + session,
    verdict, sequence: 0, evidence: entries,
  })
  const selectedScenario = scenarios.find(value => value.id === scenario)!
  function checkSettings(): CheckSettings {
    if (preparedRerun) return preparedRerun
    const query = page?.captures[0]?.query
    const targetSurface = selectedScenario.item ? surface : selectedScenario.surface
    const capturedFilters = selectedScenario.item && query ? {
      duration: query.duration ?? '', language: query.content_language ?? '', windowName: query.window ?? windowName,
      savedFilter: query.feed as CheckSettings['savedFilter'] ?? savedFilter, savedSort: query.sort as CheckSettings['savedSort'] ?? savedSort,
    } : {}
    return {
      ...filters, ...capturedFilters, surface: targetSurface, consumerId: signed ? scope.consumerID : undefined,
      ordinary: targetSurface === 'pods' && query?.contract === 'ordinary',
      itemId: selectedScenario.item ? current?.id : undefined,
      itemTitle: selectedScenario.item ? current?.title?.slice(0, 300) : undefined,
    }
  }
  function checkBlock(following: boolean) {
    if (selectedScenario.writes && mode !== 'test') return 'Switch to Test as user for this check.'
    if (!selectedScenario.item) return
    if (!following) return 'Return to preview item to run an item check.'
    if (preparedRerun) {
      if (preparedRerun.consumerId !== (signed ? scope.consumerID : undefined)) return 'Switch to the saved consumer scope.'
      return
    }
    if (reader || !current || (surface === 'saved' && !(scenario === 'playback' && savedMedia))) {
      return 'Open the item in the phone preview first.'
    }
    if ((scenario === 'playback' || scenario === 'consumption') && surface !== 'pods' && !(scenario === 'playback' && savedMedia)) {
      return 'Open a playable Pods item first.'
    }
  }
  async function runScenario(following: boolean) {
    if (controlsDisabled || running.current || checkBlock(following)) return
    const settings = checkSettings()
    const repeat = Boolean(preparedRerun)
    setPreparedRerun(undefined)
    const controller = new AbortController()
    running.current = controller
    scenarioEvidence.current = []
    const entries = scenarioEvidence.current
    setActive(true); setProblem(''); setNotice('Preparing scenario…'); setLatestRun(undefined)
    const results: CheckResult[] = []
    setCheckResults([])
    let saved: SavedRun | undefined
    let verdict: Verdict = 'passed'
    let restoration: { item: Item; type: Interaction; initial: boolean; expected: boolean | undefined } | undefined
    let storageFailed = false
    const ctx = { signal: controller.signal, record: append }
    const failureVerdict = (error: unknown) => controller.signal.aborted ? 'interrupted' : error instanceof Check ? error.verdict :
      error instanceof RequestError && [401, 403, 409, 410, 429, 503].includes(error.status) ? 'blocked' : 'failed'
    function result(label: string, status: CheckResult['status'], detail?: string) {
      results.push({ label, status, detail: detail?.slice(0, 1000) })
      setCheckResults([...results])
    }
    const persist = async (state: Verdict) => {
      if (!saved) return
      try {
        saved = await lab<SavedRun>(config, '/api/runs?id=' + saved.id, {
          method: 'PATCH', body: JSON.stringify(fitRunEvidence({
            ...saved, verdict: state, sequence: saved.sequence + 1, evidence: entries, checks: results,
          })),
        })
      } catch (error) { storageFailed = true; throw error }
    }
    async function step<T>(label: string, work: () => Promise<T>, detail?: object, passed = label) {
      controller.signal.throwIfAborted()
      setNotice(label)
      record('Scenario step pending', { step: label, ...detail })
      await persist('running')
      controller.signal.throwIfAborted()
      let value: T
      try { value = await work() } catch (error) {
        result(label, failureVerdict(error), errorText(error))
        throw error
      }
      result(passed, 'passed')
      record('Scenario step completed', { step: label })
      await persist('running')
      return value
    }
    async function feedSteps(feed: 'pods' | 'news', ordinary = false) {
      const prefix = ordinary ? 'Ordinary Pods' : feed === 'pods' ? 'Frozen Pods' : 'News'
      const first = await step('Open ' + prefix + ' feed', async () => {
        const value = await load(feed, ctx, undefined, ordinary, settings)
        requireCheck(!value.omitted.length, 'failed', 'The first page violated the preview contract.')
        requireCheck(value.items.length, 'blocked', 'The environment returned no eligible items.')
        return value
      }, undefined, ordinary ? 'Ordinary Pods loaded' : 'Feed loaded')
      if (!first.cursor) {
        result(ordinary ? 'Ordinary Pods pagination unavailable' : 'Pagination unavailable', 'blocked', 'CMS returned no next page.')
        await persist('running')
        return { page: first, index: 0 }
      }
      const second = await step('Load ' + prefix + ' next page', async () => {
        const value = await load(feed, ctx, first, ordinary, settings)
        requireCheck(!value.omitted.length, 'failed', 'The next page violated the item contract.')
        requireCheck(value.items.length > first.items.length, 'unverified', 'The next page contained no new visible items.')
        const ids = value.items.map(item => feed === 'news' ? item.story_id : item.id)
        requireCheck(new Set(ids).size === ids.length, 'failed', 'Feed returned duplicate identities across pages.')
        return value
      }, undefined, ordinary ? 'Ordinary Pods pagination verified' : 'Pagination verified')
      return { page: second, index: first.items.length }
    }
    async function repeatTarget() {
      return step('Find the saved target', async () => {
        requireCheck(settings.itemId, 'blocked', 'The saved run has no exact item target.')
        let candidate = await load(settings.surface, ctx, undefined, settings.ordinary, settings, true)
        for (let count = 0; count < 9 && candidate.cursor && !candidate.items.some(item => item.id === settings.itemId); count++) {
          candidate = await load(settings.surface, ctx, candidate, settings.ordinary, settings, true)
        }
        const index = candidate.items.findIndex(item => item.id === settings.itemId)
        requireCheck(index >= 0, 'blocked', 'The saved target was unavailable in the loaded pages.')
        setFeedIssue(undefined); setFreshness(undefined); setSurface(settings.surface); setPage(candidate); setPosition(index)
        if (settings.surface === 'saved') setSavedMedia(candidate.items[index])
        await verifyPreview(candidate.items[index], ctx)
        return { item: candidate.items[index], feedSession: candidate.session_id }
      }, { item: settings.itemId })
    }
    try {
      saved = await lab<SavedRun>(config, '/api/runs', { method: 'POST', body: JSON.stringify({
        ...runDraft(selectedScenario.label, 'running', []), scenario, restore, settings, checks: [],
      }) })
      pageRun.current = saved.id
      setLatestRun(saved.id)
      if (scenario === 'pods' || scenario === 'news') {
        const { page: loaded, index } = await feedSteps(scenario)
        if (scenario === 'news') await step('Open article', () => openReader(loaded.items[index], ctx), undefined, 'Reader opened')
        if (scenario === 'pods') await feedSteps('pods', true)
      } else if (scenario === 'playback' || scenario === 'consumption') {
        const target = repeat ? await repeatTarget() : { item: current, feedSession: page?.session_id }
        const item = target.item
        requireCheck(item, 'blocked', 'No playable Pods item is available.')
        if (scenario === 'consumption') await step('Observe and save view', () => sendView(item, ctx, target.feedSession), { item: item.id })
        const startup = await step('Observe the media clock', () => play(item, ctx, scenario === 'consumption', target.feedSession))
        if (scenario === 'consumption') {
          await step('Save qualified consumption', () => sendConsumption(item, ctx), { item: item.id })
          await step('Read back exact RUX event', () => verifyRux(ctx, startup))
        }
      } else {
        const target = repeat ? (await repeatTarget()).item : current
        requireCheck(target && (repeat || !reader && surface !== 'saved'), 'blocked', 'Select a feed card in News or Pods first.')
        const type = scenario
        const initial = await step('Read initial state', () => readInteraction(target, type, ctx))
        restoration = { item: target, type, initial, expected: initial }
        const states = initial ? [false, true] : [true, false]
        for (const desired of states) {
          await step(desired ? 'Set ' + type : 'Remove ' + type, async () => {
            const previous = await readInteraction(target, type, ctx)
            requireCheck(previous === restoration!.expected, 'unverified', 'The item changed outside this scenario.')
            restoration!.expected = undefined
            await setInteraction(target, type, desired, ctx)
            restoration!.expected = desired
            if (type === 'like') {
              const updated = await waitForPreview(() => matchingPreview(target)?.querySelector('[data-interaction="like"]')
                ?.getAttribute('aria-pressed') === String(desired), ctx.signal)
              requireCheck(updated, 'unverified', 'The visible like control did not reflect the confirmed state.')
              withItem(ctx, target).record({ at: now(), label: 'Like control verified', detail: { pressed: desired } })
            }
            if (type === 'bookmark' && desired) {
              let list = await load('saved', ctx, undefined, false, { ...filters, savedFilter: 'all', savedSort: 'saved_desc' })
              for (let i = 0; i < 9 && list.cursor && !list.items.some(item => item.id === target.id); i++) {
                list = await load('saved', ctx, list)
              }
              const savedIndex = list.items.findIndex(item => item.id === target.id)
              if (savedIndex >= 0) setPosition(savedIndex)
              requireCheck(savedIndex >= 0,
                'unverified', 'The bookmark could not be read back in Saved.')
              await verifyPreview(list.items[savedIndex], ctx)
            }
          }, { item: target.id, type, desired })
        }
        if (type === 'bookmark') await step('Refresh visible Saved list', () => load('saved', ctx))
      }
      if (results.some(check => check.status !== 'passed')) verdict = 'unverified'
      else record('Assertion passed', { scenario })
    } catch (error) {
      if (error instanceof RequestError && error.status === 401) refreshIdentity()
      verdict = failureVerdict(error)
      if (verdict === 'blocked' && results.some(check => check.status === 'passed' && check.label !== 'Find the saved target')) verdict = 'unverified'
      record('Scenario ' + verdict, errorText(error))
      setProblem(errorText(error))
    } finally {
      media.current?.pause()
      if (restoration) {
        const { item, type, initial, expected } = restoration
        if (!restore) record('Restoration disabled', { item: item.id, type })
        else if (!storageFailed && expected !== undefined && !document.hidden && phone.current) {
          try {
            record('Restoration pending', { item: item.id, type, initial, expected })
            await persist('running')
            const clean = { record: append }
            const observed = await readInteraction(item, type, clean)
            requireCheck(observed === expected, 'unverified', 'Reversible state changed after the test.')
            if (observed !== initial) await setInteraction(item, type, initial, clean)
            record('Restoration verified', { item: item.id, type, initial })
            result('Restoration verified', 'passed')
          } catch (error) {
            record('Restoration unverified', errorText(error))
            result('Restoration', 'unverified', errorText(error))
            if (verdict === 'passed') verdict = 'unverified'
          }
        } else {
          record('Restoration unverified', 'Review the item state manually before repeating this run.')
          result('Restoration', 'unverified', 'Review the item state manually before repeating this run.')
          if (verdict === 'passed') verdict = 'unverified'
        }
      }
      if (!storageFailed && saved) {
        try { await persist(verdict) } catch (error) { setProblem(errorText(error)) }
      }
      const partial = verdict === 'unverified' && results.some(check => check.status === 'passed')
      setNotice(storageFailed ? 'The last step could not be saved. Reopen the acknowledged evidence.' : partial ? 'Partial coverage' : 'Scenario ' + verdict)
      pageRun.current = undefined
      running.current = null; scenarioEvidence.current = null; setActive(false)
    }
  }

  const controlsDisabled = !operatorReady || locked || needsConsumerSignIn
  const writesDisabled = controlsDisabled || mode !== 'test'
  const playbackAction = useRef<{ key?: string; id: string } | null>(null)
  useEffect(() => {
    if (!selected) return
    const id = requestAnimationFrame(() => {
      if (!phone.current?.querySelector(reader ? '.article-reader' : '.consumer-card[data-item-id="' + selected.id + '"]')) return
      append(itemEvidence({ at: now(), label: reader ? 'Reader rendered' : 'Preview rendered', detail: { item: selected.id } }, selected))
    })
    return () => cancelAnimationFrame(id)
    // Only record an actual preview transition.
  }, [selected?.id, selected?.capture?.id, Boolean(reader)])
  function reportPlayback(label: string, detail: unknown) {
    if (!current) return
    if (playbackAction.current?.key !== mediaKey || !playbackAction.current) {
      playbackAction.current = { key: mediaKey, id: crypto.randomUUID() }
    }
    append(itemEvidence({ at: now(), label, detail: redact(detail) }, current, playbackAction.current.id))
  }
  function saveInspection(inspection?: InspectionSnapshot, note?: string) {
    return action(async () => {
      const entries = inspection ? evidence.filter(entry =>
        belongs(entry, inspection.itemId, inspection.storyId, inspection.capture, inspection.storyView)) : evidence
      const draft = runDraft((inspection?.title ?? 'Feed investigation').slice(0, 150), 'saved', [...entries].reverse())
      const run = await lab<SavedRun>(config, '/api/runs', {
        method: 'POST', body: JSON.stringify(fitRunEvidence({ ...draft, inspection, note, trimmed: evidenceCount > evidence.length })),
      })
      setLatestRun(run.id); setNotice('Investigation saved.')
    })
  }
  const activeSnapshot = useMemo(() => page?.captures.length ? feedSnapshot(page, config, evidence) : undefined, [page, config, evidence])
  const comparison = useMemo(() => baseline && activeSnapshot && baseline.capture.pages[0].surface === activeSnapshot.pages[0].surface
    ? { baseline: baseline.capture, current: activeSnapshot } : undefined, [baseline, activeSnapshot])
  const comparisonEvidence = useMemo(() => baseline ? [...new Map([...baseline.evidence, ...evidence].map(entry => [entry.id, entry])).values()] : [],
    [baseline, evidence])
  function pinBaseline() {
    if (!activeSnapshot || !scope.operatorID || locked) return
    const pages = new Set(activeSnapshot.pages.map(capture => capture.id))
    setPin({ operator: scope.operatorID, capture: structuredClone(activeSnapshot),
      evidence: structuredClone(evidence.filter(entry => entry.captureId && pages.has(entry.captureId))) })
    setShowComparison(true)
    setComparisonNote('')
  }
  function saveComparison() {
    if (!comparison) return
    return action(async () => {
      const pages = new Set([...comparison.baseline.pages, ...comparison.current.pages].map(capture => capture.id))
      const entries = comparisonEvidence.filter(entry => entry.captureId && pages.has(entry.captureId)).sort((a, b) => a.at.localeCompare(b.at))
      const run = await lab<SavedRun>(config, '/api/runs', {
        method: 'POST', body: JSON.stringify(fitRunEvidence({
          ...runDraft('Feed comparison · ' + comparison.current.pages[0].surface, 'saved', entries),
          comparison, note: comparisonNote.trim() || undefined,
        })),
      })
      setLatestRun(run.id); setNotice('Comparison saved.'); setComparisonNote('')
    })
  }
  const repeatable = rerun.data?.settings && scenarios.find(value => value.id === rerun.data?.scenario)
  const matchingConsumer = !!rerun.data?.settings &&
    (rerun.data.settings.consumerId ? signed && identities.consumer.state === 'signed-in' && rerun.data.settings.consumerId === scope.consumerID : !signed)
  function prepareRerun() {
    const source = rerun.data
    if (!source?.settings || !repeatable || !matchingConsumer || locked) return
    reset()
    setMode(source.mode); setScenario(repeatable.id); setRestore(source.restore ?? true)
    setSurface(source.settings.surface); setDuration(source.settings.duration); setLanguage(source.settings.language); setWindowName(source.settings.windowName)
    setSavedFilter(source.settings.savedFilter ?? 'all'); setSavedSort(source.settings.savedSort ?? 'saved_desc')
    setPreparedRerun(source.settings); setMobileView('details')
  }
  async function openFeed(feed: Surface) {
    if (controlsDisabled) return
    setLoadingFeed(feed)
    try { await action(async ctx => { await load(feed, ctx) }) }
    finally { setLoadingFeed(undefined) }
  }
  const openInitialFeed = useEffectEvent(() => {
    if (!rerunId && mode === 'inspect' && !signed && !reloadConsumerFeed) void openFeed('pods')
  })
  const openedForOperator = useRef<string | undefined>(undefined)
  const readyOperator = operatorReady ? identities.operator.id : undefined
  useEffect(() => {
    if (openedForOperator.current === readyOperator || (readyOperator && controlsDisabled)) return
    openedForOperator.current = readyOperator
    if (readyOperator) openInitialFeed()
  }, [readyOperator, controlsDisabled])
  const openConsumerFeed = useEffectEvent(() => {
    setReloadConsumerFeed(false)
    void openFeed(surface)
  })
  useEffect(() => {
    if (reloadConsumerFeed && !controlsDisabled) openConsumerFeed()
  }, [reloadConsumerFeed, controlsDisabled])
  const changeDuration = (value: string) => void action(async ctx => {
    await load('pods', ctx, undefined, false, { ...filters, duration: value })
    setDuration(value)
  })
  const changeWindow = (value: string) => void action(async ctx => {
    await load('news', ctx, undefined, false, { ...filters, windowName: value })
    setWindowName(value)
  })
  const onRead = (item: Item, coverage?: Item[]) => void action(ctx => openReader(item, ctx, coverage))
  const changeSaved = (filter: typeof savedFilter, sort: typeof savedSort) => void action(async ctx => {
    await load('saved', ctx, undefined, false, { ...filters, savedFilter: filter, savedSort: sort })
    setSavedFilter(filter); setSavedSort(sort)
  })
  function openSaved(item: Item, index: number) {
    if (controlsDisabled) return
    setPosition(index)
    const mediaItem = item.type === 'PODCAST' || item.type === 'VIDEO' ||
      (!['NEWS', 'ARTICLE', 'TWEET', 'COMMENT'].includes(item.type ?? '') && !!playback(item, false).url)
    if (mediaItem) {
      if (!playback(item, false).url) { setProblem('Saved item has no approved playback source.'); return }
      setProblem(''); setSavedMedia(item)
    } else onRead(item)
  }
  function backToSaved() {
    setSavedMedia(null)
    setReader(null)
    phone.current?.focus({ preventScroll: true })
  }
  function checkFreshness() {
    if (!page?.session_id) return
    void action(async ctx => {
      try {
        const result = await request<{ has_new_content?: boolean }>('/feed/pods/sessions/' + page.session_id + '/freshness', ctx)
        setFreshness(result.has_new_content === true ? 'available' : result.has_new_content === false ? 'current' : undefined)
        setFeedIssue(undefined)
      } catch (error) {
        if (!ctx.signal?.aborted) setFeedIssue({ feed: 'pods', operation: 'freshness', message: errorText(error),
          session: error instanceof RequestError && error.status === 410 ? 'expired' :
            error instanceof RequestError && error.status === 409 && /session.*stale/i.test(error.message) ? 'stale' : undefined })
        throw error
      }
    })
  }
  function retryFeed(issue: FeedIssue) {
    if (issue.operation === 'freshness') { checkFreshness(); return }
    void action(async ctx => {
      const previous = issue.operation === 'page' && surface === issue.feed ? page ?? undefined : undefined
      await load(issue.feed, ctx, previous, issue.ordinary, issue.filters)
      if (!previous && issue.filters) {
        setDuration(issue.filters.duration); setLanguage(issue.filters.language); setWindowName(issue.filters.windowName)
        setSavedFilter(issue.filters.savedFilter ?? 'all'); setSavedSort(issue.filters.savedSort ?? 'saved_desc')
      }
    })
  }
  const onInteraction = (item: Item, kind: Interaction) => void action(ctx =>
    setInteraction(item, kind, !(kind === 'like' ? item.is_liked : item.is_bookmarked), ctx))
  const move = (delta: number) => {
    if (!page || controlsDisabled || reader || savedMedia || surface === 'saved') return
    if (delta > 0 && position >= page.items.length - 1 && page.cursor && !sessionEnded) {
      void action(async ctx => { await load(surface, ctx, page) })
      return
    }
    setPosition(previous => Math.max(0, Math.min(page.items.length - 1, previous + delta)))
  }
  const canScroll = (target: EventTarget, delta: number) => {
    if (!(target instanceof Element)) return false
    if (target.closest('[data-pager-control]')) return true
    const slide = target.closest('.news-card')
    if (!slide) return false
    return delta < 0 ? slide.scrollTop > 1 : slide.scrollHeight - slide.clientHeight - slide.scrollTop > 1
  }
  async function finishIdentityChange(slot: IdentitySlot, action: AuthAction) {
    const { data } = await refreshIdentity({ throwOnError: true })
    const signingOut = action === 'logout'
    if (data?.[slot].state !== (signingOut ? 'signed-out' : 'signed-in')) {
      throw new Error(`Feed Lab could not confirm the ${slot} session. Try again.`)
    }
    if (slot === 'operator') {
      reset()
      queryClient.removeQueries({ queryKey: ['runs'] })
      if (signed && !signingOut) setReloadConsumerFeed(true)
    } else if (signed || !signingOut) {
      reset()
      setSigned(!signingOut)
      setReloadConsumerFeed(true)
    }
  }
  const target = checkSettings()
  const search = loadedSearch.trim().toLocaleLowerCase()
  const loadedItems = page?.items.flatMap((item, index) => {
    const candidates = [item, ...(item.members ?? []), ...(item.related ?? []), ...(item.related ?? []).flatMap(story => story.members ?? [])]
    const match = candidates.find(row => !search || [row.title, row.source_name, row.id, row.story_id]
      .some(value => value?.toLocaleLowerCase().includes(search)))
    return match ? [{ item: match, index }] : []
  }) ?? []
  const sessionEnded = expired || Boolean(feedIssue?.session)
  const needsReplacement = sessionEnded || freshness === 'available'
  return <main className="workspace">
    <h1 className="sr-only">Feed Lab</h1>
    <div className="scope-bar">
      <div className="launch">
        <strong>{config.environment}</strong>
        <code title={config.runtime_id} aria-label={'Launch ' + config.runtime_id}>{config.runtime_id.slice(0, 8)}</code>
        <span className="operator-status" data-ready={operatorReady}>Operator {operatorReady ? 'signed in' : identities.operator.state === 'expired' ? 'session expired' : 'signed out'}</span>
        <label>Consumer <select aria-label="Consumer" value={signed ? 'signed' : 'anonymous'} disabled={locked} onChange={event => {
          reset(); setSigned(event.target.value === 'signed'); setReloadConsumerFeed(true)
        }}><option value="anonymous">Anonymous</option><option value="signed">Signed in</option></select></label>
        {signed && <span className="consumer-status" role="status">{needsConsumerSignIn
          ? identities.consumer.state === 'expired' ? 'Consumer session expired' : 'Consumer sign-in required'
          : <bdi>{identities.consumer.email || 'Consumer signed in'}</bdi>}</span>}
      </div>
      <div className="switch" role="group" aria-label="Mode">
        <button aria-pressed={mode === 'inspect'} disabled={locked} onClick={() => { if (mode !== 'inspect') { reset(); setMode('inspect') } }}>Inspect</button>
        <button aria-pressed={mode === 'test'} disabled={locked} onClick={() => { if (mode !== 'test') { reset(); setMode('test') } }}>Test as user</button>
      </div>
    </div>
    <SignIn config={config} identities={identities} locked={locked} busy={authenticating} onBusy={setAuthenticating}
      promptConsumer={operatorReady && needsConsumerSignIn} onChange={finishIdentityChange} />
    {problem && problem !== feedIssue?.message && <p className="problem" role="alert">{problem}</p>}
    {notice && <p className="notice" role="status">{notice}{latestRun && <> · <Link to="/runs/$runId" params={{ runId: latestRun }}>Open run</Link></>}</p>}
    {rerunId && <section className="inspector-block rerun-panel" aria-label="Saved check settings">
      <div className="inspector-section-head"><h2>Saved check settings</h2><Link to="/" search={{}}>Close saved settings</Link></div>
      {rerun.error ? <p role="alert">{errorText(rerun.error)}</p> : !operatorReady ? <p>Sign in as operator to load the saved check.</p> :
        rerun.isPending ? <p role="status">Loading saved check…</p> : !repeatable ? <p>The saved check has no repeatable settings.</p> : <>
          <p>{rerun.data?.title} · {rerun.data?.mode === 'inspect' ? 'Inspect' : 'Test as user'}</p>
          {!matchingConsumer && <p>Switch to {rerun.data?.settings?.consumerId ? 'the consumer account used by the saved check' : 'Anonymous'} to use these settings.</p>}
          <button type="button" disabled={locked || !matchingConsumer || !!preparedRerun} onClick={prepareRerun}>
            {preparedRerun ? 'Settings ready' : 'Use saved settings'}
          </button>
        </>}
    </section>}
    {(activeSnapshot || baseline) && <div className="comparison-tools" aria-label="Baseline controls">
      <button type="button" disabled={controlsDisabled || !activeSnapshot} onClick={pinBaseline}>{baseline ? 'Replace baseline' : 'Pin baseline'}</button>
      {baseline && <>
        <span className="hint">Pinned {baseline.capture.pages[0].surface} · {new Date(baseline.capture.pages[0].at).toLocaleTimeString()}</span>
        <button type="button" aria-expanded={showComparison} onClick={() => setShowComparison(value => !value)}>Compare baseline</button>
        <button type="button" disabled={locked} onClick={() => { setPin(undefined); setShowComparison(false); setComparisonNote('') }}>Clear baseline</button>
      </>}
    </div>}
    {baseline && showComparison && <div className="workspace-comparison">
      {comparison ? <>
        <FeedComparisonView comparison={comparison} evidence={comparisonEvidence} />
        <form className="inspector-save" onSubmit={event => { event.preventDefault(); void saveComparison() }}>
          <label>Comparison note <textarea maxLength={2000} rows={2} value={comparisonNote} onChange={event => setComparisonNote(event.target.value)} /></label>
          <button className="primary" disabled={controlsDisabled}>Save comparison</button>
        </form>
      </> : <p className="hint">Load the {baseline.capture.pages[0].surface} feed in the current scope to compare it with the baseline.</p>}
    </div>}
    <div className="mobile-inspector-switch" role="group" aria-label="Workspace view">
      <button aria-pressed={mobileView === 'preview'} onClick={() => setMobileView('preview')}>Preview</button>
      <button aria-pressed={mobileView === 'details'} onClick={() => setMobileView('details')}>Details</button>
      {active && <button onClick={() => running.current?.abort()}>Stop running check</button>}
    </div>
    <div className="workbench" data-mobile-view={mobileView}>
      <section aria-label="Consumer preview" className="preview-column">
        <div className="section-head"><span>Consumer preview</span><small role="status">{loadingFeed ?
          `Loading ${loadingFeed === 'pods' ? 'Pods' : loadingFeed === 'news' ? 'News' : 'Saved'}…` :
          page ? (page.items.length ? position + 1 : 0) + ' of ' + page.items.length + ' loaded' :
          !operatorReady ? 'Sign in as operator' : needsConsumerSignIn ? 'Sign in as consumer' : 'Ready to load'}</small></div>
        <div className="feed-bar">
          <div className="switch" role="group" aria-label="Feed">
            {(['pods', 'news', 'saved'] as const).map(feed => <button key={feed} aria-pressed={surface === feed}
              disabled={controlsDisabled} onClick={() => openFeed(feed)}>
              {feed === 'pods' ? 'Pods' : feed === 'news' ? 'News' : 'Saved'}
            </button>)}
          </div>
          <span className="hint">{surface === 'pods' ? page && !page.session_id ? 'Ordinary cursor' : 'Frozen session' : surface === 'news' ? windowName : 'Bookmarks'}</span>
        </div>
        {feedIssue && <div className="feed-state" role="alert"><p>{feedIssue.feed === 'news' ? 'News' : feedIssue.feed === 'pods' ? 'Pods' : 'Saved'} request failed · {feedIssue.message}</p>
          {!feedIssue.session && <button type="button" disabled={controlsDisabled} onClick={() => retryFeed(feedIssue)}>Retry feed</button>}
        </div>}
        {surface === 'pods' && page?.session_id && <div className="feed-state" aria-label="Pods session status">
          <span role="status">{feedIssue?.session === 'stale' ? 'Stale generation' : sessionEnded ? 'Session expired' :
            freshness === 'available' ? 'New content available' : page.caughtUp || !page.cursor ? 'Caught up' : 'Frozen session active'}
            {page.expiresAt && !sessionEnded && <> · Expires {new Date(page.expiresAt).toLocaleString()}</>}</span>
          {needsReplacement ? <button type="button" disabled={controlsDisabled} onClick={() => void openFeed('pods')}>Load new content</button> :
            <button type="button" disabled={controlsDisabled} onClick={checkFreshness}>Check freshness</button>}
          {freshness === 'current' && <small className="hint">CMS reports no new content.</small>}
        </div>}
        {surface === 'news' && !!page?.omissions.length && <p className="feed-state" role="status">{page.omissions.length} returned rows omitted by the preview. See Evidence for details.</p>}
        <article ref={phone} aria-label="Feed card" data-preview-capture={selected?.capture?.id} data-preview-row={selected?.responseRow}
          tabIndex={0} className={'phone phone-' + surface}
          onKeyDown={event => {
            if (event.target === event.currentTarget && !reader && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
              event.preventDefault()
              move(event.key === 'ArrowDown' ? 1 : -1)
            }
          }}
          onTouchStart={event => {
            touchStart.current = !reader && event.target instanceof Element && !event.target.closest('[data-pager-control]')
              ? event.touches[0]?.clientY ?? null : null
          }}
          onTouchCancel={() => { touchStart.current = null }}
          onTouchEnd={event => {
            if (touchStart.current !== null && !reader && event.changedTouches[0]) {
              const delta = touchStart.current - event.changedTouches[0].clientY
              if (Math.abs(delta) > 55 && !canScroll(event.target, delta)) move(Math.sign(delta))
            }
            touchStart.current = null
          }}
          onWheel={event => {
            if (!reader && Math.abs(event.deltaY) > 25 && !canScroll(event.target, event.deltaY) && performance.now() - lastSwipe.current > 350) {
              lastSwipe.current = performance.now(); move(Math.sign(event.deltaY))
            }
          }}>
          {!reader && !savedMedia && <FeedHeader key={surface} surface={surface} duration={duration} windowName={windowName}
            disabled={controlsDisabled} onFeed={openFeed} onDuration={changeDuration} onWindow={changeWindow} />}
          {reader ? <ArticleReader key={reader.item.id} reader={reader} disabled={locked} writesDisabled={writesDisabled}
            onBack={backToSaved} onRead={onRead} onInteraction={onInteraction} />
            : playingItem ? <>
              {savedMedia && <button className="saved-back" type="button" onClick={backToSaved} disabled={locked}>Back to Saved</button>}
              <Player key={mediaKey} item={playingItem} media={media} report={reportPlayback}
                observed={value => { observed.current = value; setProgress(value) }}
                disabled={locked} writesDisabled={writesDisabled}
                display={{ audio: audioDisplay, video: videoDisplay }}
                onDisplay={(audio, display) => {
                  if (audio && (display === 'listen' || display === 'transcript')) setAudioDisplay(display)
                  if (!audio && display !== 'listen') setVideoDisplay(display)
                }}
                onInteraction={onInteraction} readTranscript={async (id, signal) => {
                  const result = await queryClient.fetchQuery(transcriptQuery({ scope, item: playingItem, record: append }, id, playingItem))
                  signal.throwIfAborted()
                  return result
                }} />
              </> : surface === 'news' && current ?
                <NewsPreview key={current.id} item={current} disabled={controlsDisabled} writesDisabled={writesDisabled}
                  onRead={onRead} onInteraction={onInteraction} />
                : surface === 'saved' && page ? <SavedLibrary key={page.captures[0]?.id} items={page.items} index={position} scroll={savedScroll}
                  disabled={controlsDisabled} writesDisabled={writesDisabled} filter={(page.captures[0]?.query.feed as typeof savedFilter) ?? savedFilter}
                  sort={(page.captures[0]?.query.sort as typeof savedSort) ?? savedSort} hasMore={!!page.cursor}
                  onFilter={filter => changeSaved(filter, savedSort)} onSort={sort => changeSaved(savedFilter, sort)} onOpen={openSaved}
                  onRemove={item => void action(ctx => setInteraction(item, 'bookmark', false, ctx))}
                  onMore={() => void action(async ctx => { await load('saved', ctx, page) })} />
              : <div className="phone-empty" lang="ar" dir="rtl" data-pager-control>
                <span>{surface === 'pods' ? 'سمعيات' : surface === 'news' ? 'الأخبار' : 'المحفوظات'}</span>
                <p>{busy ? 'جارٍ تحميل المحتوى…' : feedIssue?.feed === surface ? 'تعذر تحميل المحتوى.' :
                  page?.omissions.length ? 'تعذر عرض العناصر التي أعادها الموجز.' : page ? surface === 'news' ? 'لا توجد أخبار في هذه الفترة.' : 'لا يوجد محتوى لعرضه.' :
                  !operatorReady ? 'سجّل دخول المشغّل لعرض المحتوى.' : needsConsumerSignIn ? 'سجّل دخول المستخدم لعرض المحتوى.' : 'اختر موجزًا لعرض المحتوى.'}</p>
                {page && surface === 'news' && <div className="phone-empty-actions">
                  {!page.omissions.length && !feedIssue && windowName !== 'month' && <button type="button" className="phone-empty-month" disabled={controlsDisabled}
                    onClick={() => changeWindow('month')}>عرض أخبار هذا الشهر</button>}
                  <button type="button" disabled={controlsDisabled} onClick={() => void openFeed('news')}>تحديث</button>
                </div>}
              </div>}
        </article>
        <div className="inline feed-controls">
          {surface !== 'saved' && <>
            <button disabled={locked || !!reader || position <= 0} onClick={() => move(-1)}>Previous</button>
            <button disabled={locked || !!reader || !page || position >= page.items.length - 1} onClick={() => move(1)}>Next item</button>
            <button disabled={controlsDisabled || !page?.cursor || (surface === 'pods' && sessionEnded)} onClick={() => void action(async ctx => { await load(surface, ctx, page!) })}>Next page</button>
          </>}
          <button disabled={controlsDisabled} onClick={() => void action(async ctx => { await load(surface, ctx, undefined, surface === 'pods' && page?.captures[0]?.query.contract === 'ordinary') })}>Refresh</button>
        </div>
        {page && <details className="preview-tools">
          <summary>Loaded items · {page.items.length}<ChevronDown size={14} /></summary>
          <label className="loaded-search">Search loaded items <input type="search" value={loadedSearch} onChange={event => setLoadedSearch(event.target.value)} /></label>
          <ul className="loaded-items">{loadedItems.map(({ item, index }) => <li key={item.id + '/' + index}>
            <button type="button" disabled={locked} onClick={() => { setReader(null); setSavedMedia(null); setPosition(index); phone.current?.focus() }}>
              <span>#{index + 1}</span> <bdi>{item.title || item.id}</bdi>{item.source_name && <small dir="auto">{item.source_name}</small>}
            </button>
          </li>)}</ul>
          {!loadedItems.length && <p className="hint">No matching loaded items.</p>}
        </details>}
        <details className="preview-tools">
          <summary>Feed options <ChevronDown size={14} /></summary>
          <div className="inline">
            {surface === 'pods' && <label>Content language <select value={language} disabled={locked} onChange={e => setLanguage(e.target.value)}>
              <option value="">Default</option><option value="ar">Arabic</option><option value="en">English</option>
            </select></label>}
            <button disabled={controlsDisabled} onClick={() => void action(async ctx => { await load('pods', ctx, undefined, true) })}>Ordinary Pods</button>
          </div>
          {surface === 'pods' && <p className="hint">Refresh to apply the content language.</p>}
        </details>
      </section>
      <ItemInspector key={inspectionEpoch} scope={scope} ready={operatorReady && (!signed || identities.consumer.state === 'signed-in')}
        locked={controlsDisabled} item={selected} page={page} surface={surface} reader={reader}
        evidence={evidence} trimmed={evidenceCount > evidence.length} onEvidence={append}
        progress={progress} media={media} onSave={saveInspection} openChecks={!!preparedRerun}
        onPreview={() => setMobileView('preview')}
        onVerify={(event, item) => void action(ctx => verifyRux(ctx, { ...event, item }))}
        onView={current && !reader && surface !== 'saved' ? () => {
          setMobileView('preview')
          void action(async ctx => { await frame(); await sendView(current, ctx) })
        } : undefined}
        onPlay={playingItem ? () => {
          setMobileView('preview')
          void action(async ctx => {
            await play(playingItem, ctx)
            setNotice(observed.current.fallback ? 'Playback advanced on the fallback source.' : 'Playback advanced.')
          })
        } : undefined}
        onConsumption={current && surface === 'pods' ? () => void action(ctx => sendConsumption(current, ctx)) : undefined}
        onPreferences={signed ? () => void action(async ctx => {
          await request('/preferences', selected ? withItem(ctx, selected) : ctx)
        }) : undefined}
        checks={following => <>
          <label>Scenario <select aria-label="Scenario" value={scenario} disabled={locked || !!preparedRerun} onChange={e => setScenario(e.target.value as Scenario)}>
            {scenarios.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
          </select></label>
          <dl className="inspector-facts" aria-label="Check target">
            <div><dt>Environment</dt><dd>{config.environment}</dd></div>
            <div><dt>Mode</dt><dd>{mode === 'inspect' ? 'Inspect' : 'Test as user'}</dd></div>
            <div><dt>Consumer</dt><dd dir="auto">{signed ? identities.consumer.email || scope.consumerID || 'Signed in' : 'Anonymous'}</dd></div>
            <div><dt>Feed scope</dt><dd>{target.surface === 'pods'
              ? ['Pods', selectedScenario.item ? target.ordinary ? 'Ordinary cursor' : 'Frozen session' : 'Frozen session and ordinary cursor',
                target.duration ? target.duration + ' min' : 'Any duration', target.language || 'Default language'].join(' · ')
              : target.surface === 'news' ? 'News · ' + target.windowName : 'Saved · ' + (target.savedFilter || 'all') + ' · ' + (target.savedSort === 'saved_asc' ? 'Oldest first' : 'Newest first')}</dd></div>
            {selectedScenario.item && <div><dt>Item</dt><dd><bdi>{target.itemTitle || target.itemId || 'None selected'}</bdi>
              {target.itemId && <code className="check-target-id" dir="ltr">{target.itemId}</code>}</dd></div>}
          </dl>
          {(scenario === 'like' || scenario === 'bookmark') && <label><input type="checkbox" checked={restore}
            disabled={locked || !!preparedRerun} onChange={e => setRestore(e.target.checked)} /> Restore likes and bookmarks after the run</label>}
          <div className="inline"><button className="primary" disabled={controlsDisabled || !!checkBlock(following)} onClick={() => {
            setMobileView('preview'); void runScenario(following)
          }}>Run scenario</button>
          {active && <button onClick={() => running.current?.abort()}>Stop scenario</button>}</div>
          {checkBlock(following) && <p className="hint">{checkBlock(following)}</p>}
          {checkResults.length > 0 && <ul className="check-results" aria-label="Check results">{checkResults.map((check, index) =>
            <li key={index}><strong>{check.label}</strong> <span>{check.status}</span>{check.detail && <p className="hint">{check.detail}</p>}</li>)}</ul>}
          <EvidenceList entries={evidence.filter(entry => /^(Scenario|Assertion|Restoration)/.test(entry.label))} />
        </>} />

    </div>
  </main>
}

export function EvidenceList({ entries }: { entries: Evidence[] }) {
  if (!entries.length) return <p className="empty">Evidence appears here after you open a feed or run a check.</p>
  return <div className="evidence-list">{entries.map((entry, index) => {
    const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail as Record<string, unknown> : undefined
    const summary = typeof detail?.step === 'string' ? detail.step : typeof detail?.status === 'number' ? 'HTTP ' + detail.status : ''
    return <details key={entry.at + index}>
      <summary><span>{entry.label}</span>{summary && <span className="evidence-caption"> · {summary}</span>}
        <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time></summary>
      <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
    </details>
  })}</div>
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && !!value.trim())
}

async function reveal(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  if (!document.hidden && visibleHeight(rect) < rect.height / 2) {
    element.scrollIntoView({ block: 'center' })
    await frame()
  }
}
