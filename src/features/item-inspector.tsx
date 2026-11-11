import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Clipboard, Search } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { lab, owner, RequestError, type Scope } from '../lib/client'
import type { Evidence, InspectionSnapshot } from '../lib/evidence'
import { asset, belongs, comparisonFields, duration, fields, responseRow, rows, text, time, valueText, type Fields } from '../lib/inspection'
import { consumption, consumptionThreshold, safeURL, validID, type Item, type Page } from '../lib/feed'
import { formatTranscriptTime, normalizeTranscript } from '../lib/transcript-model'
import { PreviewImage, type Reader, type Surface } from './consumer-preview'
import type { Progress } from './player'

const tabs = ['Overview', 'Content', 'Journey', 'Activity', 'Evidence'] as const
type Tab = typeof tabs[number]
type RecordEntry = (entry: Evidence) => void
type ReadContext = { scope: Scope; item?: Item; record: RecordEntry }
type EventTarget = { id: string; journey: string; actionId?: string; captureId?: string }
type Selection = { id: string; item?: Item; story?: boolean }
type ActionGroup = { id: string; entries: Evidence[] }
type Jump = (tab: Tab, entry?: string) => void
const requestEntry = (entry: Evidence) => /^(GET|POST|DELETE) /.test(entry.label)

function capturedItem(page: Page | null, id: string) {
  for (const item of page?.items ?? []) {
    if (item.id === id || item.story_id === id) return item
    const related = item.related ?? []
    const relative = [...(item.members ?? []), ...related, ...related.flatMap(story => story.members ?? [])]
      .find(value => value.id === id || (!value.responseRow?.includes('.members[') && value.story_id === id))
    if (relative) return relative
  }
}

function scopeKey(scope: Scope) {
  return [scope.health.runtime_id, scope.operatorID, scope.mode, scope.signed ? scope.consumerID : scope.session]
}

function readOwner(context: ReadContext, path: string, signal: AbortSignal, query?: Record<string, string>) {
  const { scope, item, record } = context
  return owner<unknown>(scope, path, {
    signal, query, record: entry => {
      if (signal.aborted) return
      record({ ...entry, itemId: item?.id, storyId: item?.story_id, captureId: item?.capture?.id })
    },
  })
}

function useRead(context: ReadContext, path: string, enabled: boolean, params?: Record<string, string>) {
  return useQuery({
    queryKey: ['inspector', ...scopeKey(context.scope), context.item?.id, context.item?.capture?.id, path, params],
    enabled, staleTime: 60_000, retry: false, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => readOwner(context, path, signal, params),
  })
}

export function transcriptQuery(context: ReadContext, transcriptId: string, item: Item) {
  return {
    queryKey: ['inspector', ...scopeKey(context.scope), 'transcript', item.id, item.capture?.id, transcriptId, item.duration_sec],
    staleTime: 60_000, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const payload = fields(await readOwner(context, '/transcripts/' + transcriptId, signal))
      const data = fields(payload.data)
      if (data.content_item_id !== item.id) throw new Error('CMS returned a transcript for a different item.')
      return normalizeTranscript(text(data.full_text), data.segments ?? data.word_timestamps, item.duration_sec)
    },
  }
}

function ReadStatus({ query, empty }: { query: { isFetching: boolean; error: unknown }; empty?: string }) {
  if (query.error) {
    const code = query.error instanceof RequestError ? query.error.status : undefined
    const message = code === 403 ? 'Your operator account cannot read this evidence.' :
      code === 404 ? 'CMS could not find this record.' :
        query.error instanceof Error ? query.error.message : 'Evidence is unavailable.'
    return <p className="inspector-message" role="alert">{message}</p>
  }
  if (query.isFetching) return <p className="hint" role="status">Loading evidence…</p>
  return empty ? <p className="hint">{empty}</p> : null
}

function CopyID({ id }: { id: string }) {
  const [status, setStatus] = useState('')
  return <span className="copy-id"><code dir="ltr" title={id}>{id}</code>
    <button aria-label="Copy content ID" onClick={async () => {
      try { await navigator.clipboard.writeText(id); setStatus('Copied') }
      catch { setStatus('Select the ID to copy it.') }
    }}><Clipboard size={14} /></button>{status && <small aria-live="polite">{status}</small>}</span>
}

export function CaptureScope({ capture }: { capture: InspectionSnapshot['capture'] }) {
  if (!capture) return <span className="hint">No feed capture</span>
  return <dl className="capture-scope">
    <div><dt>Captured</dt><dd>{time(capture.at)}</dd></div>
    <div><dt>Feed</dt><dd>{capture.surface} · {capture.mode === 'test' ? 'Test as user' : 'Inspect'}</dd></div>
    <div><dt>Consumer</dt><dd dir="auto">{capture.consumer}</dd></div>
    {capture.session && <div><dt>Frozen session</dt><dd><code>{capture.session}</code></dd></div>}
    <div><dt>Filters</dt><dd>{Object.entries(capture.query).filter(([key]) => !['cursor', 'limit'].includes(key))
      .map(([key, value]) => key.replaceAll('_', ' ') + ' = ' + value).join(' · ') || 'Default'}</dd></div>
  </dl>
}

export function FieldComparison({ columns }: { columns: { label: string; values: Record<string, string> }[] }) {
  const names = [...new Set(columns.flatMap(column => Object.keys(column.values)))]
  if (!names.length) return <p className="hint">No fields have been captured.</p>
  return <div className="comparison-scroll" tabIndex={0} aria-label="Field comparison">
    <table className="inspector-table">
      <thead><tr><th scope="col">Field</th>{columns.map(column => <th scope="col" key={column.label}>{column.label}</th>)}</tr></thead>
      <tbody>{names.map(name => {
        const values = columns.map(column => column.values[name])
        const changed = new Set(values.filter(value => value !== undefined)).size > 1
        return <tr key={name} data-changed={changed}>
          <th scope="row">{name}{changed && <small>Changed</small>}</th>
          {values.map((value, index) => <td key={columns[index].label} dir="auto">{value ?? 'Unavailable'}</td>)}
        </tr>
      })}</tbody>
    </table>
  </div>
}

