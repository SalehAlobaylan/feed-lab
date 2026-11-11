import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { health, lab } from '../lib/client'
import type { SavedRun } from '../lib/evidence'
import { canCompare, time } from '../lib/inspection'
import { Activity, CaptureScope, FieldComparison } from './item-inspector'
import { EvidenceList } from './workspace'
import { FeedComparisonView } from './feed-comparison'

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
  const navigate = useNavigate()
  const current = query.isFetching || query.error ? undefined : query.data
  const run = current && !Array.isArray(current) ? current : undefined
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
  return <main className="workspace history">
    <p className="eyebrow">Feed Lab · History</p><h1>{run?.title ?? 'Saved runs'}</h1>
    {issue && <p role="alert" className="problem">{issue}</p>}
    {!query.data && !issue && <p role="status">Loading saved evidence…</p>}
    {Array.isArray(current) && (current.length ? <div className="run-list">
      {current.map(row => <Link key={row.id} to="/runs/$runId" params={{ runId: row.id }}>
        <strong>{row.title}</strong><span>{row.verdict} · {row.environment} · {new Date(row.created).toLocaleString()}</span>
      </Link>)}
    </div> : <p>No saved runs yet. Save an investigation from the <Link to="/">workspace</Link>.</p>)}
    {run && <>
      <p>{run.verdict === 'unverified' && run.checks?.some(check => check.status === 'passed') ? 'Partial coverage' : run.verdict} · {run.environment} · {run.mode} · {new Date(run.created).toLocaleString()}</p>
      <p className="hint">Launch revisions · Feed Lab {run.revisions?.lab ?? 'unavailable'} · CMS {run.revisions?.cms ?? 'unavailable'} · IAM {run.revisions?.iam ?? 'unavailable'}</p>
      <div className="inline"><Link to="/runs">Back to runs</Link>
        {run.scenario && run.settings && run.verdict !== 'running' && <Link to="/" search={{ rerun: run.id }}>Run again with the same settings</Link>}
        <button disabled={busy} onClick={() => void download()}>Export report</button>
        {run.inspection?.capture && <button aria-expanded={compare} onClick={() => {
          setCompare(value => !value); setOtherId('')
        }}>Compare captures</button>}
        <button disabled={busy || run.verdict === 'running'} onClick={() => void remove()}>Delete report</button>
      </div>
      {run.checks && <section className="inspector-block"><h2>Check results</h2>
        <ul className="check-results">{run.checks.map((check, index) => <li key={index}>
          <strong>{check.label}</strong> <span>{check.status}</span>{check.detail && <p className="hint">{check.detail}</p>}
        </li>)}</ul>
      </section>}
      {run.comparison && <FeedComparisonView comparison={run.comparison} evidence={run.evidence} />}
      {run.inspection && <section className="inspector-block">
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
      </section>}
      {run.note && <section className="inspector-block"><h2>Investigation note</h2><p className="inspector-prose" dir="auto">{run.note}</p></section>}
      {compare && <section className="inspector-block" aria-label="Compare saved captures">
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
      </section>}
      {run.trimmed && <p className="inspector-message">Earlier evidence reached the capture limit.</p>}
      {run.evidence.some(entry => !entry.id) && <p className="hint">Older entries have unavailable item attribution.</p>}
      {run.inspection && <section className="inspector-block">
        <h2>Captured activity</h2>
        <Activity entries={[...run.evidence].reverse().filter(entry =>
          entry.itemId === run.inspection?.itemId && entry.captureId === run.inspection?.capture?.id)} mode={run.mode} />
      </section>}
      <details className="inspector-fold" open={!run.inspection || undefined}>
        <summary>Recorded evidence</summary>
        <EvidenceList entries={run.evidence} />
      </details>
    </>}
  </main>
}
