import { useMemo, useState } from 'react'
import { feedDifferenceLabel, feedDifferences, type Evidence, type FeedComparison, type FeedRow, type FeedSnapshot } from '../lib/evidence'
import { time } from '../lib/inspection'
import { RequestRows } from './item-inspector'

function CaptureSide({ label, snapshot, evidence }: { label: string; snapshot: FeedSnapshot; evidence: Evidence[] }) {
  const [open, setOpen] = useState(false)
  const scope = snapshot.pages[0]
  const last = snapshot.pages.at(-1)
  if (!scope) return null
  const requests = evidence.filter(entry => entry.captureId && snapshot.pages.some(page => page.id === entry.captureId))
  return <section>
    <h3>{label}</h3>
    <dl className="inspector-facts">
      <div><dt>Environment</dt><dd>{snapshot.environment} · <code dir="ltr">{snapshot.runtime}</code></dd></div>
      <div><dt>Consumer</dt><dd dir="auto">{scope.consumer}</dd></div>
      <div><dt>Feed and mode</dt><dd>{scope.surface} · {scope.mode === 'inspect' ? 'Inspect' : 'Test as user'}</dd></div>
      <div><dt>Captured</dt><dd>{time(scope.at)}{last && last.id !== scope.id && <> to {time(last.at)}</>}</dd></div>
      <div><dt>Filters</dt><dd>{Object.entries(scope.query).filter(([key]) => key !== 'limit' && key !== 'cursor')
        .map(([key, value]) => key + ' = ' + value).join(' · ') || 'Default'}</dd></div>
      <div><dt>Frozen session</dt><dd><code dir="ltr">{scope.session ?? 'None'}</code></dd></div>
      <div><dt>Coverage</dt><dd>{snapshot.pages.length} pages · {snapshot.rows.length} rows · {snapshot.omitted} omissions · {snapshot.hasMore ? 'Continuation available' : 'No continuation'}</dd></div>
    </dl>
    {snapshot.rowsTrimmed && <p className="hint">Some loaded rows reached the comparison limit.</p>}
    {snapshot.missingResponses.length > 0 && <p className="hint">{snapshot.missingResponses.length} original responses unavailable.</p>}
    {requests.length > 0 && <details className="inspector-fold" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Captured requests and responses</summary>
      {open && <RequestRows entries={requests} />}
    </details>}
  </section>
}

function Position({ row }: { row?: FeedRow & { position: number } }) {
  if (!row) return <>Unobserved</>
  return <details>
    <summary>#{row.position}</summary>
    <code dir="ltr">{row.captureId}</code>
    <code dir="ltr">{row.responseRow}</code>
    {row.storyId && <p>Lead <code dir="ltr">{row.itemId}</code></p>}
    {!!row.related?.length && <p>Related <code dir="ltr">{row.related.join(', ')}</code></p>}
  </details>
}

function diffTone(label: string) {
  if (label === 'Same captured row') return 'neutral'
  if (/only observed in baseline/i.test(label)) return 'danger'
  if (/only observed in current/i.test(label)) return 'info'
  return 'warning'
}

function rankDelta(before?: FeedRow & { position: number }, after?: FeedRow & { position: number }) {
  if (!before && after) return { label: 'NEW', tone: 'info' }
  if (before && !after) return { label: 'OUT', tone: 'danger' }
  if (!before || !after || before.position === after.position) return undefined
  const diff = before.position - after.position
  return { label: diff > 0 ? `+${diff}` : String(diff), tone: diff > 0 ? 'success' : 'warning' }
}

export function FeedComparisonView({ comparison, evidence }: { comparison: FeedComparison; evidence: Evidence[] }) {
  const [changesOnly, setChangesOnly] = useState(true)
  const { baseline, current } = comparison
  const differences = useMemo(() => feedDifferences(comparison), [comparison])
  const visible = changesOnly ? differences.filter(row => feedDifferenceLabel(row) !== 'Same captured row') : differences
  const coverageDiffers = baseline.pages.length !== current.pages.length || baseline.hasMore !== current.hasMore
  return <section aria-label="Feed comparison" className="inspector-block">
    <div className="inspector-section-head"><h2>Feed comparison</h2>
      <label><input type="checkbox" checked={changesOnly} onChange={event => setChangesOnly(event.target.checked)} /> Changes only</label>
    </div>
    <div className="saved-compare-scopes">
      <CaptureSide label="Baseline" snapshot={baseline} evidence={evidence} />
      <CaptureSide label="Current capture" snapshot={current} evidence={evidence} />
    </div>
    <p className="hint">Results describe the captured pages.{coverageDiffers && ' The two captures cover different page ranges.'}</p>
    {visible.length ? <div className="comparison-scroll" tabIndex={0} aria-label="Captured row differences">
      <table className="inspector-table"><thead><tr><th scope="col">Item</th><th scope="col">Baseline</th><th scope="col">Current</th><th scope="col">Result</th></tr></thead>
        <tbody>{visible.map(row => {
          const item = row.after ?? row.before!
          const label = feedDifferenceLabel(row)
          const delta = rankDelta(row.before, row.after)
          return <tr key={row.key} data-changed={label !== 'Same captured row' || undefined}><th scope="row" dir="auto">{item.title || item.itemId}</th>
            <td><Position row={row.before} /></td>
            <td><div className="inline-flex items-center gap-1.5 flex-wrap"><Position row={row.after} />{delta && <span className="status-badge" data-tone={delta.tone}>{delta.label}</span>}</div></td>
            <td><span className="status-badge" data-tone={diffTone(label)}>{label}</span></td></tr>
        })}</tbody>
      </table>
    </div> : <p className="hint">{changesOnly ? 'No changed rows in the captured pages.' : 'No rows in either capture.'}</p>}
  </section>
}