export function RequestRows({ entries, focus }: { entries: Evidence[]; focus?: string }) {
  if (!entries.length) return <p className="hint">No requests for this selection.</p>
  return <div className="inspector-records">{entries.map((entry, index) => {
    const detail = fields(entry.detail)
    const response = fields(detail.response)
    const data = fields(response.data)
    const result = response.items ?? response.slides ?? data.items ?? data.slides
    const status = valueText(detail.status)
    const title = entry.label === 'Preview adaptation' ? 'Adapt feed response' :
      entry.label.includes('/feed/pods/sessions') ? 'Load Pods session' :
        entry.label.includes('/feed/news') ? 'Load News feed' :
          entry.label.endsWith('/trace-summary') ? 'Read delivery summary' : entry.label
    return <details key={entry.id ?? entry.at + index} id={entry.id ? 'evidence-' + entry.id : undefined} open={entry.id === focus || undefined}>
      <summary><strong>{title}</strong><span>{[status, typeof detail.elapsed_ms === 'number' && detail.elapsed_ms + ' ms',
        Array.isArray(result) && result.length + ' returned'].filter(Boolean).join(' · ')}</span></summary>
      <div className="record-body">
        <p className="hint">{time(entry.at)}{entry.requestId && <> · <code>{entry.requestId}</code></>}</p>
        {Array.isArray(detail.omitted) && detail.omitted.length > 0 && <ul>{detail.omitted.map((reason, index) => <li key={index}>{String(reason)}</li>)}</ul>}
        <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
      </div>
    </details>
  })}</div>
}

function activityGroups(entries: Evidence[]) {
  const groups = new Map<string, ActionGroup>()
  for (const [index, entry] of entries.entries()) {
    if (!entry.actionId && !/^(Playback|RUX|View|Consumption|Reader rendered|Preview rendered|Signal|Scenario|Restoration)/.test(entry.label)) continue
    const id = entry.actionId ?? entry.id ?? entry.at + index
    const group = groups.get(id) ?? { id, entries: [] }
    group.entries.push(entry)
    groups.set(id, group)
  }
  return [...groups.values()]
}

export function Activity({ entries, mode, onVerify, locked, focus }: {
  entries: Evidence[]; mode: Scope['mode']; onVerify?: (target: EventTarget, entry: Evidence) => void; locked?: boolean; focus?: string
}) {
  const groups = activityGroups(entries)
  if (!groups.length) return <p className="hint">No activity recorded for this selection.</p>
  return <div className="inspector-records">{groups.map(group => {
    const observed = group.entries.find(entry => entry.label === 'RUX browser observation')
    const event = fields(fields(observed?.detail).event)
    const eventID = text(event.event_id)
    const journey = text(event.journey_id)
    const receipt = eventID && group.entries.find(entry => entry.label === 'RUX ingest receipt' && fields(entry.detail).event_id === eventID)
    const readback = eventID && group.entries.find(entry => entry.label === 'RUX exact event readback' && fields(entry.detail).event_id === eventID)
    const accepted = !!receipt && (Number(fields(receipt.detail).accepted) > 0 || Number(fields(receipt.detail).duplicate) > 0)
    const write = group.entries.find(entry => /^(POST|DELETE) \/interactions$/.test(entry.label))
    const writeDetail = fields(write?.detail)
    const interaction = text(fields(writeDetail.request).interaction_type ?? fields(writeDetail.query).type)
    const savedRow = fields(fields(writeDetail.response).data)
    const sent = !!write || group.entries.some(entry => entry.label === 'POST /experience/events')
    const writeAccepted = Number(writeDetail.status) >= 200 && Number(writeDetail.status) < 300
    const confirmed = !!readback && fields(readback.detail).status !== 'unverified'
    const saved = group.entries.some(entry => /^(View|Consumption) persisted$/.test(entry.label)) ||
      !!write?.itemId && !!savedRow.id && savedRow.content_item_id === write.itemId && savedRow.interaction_type === interaction
    const independent = group.entries.some(entry => entry.label === 'Signal persistence readback' &&
      fields(entry.detail).expected === fields(entry.detail).actual)
    const browser = observed || group.entries.find(entry => /observed|rendered|clock advanced/i.test(entry.label))
    const labels: Record<string, string> = { startup: 'Playback check', reader: 'Article opened', feed: 'Feed loaded', pagination: 'Next page loaded' }
    const interactionLabel = interaction === 'like' || interaction === 'bookmark' ?
      (interaction === 'like' ? 'Like' : 'Bookmark') + (write?.label.startsWith('DELETE') ? ' removal' : ' change') : undefined
    const label = labels[String(event.phase)] || interactionLabel || group.entries.find(entry => !requestEntry(entry))?.label || group.entries[0].label
    return <details key={group.id} open={group.entries.some(entry => entry.id === focus) || undefined}>
      <summary><strong>{label}</strong><span>{time(group.entries[0].at)}</span></summary>
      <div className="record-body">
        <dl className="inspector-facts">
          <div><dt>Browser</dt><dd>{text(event.outcome) || browser?.label || 'No observation recorded'}</dd></div>
          <div><dt>Request</dt><dd>{sent ? 'Sent' : mode === 'inspect' ? 'Skipped in Inspect' : 'No request recorded'}</dd></div>
          <div><dt>CMS acceptance</dt><dd>{accepted || writeAccepted ? 'Accepted' : receipt && fields(receipt.detail).disabled ? 'Collection disabled' : sent ? 'Unverified' : 'Not applicable'}</dd></div>
          <div><dt>Persistence</dt><dd>{confirmed || independent ? 'Independent readback' : saved ? 'Saved row returned by CMS' : sent ? 'Unverified' : 'Not applicable'}</dd></div>
          <div><dt>Downstream effect</dt><dd>Unverified</dd></div>
        </dl>
        {onVerify && eventID && journey && accepted && observed && <button disabled={locked} onClick={() => onVerify({
          id: eventID, journey, actionId: observed.actionId, captureId: observed.captureId,
        }, observed)}>Verify exact event</button>}
        <RequestRows entries={group.entries} focus={focus} />
      </div>
    </details>
  })}</div>
}

