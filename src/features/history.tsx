import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { AlertCircle, ArrowLeft, Download, GitCompareArrows, RotateCcw, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { health, lab } from '../lib/client'
import type { SavedRun } from '../lib/evidence'
import { canCompare, time } from '../lib/inspection'
import { Activity, CaptureScope, FieldComparison } from './item-inspector'
import { EvidenceList } from './workspace'
import { FeedComparisonView } from './feed-comparison'

const verdictFilters = ['all', 'passed', 'failed', 'blocked', 'unverified', 'interrupted', 'saved'] as const

function verdictTone(verdict: string) {
  if (verdict === 'passed') return 'success'
  if (verdict === 'failed' || verdict === 'interrupted') return 'danger'
  if (verdict === 'blocked' || verdict === 'unverified') return 'warning'
  if (verdict === 'running') return 'info'
  return 'neutral'
}

export function History({ id }: { id?: string }) {
  const runtime = useQuery({ queryKey: ['health'], queryFn: health, staleTime: Infinity })
  const query = useQuery({
    queryKey: ['runs', runtime.data?.runtime_id, id], enabled: !!runtime.data, staleTime: 0, refetchOnMount: 'always',
    queryFn: () => lab<SavedRun | SavedRun[]>(runtime.data!, '/api/runs' + (id ? '?id=' + encodeURIComponent(id) : '')),
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [compare, setCompare] = useState(false)
  const [otherId, setOtherId] = useState('')
  const [searchText, setSearchText] = useState('')
  const [verdictFilter, setVerdictFilter] = useState<typeof verdictFilters[number]>('all')
  const [envFilter, setEnvFilter] = useState('all')
  const navigate = useNavigate()
  const current = query.isFetching || query.error ? undefined : query.data
  const run = current && !Array.isArray(current) ? current : undefined
  const runList = Array.isArray(current) ? current : undefined
  const environments = useMemo(() => [...new Set((runList ?? []).map(r => r.environment))].sort(), [runList])
  const filteredRuns = useMemo(() => {
    const q = searchText.trim().toLocaleLowerCase()
    return (runList ?? []).filter(row => {
      if (verdictFilter !== 'all' && row.verdict !== verdictFilter) return false
      if (envFilter !== 'all' && row.environment !== envFilter) return false
      if (!q) return true
      return [row.title, row.id, row.environment, row.mode, row.verdict, row.consumer, row.scenario]
        .some(value => value?.toLocaleLowerCase().includes(q))
    })
  }, [runList, searchText, verdictFilter, envFilter])
  const comparisons = useQuery({
    queryKey: ['runs', runtime.data?.runtime_id, 'comparison'],
    enabled: Boolean(runtime.data && run?.inspection?.capture && compare),
    queryFn: () => lab<SavedRun[]>(runtime.data!, '/api/runs'),
  })
  const other = useQuery({
    queryKey: ['runs', runtime.data?.runtime_id, otherId],
    enabled: Boolean(runtime.data && compare && otherId && otherId !== run?.id),
    queryFn: () => lab<SavedRun>(runtime.data!, '/api/runs?id=' + encodeURIComponent(otherId)),
  })
  const candidates = comparisons.data?.filter(candidate => candidate.id !== run?.id &&
    canCompare(run?.inspection, candidate.inspection)) ?? []
  async function download() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/runs?export=1&id=' + encodeURIComponent(id!), {
        headers: { 'x-feed-lab-runtime': runtime.data!.runtime_id },
      })
      if (!response.ok) throw new Error('Export failed. Verify the operator session.')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url; link.download = 'feed-lab-' + id + '.zip'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  async function remove() {
    if (!window.confirm('Delete this saved report?')) return
    setBusy(true); setError('')
    try {
      await lab(runtime.data!, '/api/runs?id=' + encodeURIComponent(id!), { method: 'DELETE' })
      await navigate({ to: '/runs' })
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const issue = error || runtime.error?.message || query.error?.message
  const runVerdictText = run ? (run.verdict === 'unverified' && run.checks?.some(check => check.status === 'passed') ? 'Partial coverage' : run.verdict) : ''
  return <main className="workspace history">
    <div className="history-hero">
      <div className="inspector-section-head">
        <p className="eyebrow">Feed Lab · History</p>
        {run && <span className="status-badge" data-tone={verdictTone(run.verdict)}>{runVerdictText}</span>}
      </div>
      <h1>{run?.title ?? 'Saved runs'}</h1>
      {run && <>
        <p className="history-meta-line">{runVerdictText} · {run.environment} · {run.mode} · {new Date(run.created).toLocaleString()}</p>
        <p className="history-revisions">Launch revisions · Feed Lab {run.revisions?.lab ?? 'unavailable'} · CMS {run.revisions?.cms ?? 'unavailable'} · IAM {run.revisions?.iam ?? 'unavailable'}</p>
        <div className="history-actions">
          <Link to="/runs"><ArrowLeft size={14} aria-hidden="true" />Back to runs</Link>
          {run.scenario && run.settings && run.verdict !== 'running' && <Link to="/" search={{ rerun: run.id }}><RotateCcw size={14} aria-hidden="true" />Run again with the same settings</Link>}
          <button className="btn-subtle" disabled={busy} onClick={() => void download()}><Download size={14} aria-hidden="true" />Export report</button>
          {run.inspection?.capture && <button aria-expanded={compare} onClick={() => {
            setCompare(value => !value); setOtherId('')
          }}><GitCompareArrows size={14} aria-hidden="true" />Compare captures</button>}
          <button className="btn-danger" disabled={busy || run.verdict === 'running'} onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" />Delete report</button>
        </div>
      </>}
    </div>
    {issue && <p role="alert" className="problem"><AlertCircle size={15} aria-hidden="true" /><span>{issue}</span></p>}
    {!query.data && !issue && <p className="hint" role="status">Loading saved evidence…</p>}
    {runList && (runList.length ? <>
      <div className="runs-toolbar" aria-label="Filter saved runs">
        <div className="runs-search-row">
          <label className="runs-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" aria-label="Search saved runs" value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="Search runs by title, scenario, consumer, or ID…" />
          </label>
          {environments.length > 1 && <label>Environment <select aria-label="Filter by environment" value={envFilter} onChange={e => setEnvFilter(e.target.value)}>
            <option value="all">All environments</option>
            {environments.map(env => <option key={env} value={env}>{env}</option>)}
          </select></label>}
        </div>
        <div className="runs-filter-chips" role="group" aria-label="Verdict filter">
          {verdictFilters.map(verdict => <button key={verdict} type="button" className="filter-chip" aria-pressed={verdictFilter === verdict}
            onClick={() => setVerdictFilter(verdict)}>
            {verdict === 'all' ? `All (${runList.length})` : verdict}
          </button>)}
        </div>
      </div>
      {filteredRuns.length ? <div className="run-list">
        {filteredRuns.map(row => <Link key={row.id} to="/runs/$runId" params={{ runId: row.id }}>
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="status-badge" data-tone={verdictTone(row.verdict)}>{row.verdict}</span>
            <strong>{row.title}</strong>
          </div>
          <span className="run-meta">{row.environment} · {row.mode} · {new Date(row.created).toLocaleString()}</span>
        </Link>)}
      </div> : <div className="history-empty-card"><p>No saved runs match your current filters.</p></div>}
    </> : <div className="history-empty-card"><p>No saved runs yet. Save an investigation from the <Link to="/">workspace</Link>.</p></div>)}
    {run && <>
      {run.checks && <div className="history-card"><section className="inspector-block"><h2>Check results</h2>
        <ul className="check-results">{run.checks.map((check, index) => <li key={index}>
          <div className="check-result-head">
            <strong>{check.label}</strong>
            <span className="check-status" data-status={check.status}>{check.status}</span>
          </div>
          {check.detail && <p className="hint">{check.detail}</p>}
        </li>)}</ul>
      </section></div>}
      {run.comparison && <div className="history-card"><FeedComparisonView comparison={run.comparison} evidence={run.evidence} /></div>}
      {run.inspection && <div className="history-card"><section className="inspector-block">
        <h2>Selected item</h2>
        <strong dir="auto">{run.inspection.title}</strong>
        <p><code>{run.inspection.itemId}</code></p>
        <CaptureScope capture={run.inspection.capture} />
        {run.inspection.responseRow && <p className="hint">Response row <code>{run.inspection.responseRow}</code></p>}
        {!!run.inspection.findings.length && <ul className="findings">{run.inspection.findings.map(finding => <li dir="auto" key={finding}>{finding}</li>)}</ul>}
        <FieldComparison columns={[
          { label: 'Captured feed', values: run.inspection.captured },
          { label: 'Preview interpretation', values: run.inspection.preview },
          { label: 'Current CMS at save', values: run.inspection.current },
        ]} />
      </section></div>}
      {run.note && <div className="history-card"><section className="inspector-block"><h2>Investigation note</h2><p className="inspector-prose" dir="auto">{run.note}</p></section></div>}
      {compare && <div className="history-card"><section className="inspector-block" aria-label="Compare saved captures">
        <h2>Compare saved captures</h2>
        {comparisons.isFetching ? <p className="hint">Loading captures…</p> :
          comparisons.error ? <p role="alert">{comparisons.error.message}</p> :
            candidates.length ? <label>Other capture <select value={otherId} onChange={event => setOtherId(event.target.value)}>
              <option value="">Select a capture</option>
              {candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{time(candidate.created)} · {candidate.environment} · {candidate.title}</option>)}
            </select></label> : <p className="hint">No other saved capture for this item or story.</p>}
        {other.isFetching && <p className="hint">Loading selected capture…</p>}
        {other.error && <p role="alert">{other.error.message}</p>}
        {run.inspection && other.data?.inspection && canCompare(run.inspection, other.data.inspection) && <div>
          <div className="saved-compare-scopes">
            {[run, other.data].map((capture, index) => <div key={capture.id}>
              <strong>{index ? 'Other capture' : 'This capture'} · {capture.environment}</strong>
              <p className="hint">Launch <code>{capture.runtime}</code></p>
              <CaptureScope capture={capture.inspection?.capture} />
            </div>)}
          </div>
          <FieldComparison columns={[
            { label: 'This capture', values: run.inspection.captured },
            { label: 'Other capture', values: other.data.inspection.captured },
          ]} />
        </div>}
      </section></div>}
      {run.trimmed && <p className="inspector-message">Earlier evidence reached the capture limit.</p>}
      {run.evidence.some(entry => !entry.id) && <p className="hint">Older entries have unavailable item attribution.</p>}
      {run.inspection && <div className="history-card"><section className="inspector-block">
        <h2>Captured activity</h2>
        <Activity entries={[...run.evidence].reverse().filter(entry =>
          entry.itemId === run.inspection?.itemId && entry.captureId === run.inspection?.capture?.id)} mode={run.mode} />
      </section></div>}
      <div className="history-card">
        <details className="inspector-fold" open={!run.inspection || undefined}>
          <summary>Recorded evidence</summary>
          <div className="record-body">
            <EvidenceList entries={run.evidence} />
          </div>
        </details>
      </div>
    </>}
  </main>
}