function PagedRows({ context, path, params, paging, render }: {
  context: ReadContext; path: string; params?: Record<string, string>; paging: 'before' | 'cursor' | 'page'
  render: (row: Fields) => ReactNode
}) {
  const query = useInfiniteQuery({
    queryKey: ['inspector', ...scopeKey(context.scope), context.item?.id, context.item?.capture?.id, path, params, paging],
    initialPageParam: paging === 'page' ? '1' : '',
    retry: false, staleTime: 60_000, refetchOnWindowFocus: false,
    queryFn: ({ signal, pageParam }) => readOwner(context, path, signal, { ...params, ...(pageParam ? { [paging]: pageParam } : {}) }),
    getNextPageParam: (value, _pages, pageParam, cursors) => {
      const root = fields(value)
      const data = fields(root.data)
      const next = paging === 'page' ? Number(root.total_pages) > Number(pageParam) ? String(Number(pageParam) + 1) : undefined :
        text(data.next_cursor ?? data.next)
      return next && !cursors.includes(next) ? next : undefined
    },
  })
  const all = query.data?.pages.flatMap(value => {
    const root = fields(value)
    const data = fields(root.data)
    return rows(data.items ?? root.items ?? root.data)
  }) ?? []
  const groups = new Map<string, Fields[]>()
  for (const row of all) {
    const group = paging === 'before' ? 'Processing generation ' + (valueText(row.processing_generation) ?? 'unavailable') : ''
    const entries = groups.get(group) ?? []
    entries.push(row)
    groups.set(group, entries)
  }
  return <>
    <ReadStatus query={query} empty={!all.length ? 'No records available.' : undefined} />
    {[...groups].map(([group, entries]) => <div key={group}>
      {group && <h4 className="hint">{group}</h4>}
      <ul className="inspector-related">{entries.map((row, index) => <li key={text(row.id) ?? index}>{render(row)}</li>)}</ul>
    </div>)}
    {query.hasNextPage && <button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more</button>}
    {query.error && <button onClick={() => void query.refetch()}>Retry</button>}
  </>
}

function Fold({ label, children, initiallyOpen = false }: { label: string; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return <details className="inspector-fold" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>{open && <div className="record-body">{children}</div>}
  </details>
}

function Ranking({ context, path }: { context: ReadContext; path: string }) {
  const query = useRead(context, path, true, { section: 'ranking' })
  const ranking = fields(fields(query.data).data)
  return <>
    <ReadStatus query={query} />
    {query.data != null && <p>Anonymous assembly · {time(text(ranking.as_of))} · Raw rank {valueText(ranking.raw_rank) ?? 'unavailable'} · Final rank {valueText(ranking.final_rank) ?? 'unavailable'}</p>}
  </>
}

function Journey({ context, summary, path, isNews, lineage, refresh, fetching }: {
  context: ReadContext; summary: Fields; path: string; isNews: boolean; lineage: ReactNode; refresh: () => void; fetching: boolean
}) {
  const keys = { source: 'Source', processing: 'Processing', eligibility: 'Feed eligibility', publication: 'Publication', delivery: 'Observed delivery' }
  const links = rows(summary.links).flatMap(link => {
    const href = text(link.href)
    return href?.startsWith('/platform/') && !/[\\\r\n]/.test(href) ? [{ href, label: text(link.label) || 'Open evidence in Console' }] : []
  })
  for (const [href, label] of [['/platform/feed-integrity', 'Feed Integrity section'], ['/platform/real-experience', 'Real Experience section']]) {
    if (!links.some(link => link.href === href || link.href.startsWith(href + '/') || link.href.startsWith(href + '?'))) links.push({ href, label })
  }
  return <>
    <div className="inspector-section-head"><h3>Current CMS journey</h3><button onClick={refresh} disabled={fetching}>Refresh CMS</button></div>
    {summary.as_of != null && <p className="hint">Checked {time(text(summary.as_of))}</p>}
    <ol className="journey-list">{Object.entries(keys).map(([key, label]) => {
      const stage = fields(summary[key])
      return <li key={key} id={'journey-' + key}>
        <div className="inspector-section-head"><strong>{label}</strong><span className="inspector-chip">{text(stage.status) ?? 'Unavailable'}</span></div>
        {typeof stage.detail === 'string' && <p dir="auto">{stage.detail.replaceAll('_', ' ')}</p>}
        <small className="hint">{[text(stage.owner), stage.observed_at && time(text(stage.observed_at))].filter(Boolean).join(' · ')}</small>
        {key === 'processing' && <>
          {(['attempts', 'receipts'] as const).map(section => <Fold label={section === 'attempts' ? 'Attempts by generation' : 'Receipts by generation'} key={section}>
            <PagedRows context={context} path={path + '/trace-evidence'} paging="before" params={{ section }}
              render={row => <div>{text(row.stage)} · {text(row.state)} · {text(row.owner)}<small>{time(text(row.at))}</small></div>} />
          </Fold>)}
        </>}
        {key === 'delivery' && rows(summary.observations).map((row, index) => <p key={index}>
          {row.historical ? 'Historical' : 'Current generation'} · {text(row.boundary)?.replaceAll('_', ' ')} · {text(row.scope)} · {time(text(row.observed_at))}
        </p>)}
      </li>
    })}</ol>
    {!isNews && <Fold label="Inspect current Pods ranking"><Ranking context={context} path={path + '/trace-evidence'} /></Fold>}
    {lineage}
    {context.scope.health.console_url && <div className="inline">{links.map(({ href, label }) =>
      <a key={href} href={context.scope.health.console_url + href} target="_blank" rel="noreferrer">{label} <ArrowUpRight size={12} /></a>
    )}</div>}
  </>
}

function SourceRun({ context, id }: { context: ReadContext; id: string }) {
  const query = useRead(context, '/admin/media/circulation/source-runs/' + id + '/trace', true)
  const result = fields(query.data)
  const run = fields(result.request)
  return <>
    <ReadStatus query={query} />
    {query.data != null && <dl className="inspector-facts">
      <div><dt>Source</dt><dd>{text(run.source_name) ?? 'Unavailable'}</dd></div>
      <div><dt>Run state</dt><dd>{text(run.state) ?? 'Unavailable'}</dd></div>
      <div><dt>Evidence</dt><dd>{text(run.evidence_state) ?? 'Unavailable'}</dd></div>
      <div><dt>Finished</dt><dd>{time(text(run.finished_at))}</dd></div>
    </dl>}
  </>
}

function Lineage({ context, path, onOpen, setLineage }: {
  context: ReadContext; path: string; onOpen: (id: string) => void; setLineage: (value: Fields) => void
}) {
  const query = useRead(context, path + '/trace', true)
  const trace = fields(query.data)
  const item = fields(trace.item)
  const lineage = fields(trace.source_lineage)
  const run = fields(lineage.source_run)
  const runId = text(run.id)
  const parent = text(item.parent_content_item_id)
  const sourceName = text(fields(lineage.source).name)
  useEffect(() => {
    if (query.data && !query.error) setLineage(item)
    // Persist only the source response for this selection.
  }, [query.data, query.error])
  return <>
    <ReadStatus query={query} />
    {sourceName && <p>{sourceName}</p>}
    {parent && validID(parent) && <button onClick={() => onOpen(parent)}>Inspect parent episode</button>}
    {runId && validID(runId) && <Fold label="Source run details"><SourceRun context={context} id={runId} /></Fold>}
    {query.data != null && <p className="hint">{text(fields(trace.diagnostic).reason) ?? 'Source relationships are recorded in Evidence.'}</p>}
  </>
}

function Transcript({ context, item, media, canSeek, onPreview }: {
  context: ReadContext; item: Item; media: RefObject<HTMLMediaElement | null>; canSeek: boolean; onPreview: () => void
}) {
  const query = useQuery({ ...transcriptQuery(context, item.transcript_id ?? '', item), enabled: validID(item.transcript_id ?? '') })
  return <>
    <ReadStatus query={query} empty={!query.data ? 'No transcript ID is available.' : undefined} />
    {query.data?.mode === 'unavailable' && <p className="hint">No readable transcript was returned.</p>}
    {query.data?.cues.length ? <ol className="inspector-transcript">{query.data.cues.map(cue => <li key={cue.id}>
      {cue.startSeconds !== undefined && <button disabled={!canSeek} title={canSeek ? undefined : 'Select this item in the phone preview'} onClick={() => {
        const player = media.current
        if (!player || cue.startSeconds === undefined || !Number.isFinite(player.duration)) return
        player.currentTime = Math.min(player.duration, Math.max(0, cue.startSeconds))
        onPreview()
      }}>{formatTranscriptTime(cue.startSeconds)}</button>}
      <span dir="auto">{cue.text}</span>
    </li>)}</ol> : query.data?.text && <p className="inspector-prose" dir="auto">{query.data.text}</p>}
  </>
}

function Content({ context, item, admin, lineage, selectedStory, summaryType, reader, playback, media, follows, onOpen, onPreview }: {
  context: ReadContext; item: Item; admin: Fields; lineage: Fields; selectedStory: boolean; summaryType?: string
  reader: Reader | null; playback: Fields; media: RefObject<HTMLMediaElement | null>; follows: boolean
  onOpen: (id: string, item?: Item, story?: boolean) => void; onPreview: () => void
}) {
  const isNews = selectedStory || Boolean(item.story_id) || (item.type ?? text(admin.type)) === 'NEWS'
  const body = follows && reader?.item.id === item.id ? reader.text : text(admin.body_text) || item.body_text || item.excerpt
  const source = safeURL(item.original_url || text(admin.original_url) || text(lineage.original_url))
  const parent = item.parent_id ?? text(lineage.parent_content_item_id)
  const storyId = item.story_id ?? text(lineage.story_id)
  const mediaParent = parent || (summaryType === 'PODS_PARENT' ? item.id : undefined)
  const chapterStart = item.chapter_start_ms ?? lineage.chapter_start_ms
  const chapterEnd = item.chapter_end_ms ?? lineage.chapter_end_ms
  const chapterIndex = item.chapter_index ?? lineage.chapter_index
  const art = item.thumbnail_url || text(admin.thumbnail_url)
  const fallback = item.fallback_playback_type || text(lineage.fallback_playback_type)
  const relative = (row: Item, role: string, story = false) => <li key={row.id}>
    <button className="inspector-link" onClick={() => onOpen(row.id, row, story)} dir="auto">{row.title || row.id}</button>
    <small dir="auto">{[role, row.source_name, row.published_at && time(row.published_at)].filter(Boolean).join(' · ')}</small>
  </li>
  return <>
    <div className="inspector-section-head"><h3>{isNews ? 'Story and article' : 'Media and metadata'}</h3></div>
    {art && <PreviewImage className="inspector-art" url={art} fallback={<span>Artwork unavailable</span>} />}
    <dl className="inspector-facts">
      <div><dt>Publisher</dt><dd dir="auto">{item.source_name || text(admin.source_name) || 'Unavailable'}</dd></div>
      <div><dt>Published</dt><dd>{time(item.published_at || text(admin.published_at))}</dd></div>
      <div><dt>Language</dt><dd>{item.content_language || text(lineage.content_language) || 'Unavailable'}</dd></div>
      {source && <div><dt>Original source</dt><dd><a href={source} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={12} /></a></dd></div>}
      {!isNews && <>
        <div><dt>Declared format</dt><dd>{item.playback_type || text(lineage.playback_type) || 'Unavailable'}</dd></div>
        <div><dt>Browser source</dt><dd dir="auto">{asset(playback.url) || 'Unobserved'} {playback.fallback === true && ' · Fallback'}</dd></div>
        <div><dt>Fallback</dt><dd dir="auto">{[fallback, asset(item.fallback_playback_url || lineage.fallback_playback_url)].filter(Boolean).join(' · ') || 'Unavailable'}</dd></div>
        <div><dt>Declared duration</dt><dd>{duration(item.duration_sec ?? admin.duration_sec) ?? 'Unavailable'}</dd></div>
        <div><dt>Observed duration</dt><dd>{duration(playback.duration) ?? 'Unobserved'}</dd></div>
      </>}
      {parent && validID(parent) && <div><dt>Parent episode</dt><dd><button className="inspector-link" onClick={() => onOpen(parent)}>{parent}</button></dd></div>}
      {typeof chapterIndex === 'number' && <div><dt>Chapter</dt><dd>{chapterIndex + 1}
        {typeof chapterStart === 'number' && typeof chapterEnd === 'number' && ' · ' + duration(chapterStart / 1000) + '–' + duration(chapterEnd / 1000)}</dd></div>}
      {isNews && <div><dt>Story ID</dt><dd><code>{storyId ?? 'Unavailable'}</code></dd></div>}
      {(follows && reader?.translation || text(lineage.translation_language)) && <div>
        <dt>Translation</dt><dd>{follows && reader?.translation || text(lineage.translation_language)}</dd>
      </div>}
      {Array.isArray(admin.topic_tags) && !!admin.topic_tags.length && <div><dt>Topics</dt><dd dir="auto">{admin.topic_tags.filter(value => typeof value === 'string').join(' · ')}</dd></div>}
    </dl>
    {item.summary && <section className="inspector-block"><h3>Summary</h3><p className="inspector-prose" dir="auto">{item.summary}</p></section>}
    {body && <section className="inspector-block"><h3>{isNews ? follows && reader ? 'Reader text' : 'Article text' : 'Description'}</h3><p className="inspector-prose" dir="auto">{body}</p></section>}
    {!isNews && <Fold label="Transcript"><Transcript context={context} item={{ ...item, transcript_id: item.transcript_id ?? text(lineage.transcript_id) }}
      media={media} canSeek={follows && !!media.current} onPreview={onPreview} /></Fold>}
    {mediaParent && validID(mediaParent) && <Fold label={parent ? 'Sibling chapters' : 'Chapter list'}>
      <PagedRows context={context} path={'/admin/media-atomization/parents/' + mediaParent + '/journey/chapters'} paging="cursor"
        render={row => <div>
          {typeof row.child_id === 'string' && validID(row.child_id)
            ? <button className="inspector-link" onClick={() => onOpen(row.child_id as string)} dir="auto">{text(row.title) || row.child_id}</button>
            : <strong dir="auto">{text(row.title) || 'Planned chapter'}</strong>}
          <small>{duration(Number(row.start_ms) / 1000)}–{duration(Number(row.end_ms) / 1000)} · {text(row.state)}</small>
        </div>} />
    </Fold>}
    {isNews && selectedStory && <div className="inspector-block">
      <h3>Captured story</h3>
      <p>{item.source_count ? item.source_count + ' sources · ' : ''}{item.member_count ?? item.members?.length ?? 'Unavailable'} articles</p>
      <ul className="inspector-related">{relative(item, 'Lead article')}</ul>
      {!!item.members?.length && <><h3>Captured coverage</h3><ul className="inspector-related">
        {item.members.filter(member => member.id !== item.id).map(member => relative(member, 'Coverage'))}</ul></>}
      {!!item.related?.length && <><h3>Related stories</h3><ul className="inspector-related">
        {item.related.map(related => relative(related, 'Related story', true))}</ul></>}
    </div>}
    {storyId && validID(storyId) && <Fold label="Current CMS story membership">
      <PagedRows context={context} path="/admin/content" paging="page" params={{ story_id: storyId }} render={row =>
        typeof row.id === 'string' && validID(row.id)
          ? <><button className="inspector-link" dir="auto" onClick={() => onOpen(row.id as string)}>{text(row.title) || row.id}</button>
            <small dir="auto">{[text(row.source_name), text(row.status), time(text(row.published_at))].filter(Boolean).join(' · ')}</small></>
          : <span>Item ID unavailable</span>} />
    </Fold>}
  </>
}

function LogReader({ context, requestId }: { context: ReadContext; requestId?: string }) {
  const [service, setService] = useState('cms')
  const [search, setSearch] = useState(requestId || context.item?.id || '')
  const [submitted, setSubmitted] = useState<{ service: string; search: string; id: number }>()
  const query = useQuery({
    queryKey: ['inspector', ...scopeKey(context.scope), context.item?.id, context.item?.capture?.id, 'logs', submitted],
    enabled: !!submitted, retry: false, staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ service: submitted!.service, search: submitted!.search })
      const log = await lab<Fields>(context.scope.health, '/api/logs?' + params, { signal })
      if (!signal.aborted) context.record({ at: new Date().toISOString(), label: 'Service log excerpt', detail: log,
        itemId: context.item?.id, captureId: context.item?.capture?.id, requestId })
      return log
    },
  })
  const lines = text(query.data?.text) || ''
  const identifier = submitted?.search
  const exact = identifier && [requestId, context.item?.id].includes(identifier) &&
    new RegExp('(?:^|[^\\w.-])' + identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^\\w.-])', 'm').test(lines)
  return <>
    <form className="inline" onSubmit={event => {
      event.preventDefault(); setSubmitted({ service, search, id: Date.now() })
    }}>
      <label>Service <select value={service} onChange={event => setService(event.target.value)}>
        {context.scope.health.services.map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Search <input maxLength={150} value={search} onChange={event => setSearch(event.target.value)} placeholder="Item or request ID" /></label>
      <button>Load excerpt</button>
    </form>
    <ReadStatus query={query} />
    {query.data && <><p className="hint">{text(query.data.service)} · {time(text(query.data.at))} · {exact ? 'Exact identifier match' : lines ? 'Contextual excerpt' : 'No matching lines'}
      {' · Last 1,000 lines within 1 MiB'}{query.data.truncated === true && ' · Earlier lines excluded'}</p>
      {lines && <pre>{lines}</pre>}</>}
  </>
}

export function ItemInspector({ scope, ready, locked, item, page, surface, reader, evidence, trimmed, onEvidence,
  progress, media, onSave, onPreview, onVerify, onView, onPlay, onConsumption, onPreferences, checks, openChecks }: {
  scope: Scope; ready: boolean; locked: boolean; item?: Item; page: Page | null; surface: Surface; reader: Reader | null
  evidence: Evidence[]; trimmed: boolean; onEvidence: RecordEntry; progress: Progress; media: RefObject<HTMLMediaElement | null>
  onSave: (inspection?: InspectionSnapshot, note?: string) => Promise<boolean>; onPreview: () => void
  onVerify: (target: EventTarget, item?: Item) => void
  onView?: () => void; onPlay?: () => void; onConsumption?: () => void; onPreferences?: () => void; checks: (following: boolean) => ReactNode
  openChecks?: boolean
}) {
  const [tab, setTab] = useState<Tab>('Overview')
  const [selected, setSelected] = useState<Selection>()
  const [lookup, setLookup] = useState('')
  const [openLookup, setOpenLookup] = useState(false)
  const [allSession, setAllSession] = useState(false)
  const [focus, setFocus] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const [showChecks, setShowChecks] = useState(Boolean(openChecks))
  const follow = !selected
  const active = selected ? selected.item ?? capturedItem(page, selected.id) ?? { id: selected.id } : item
  const selectionKey = active ? active.id + '/' + (active.capture?.id ?? 'lookup') : ''
  const [settled, setSettled] = useState('')
  const [lineageState, setLineage] = useState<{ key: string; value: Fields }>()
  const lineage = lineageState?.key === selectionKey ? lineageState.value : {}
  const lookupInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(selectionKey), 240)
    return () => clearTimeout(timer)
  }, [selectionKey])
  useEffect(() => { if (openLookup) lookupInput.current?.focus() }, [openLookup])
  useEffect(() => { if (openChecks) setShowChecks(true) }, [openChecks])
  const id = active?.id ?? ''
  const omittedItem = selected && !active?.capture
    ? page?.omissions.find(entry => entry.itemId === selected.id || entry.storyId === selected.id) : undefined
  const omissionCapture = omittedItem && page?.captures.find(capture => capture.id === omittedItem.captureId)
  const context = { scope, item: active && (omissionCapture ? { ...active, capture: omissionCapture } : active), record: onEvidence }
  const path = '/admin/content-stages/items/' + id
  const enabled = ready && !!active && settled === selectionKey
  const summaryRead = useRead(context, path + '/trace-summary', enabled)
  const summaryData = fields(fields(summaryRead.data).data)
  const summary = summaryData.id === id && summaryData.version === 'delivery-summary/v1' ? summaryData : {}
  const cmsRead = useRead(context, '/admin/content/' + id, enabled && (!follow || tab === 'Content' || tab === 'Evidence'))
  const cmsData = fields(cmsRead.data)
  const cms = cmsData.id === id ? cmsData : {}
  const activeType = active?.type || text(cms.type) || text(summary.item_type)
  const isNews = surface === 'news' && follow || activeType === 'NEWS' || Boolean(active?.story_id || lineage.story_id)
  const deliveryRead = useRead(context, '/admin/media/delivery/content/' + id + '/diagnostics', enabled && !isNews &&
    ['Content', 'Evidence'].includes(tab) && Boolean(activeType || active?.playback_url))
  const delivery = fields(fields(deliveryRead.data).content_item)
  const storyView = selected?.story ?? Boolean(active?.story_id && active.responseRow && /\.(featured|related\[\d+\])$/.test(active.responseRow) && !reader)
  const itemType = storyView ? 'News story' : active?.parent_id ? 'Pods chapter' : isNews ? 'News article' : text(summary.item_type) || activeType || 'Content item'
  const storyId = active?.story_id || text(lineage.story_id)
  const containingStory = !storyView && storyId ? page?.items.flatMap(row => [row, ...(row.related ?? [])])
    .find(row => row.story_id === storyId) : undefined
  const scoped = evidence.filter(entry => belongs(entry, id, storyId, context.item?.capture, storyView))
  const visible = allSession || !active ? evidence : scoped
  const feedRequest = context.item?.capture && scoped.find(entry => requestEntry(entry) && /^\w+ \/(feed\/|interactions\/bookmarks)/.test(entry.label) && !entry.itemId)
  const locator = active?.responseRow ?? omittedItem?.row
  const capturedRow = responseRow(fields(feedRequest?.detail).response, locator)
  const sourceEntry = scoped.find(entry => entry.label === 'Playback source selected')
  const durationEntry = scoped.find(entry => entry.label === 'Playback metadata observed')
  const playback = { ...fields(sourceEntry?.detail), ...fields(durationEntry?.detail) }
  const played = scoped.find(entry => entry.label === 'Playback clock advanced')
  const rendered = scoped.find(entry => entry.itemId === id && /^(Preview|Reader) rendered$/.test(entry.label))
  const omitted = scoped.find(entry => entry.label === 'Preview adaptation' && Array.isArray(fields(entry.detail).omitted) && (fields(entry.detail).omitted as unknown[]).length)
  const fallback = scoped.find(entry => entry.label === 'Playback fallback')
  const error = scoped.find(entry => entry.label === 'Playback error')
  const digest = text(delivery.rendition_digest)
  const oldDigest = active?.capturedFields?.['Rendition digest'] ?? text(capturedRow.rendition_digest)
  const findings: { title: string; tab: Tab; entry?: string }[] = []
  if (error) findings.push({ title: 'Playback failed in the preview.', tab: 'Activity', entry: error.id })
  else if (fallback) findings.push({ title: playback.fallback && played ? 'The primary source failed. Playback advanced on the fallback.' : 'The primary source failed. The browser selected the fallback.', tab: 'Activity', entry: fallback.id })
  if (oldDigest && digest && oldDigest !== digest) findings.push({ title: 'CMS has a different rendition from the captured feed.', tab: 'Evidence', entry: 'fields' })
  if (omitted) findings.push({ title: 'The preview omitted entries from this response.', tab: 'Evidence', entry: omitted.id })
  const eligibility = fields(summary.eligibility)
  if (/Excluded|Requirements not met/.test(String(eligibility.status))) findings.push({ title: text(eligibility.detail) ?? String(eligibility.status), tab: 'Journey' })
  const title = follow && reader?.title || active?.title || text(cms.title) || text(summary.title) || (active ? 'Content ' + id.slice(0, 8) : 'No item selected')
  const snapshot: InspectionSnapshot | undefined = active && {
    itemId: id, storyId, storyView, title: title.slice(0, 300), capture: context.item?.capture, responseRow: locator,
    captured: active.capturedFields ?? comparisonFields(capturedRow),
    preview: active.capture || rendered ? {
      ...comparisonFields({ ...active, title }),
      ...(playback.audio === true ? { Artwork: 'Generated listening scene' } : {}),
      ...(typeof playback.duration === 'number' ? { 'Observed duration': duration(playback.duration) ?? 'Unavailable' } : {}),
      ...(text(playback.type) ? { 'Playback format': String(playback.type) } : {}),
      ...(asset(playback.url) ? { 'Selected source': asset(playback.url)! } : {}),
    } : {},
    current: comparisonFields({ ...lineage, ...cms, ...delivery }), checkedAt: text(summary.as_of),
    findings: findings.slice(0, 3).map(finding => finding.title),
  }
  const jump: Jump = (view, entry) => {
    setTab(view); setFocus(entry)
    if (entry) {
      setAllSession(false)
      requestAnimationFrame(() => {
        const target = document.getElementById('evidence-' + entry)
        target?.scrollIntoView({ block: 'center' })
        target?.querySelector('summary')?.focus({ preventScroll: true })
      })
    }
  }
  function open(id: string, item?: Item, story = false) {
    if (!validID(id)) return
    const found = item ?? capturedItem(page, id.toLowerCase())
    setSelected({ id: (found?.id ?? id).toLowerCase(), item: found, story: story || found?.story_id === id }); setLookup(''); setOpenLookup(false)
    setAllSession(false); setShowChecks(false); setSaving(false); jump('Overview')
  }
  function verify(target: EventTarget, entry: Evidence) {
    const verifiedItem = entry.itemId ? {
      id: entry.itemId, story_id: entry.storyId,
      capture: entry.captureId === active?.capture?.id ? active?.capture :
        page?.items.find(item => item.capture?.id === entry.captureId)?.capture,
    } : undefined
    onVerify(target, verifiedItem)
  }
  const displayedItem = active && { ...active, title: active.title || text(cms.title), source_name: active.source_name || text(cms.source_name) }
  const playbackTime = duration(progress.played) ?? '0:00'
  const threshold = consumptionThreshold(item?.duration_sec ?? 0)
  const remaining = threshold ? Math.max(0, threshold - Math.floor(progress.played)) : undefined
  const requestId = scoped.find(entry => entry.requestId)?.requestId
  return <section className="evidence-column item-inspector" aria-label="Evidence">
    <header className="inspector-header">
      <div className="inspector-section-head">
        <span className="eyebrow">{follow ? 'Selected item' : 'Item lookup'}</span>
        <button aria-expanded={openLookup} onClick={() => setOpenLookup(value => !value)} disabled={!ready}><Search size={14} /> Open by ID</button>
      </div>
      {openLookup && <form className="inspector-lookup" onSubmit={event => { event.preventDefault(); open(lookup.trim()) }}>
        <label>Content ID <input ref={lookupInput} value={lookup} onChange={event => setLookup(event.target.value)} placeholder="Paste a content UUID" /></label>
        <button disabled={!validID(lookup.trim())}>Open item</button>
      </form>}
      <div className="inspector-identity">
        <div className="inspector-kind">{active ? itemType.replaceAll('_', ' ').toLowerCase() : 'Item inspector'}</div>
        <h2 dir="auto">{title}</h2>
        {active && <div className="inspector-identity-meta">
          <span dir="auto">{active.source_name || text(cms.source_name) || text(fields(summary.source).owner) || 'Source unavailable'}</span>
          {duration(active.duration_sec ?? cms.duration_sec) && <span>{duration(active.duration_sec ?? cms.duration_sec)}</span>}
          <CopyID key={id} id={id} />
        </div>}
        {active?.parent_id && <button className="inspector-link" onClick={() => open(active.parent_id!)}>Inspect parent episode</button>}
        {containingStory && <button className="inspector-link" onClick={() => open(containingStory.id, containingStory, true)}>Inspect containing story</button>}
        {reader && follow && reader.item.id !== page?.items.find(value => value.id === reader.item.id)?.id &&
          <span className="hint">Reading an article from the current News slide</span>}
        {!follow && <div className="inspector-context">
          <span dir="auto">{item ? 'Phone preview · ' + (reader?.title || item.title || item.id) : 'The phone preview is empty'}</span>
          <button onClick={() => { setSelected(undefined); setAllSession(false); jump('Overview') }}>Return to preview item</button>
        </div>}
      </div>
      <nav className="inspector-tabs" aria-label="Item inspector">{tabs.map(view =>
        <button key={view} aria-pressed={tab === view && !showChecks} onClick={() => { setShowChecks(false); jump(view) }}>{view}</button>)}</nav>
    </header>
    <div className="inspector-panel">
      <div className="inspector-toolbar">
        <button aria-expanded={showChecks} onClick={() => setShowChecks(value => !value)}>Run checks</button>
        <button disabled={locked || !evidence.length} aria-expanded={saving} onClick={() => setSaving(value => !value)}>Save investigation</button>
      </div>
      {saving && <form className="inspector-save" onSubmit={async event => {
        event.preventDefault()
        if (await onSave(snapshot, note.trim() || undefined)) { setSaving(false); setNote('') }
      }}>
        <label>Investigation note <textarea maxLength={2000} rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Optional context for this capture" /></label>
        <button className="primary" disabled={locked}>Save capture</button>
      </form>}
      {trimmed && <p className="inspector-message">Earlier evidence reached the capture limit. Some records are unavailable.</p>}
      {showChecks ? <div className="inspector-checks">{checks(follow)}</div> : <>
        {tab === 'Overview' && <>
          <div className="inspector-block">
            <h3>What needs attention</h3>
            {findings.length ? <ul className="findings">{findings.slice(0, 3).map(finding => <li key={finding.title}>
              <span dir="auto">{finding.title}</span><button className="inspector-link" onClick={() => jump(finding.tab, finding.entry)}>View {finding.tab.toLowerCase()}</button>
            </li>)}</ul> : <p className="hint">{active ? 'No findings recorded. Review the observed and unobserved checks below.' : 'Open a feed or look up a content ID.'}</p>}
          </div>
          {active && <div className="inspector-block">
            <h3>Consumer experience</h3>
            <dl className="inspector-facts">
              <div><dt>Feed response</dt><dd>{active.capture ? (storyView ? 'Story returned' : active.responseRow?.includes('.members[') ? 'Returned in story coverage' : 'Item returned') :
                omittedItem ? <>Omitted from the preview · <code>{omittedItem.row}</code> {omittedItem.reason}</> :
                page ? 'Outside the loaded pages' : 'No feed pages loaded'}</dd></div>
              <div><dt>Preview render</dt><dd>{rendered ? 'Observed in this capture' : 'Unobserved'}</dd></div>
              <div><dt>{isNews ? 'Article reader' : 'Playback'}</dt><dd>{isNews ? scoped.some(entry => entry.itemId === id && entry.label === 'Reader rendered') ? 'Article opened' : 'Unobserved'
                : played ? 'Media clock advanced' : error ? 'Playback error observed' : 'Unobserved'}</dd></div>
              <div><dt>Current CMS eligibility</dt><dd>{text(eligibility.status) ?? 'Unavailable'}</dd></div>
            </dl>
            <ReadStatus query={summaryRead} />
            {summary.as_of != null && <p className="hint">Current CMS checked {time(text(summary.as_of))}</p>}
            {!follow && <ReadStatus query={cmsRead} />}
            <CaptureScope capture={context.item?.capture} />
          </div>}
        </>}
        {tab === 'Content' && displayedItem && <>
          <ReadStatus query={cmsRead} />
          <ReadStatus query={deliveryRead} />
          <Content context={context} item={displayedItem} admin={cms} lineage={lineage} selectedStory={storyView}
            summaryType={text(summary.item_type)} reader={reader} playback={playback} media={media}
            follows={follow} onOpen={open} onPreview={onPreview} />
          {!Object.keys(lineage).length && <Fold label="Load item lineage"><Lineage context={context} path={path} onOpen={open}
            setLineage={value => setLineage({ key: selectionKey, value })} /></Fold>}
        </>}
        {tab === 'Journey' && active && <>
          <ReadStatus query={summaryRead} />
          <Journey context={context} summary={summary} path={path} isNews={isNews}
            fetching={summaryRead.isFetching} refresh={() => void summaryRead.refetch()}
            lineage={<Fold label="Load source and item lineage"><Lineage context={context} path={path} onOpen={open}
              setLineage={value => setLineage({ key: selectionKey, value })} /></Fold>} />
        </>}
        {(tab === 'Content' || tab === 'Journey') && !active && <p className="hint">Select an item to inspect its {tab.toLowerCase()}.</p>}
        {tab === 'Activity' && <>
          <div className="inspector-section-head"><h3>Activity</h3><label><input type="checkbox" checked={allSession} onChange={event => setAllSession(event.target.checked)} /> Entire session</label></div>
          <p className="hint">{scope.mode === 'inspect' ? 'Inspect keeps consumer activity local.' : 'Test as user can write consumer activity.'}</p>
          <div className="inline">
            {follow && onView && <button disabled={locked} onClick={onView}>{scope.mode === 'test' ? 'Send view' : 'Observe view'}</button>}
            {follow && onPlay && <button disabled={locked} onClick={onPlay}>Measure playback</button>}
            {follow && onConsumption && <button disabled={locked || !consumption(progress.played, progress.furthest, item?.duration_sec ?? 0)}
              onClick={onConsumption}>Check consumption</button>}
            {onPreferences && <button disabled={locked} onClick={onPreferences}>Read preferences</button>}
          </div>
          {follow && onPlay && <p className="hint">{playbackTime} measured{remaining !== undefined && (remaining ? ' · ' + remaining + 's to qualify' : ' · Qualifying playback reached')}</p>}
          <Activity entries={visible} mode={scope.mode} onVerify={verify} locked={locked} focus={focus} />
        </>}
        {tab === 'Evidence' && <>
          <div className="inspector-section-head"><h3>Requests and responses</h3>
            <label><input type="checkbox" checked={allSession} onChange={event => setAllSession(event.target.checked)} /> Entire session</label>
          </div>
          <RequestRows entries={visible.filter(entry => requestEntry(entry) || entry.label === 'Preview adaptation')} focus={focus} />
          <Fold label="Compare item fields" key={focus === 'fields' ? 'focused' : 'manual'} initiallyOpen={focus === 'fields'}>
            <CaptureScope capture={context.item?.capture} />
            {locator && <p className="hint">Response row <code>{locator}</code></p>}
            <ReadStatus query={cmsRead} />
            <ReadStatus query={deliveryRead} />
            <div className="inline">
              <button disabled={!enabled || cmsRead.isFetching || deliveryRead.isFetching} onClick={() => {
                void cmsRead.refetch()
                if (!isNews && activeType) void deliveryRead.refetch()
              }}>Refresh CMS fields</button>
              {cmsRead.dataUpdatedAt > 0 && <small className="hint">CMS read {time(new Date(cmsRead.dataUpdatedAt).toISOString())}</small>}
            </div>
            <FieldComparison columns={[
              { label: 'Captured feed', values: snapshot?.captured ?? {} },
              { label: 'Preview interpretation', values: snapshot?.preview ?? {} },
              { label: 'Current CMS', values: snapshot?.current ?? {} },
            ]} />
          </Fold>
          <Fold label="Logs"><LogReader key={selectionKey} context={context} requestId={requestId} /></Fold>
        </>}
      </>}
    </div>
  </section>
}
