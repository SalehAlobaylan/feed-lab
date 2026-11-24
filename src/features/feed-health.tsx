import { AlertTriangle, BarChart3, CheckCircle2, Layers, X } from 'lucide-react'
import { useMemo } from 'react'
import type { Evidence } from '../lib/evidence'
import type { Page } from '../lib/feed'
import { auditFeed } from '../lib/feed-audit'
import type { Surface } from './consumer-preview'

export function FeedHealthPanel({ page, surface, evidence, canLoadMore, loadingBatch, onLoadBatch, onSelectIndex, onClose }: {
  page: Page | null
  surface: Surface
  evidence: Evidence[]
  canLoadMore: boolean
  loadingBatch: boolean
  onLoadBatch: () => void
  onSelectIndex: (index: number) => void
  onClose: () => void
}) {
  const audit = useMemo(() => auditFeed(page, surface, evidence), [page, surface, evidence])
  const maxBucket = Math.max(1, ...audit.durationBuckets.map(b => b.count))
  const transcriptPct = audit.totalItems ? Math.round((audit.transcriptCount / audit.totalItems) * 100) : 0
  const artworkPct = audit.totalItems ? Math.round((audit.artworkCount / audit.totalItems) * 100) : 0

  return <section className="studio-drawer" aria-label="Feed health audit">
    <div className="studio-drawer-head">
      <div className="summary-label">
        <BarChart3 size={16} className="text-[var(--accent)]" aria-hidden="true" />
        <div>
          <h2>Feed health &amp; composition</h2>
          <p className="hint">Live audit across {audit.totalItems} loaded {surface === 'news' ? 'slides' : 'items'} ({audit.pageCount} {audit.pageCount === 1 ? 'page' : 'pages'})</p>
        </div>
      </div>
      <div className="studio-drawer-actions">
        {canLoadMore && <button type="button" className="btn-subtle" disabled={loadingBatch} onClick={onLoadBatch}>
          <Layers size={13} aria-hidden="true" />{loadingBatch ? 'Loading pages…' : 'Load up to 5 pages'}
        </button>}
        <button type="button" className="btn-ghost" aria-label="Close feed health" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </div>

    {!audit.totalItems ? <p className="hint">Load a feed first to audit its composition, diversity, and contract health.</p> : <>
      <div className="audit-kpi-grid">
        <div className="audit-kpi">
          <span>Loaded</span>
          <strong>{audit.totalItems}</strong>
          <small>{audit.pageCount} {audit.pageCount === 1 ? 'page' : 'pages'} · {audit.omissionCount} omitted</small>
        </div>
        <div className="audit-kpi">
          <span>Publishers</span>
          <strong>{audit.publishers.length}</strong>
          <small>Top share {Math.round(audit.topPublisherShare * 100)}%</small>
        </div>
        {surface === 'pods' ? <div className="audit-kpi">
          <span>Transcripts</span>
          <strong>{transcriptPct}%</strong>
          <small>{audit.transcriptCount} of {audit.totalItems} · Artwork {artworkPct}%</small>
        </div> : surface === 'news' && audit.newsMetrics ? <div className="audit-kpi">
          <span>Multi-source</span>
          <strong>{audit.newsMetrics.multiSourceSlides}/{audit.totalItems}</strong>
          <small>Avg {audit.newsMetrics.avgSources} sources · {audit.newsMetrics.avgRelated} related</small>
        </div> : <div className="audit-kpi">
          <span>Artwork</span>
          <strong>{artworkPct}%</strong>
          <small>{audit.artworkCount} of {audit.totalItems} items</small>
        </div>}
        <div className="audit-kpi">
          <span>Page latency</span>
          <strong>{audit.latency.p50 !== undefined ? audit.latency.p50 + ' ms' : '—'}</strong>
          <small>{audit.latency.max !== undefined ? `p50 · max ${audit.latency.max} ms` : 'No timing samples'}</small>
        </div>
      </div>

      {audit.flags.length > 0 ? <ul className="findings audit-flags">
        {audit.flags.map((flag, i) => <li key={flag.code + '/' + i} data-severity={flag.severity}>
          <div>
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={14} aria-hidden="true" />{flag.title}
            </span>
            <p className="hint">{flag.detail}</p>
          </div>
          {flag.itemIndex !== undefined && <button type="button" className="inspector-link" onClick={() => onSelectIndex(flag.itemIndex!)}>
            Inspect #{flag.itemIndex + 1}
          </button>}
        </li>)}
      </ul> : <div className="all-clear-card">
        <CheckCircle2 size={15} className="shrink-0" aria-hidden="true" />
        <p>No duplicate IDs, duration violations, omissions, or severe source concentration detected in the loaded pages.</p>
      </div>}

      <div className="audit-columns">
        <div className="audit-card">
          <h3>Source concentration</h3>
          <ul className="bar-list">
            {audit.publishers.slice(0, 6).map(pub => <li key={pub.name}>
              <div className="bar-list-head">
                <button type="button" className="inspector-link" dir="auto" onClick={() => onSelectIndex(pub.indices[0])}>{pub.name}</button>
                <span>{pub.count} ({Math.round(pub.share * 100)}%)</span>
              </div>
              <div className="bar-track" aria-hidden="true">
                <div className="bar-fill" data-warn={audit.totalItems >= 4 && pub.share > 0.4 || undefined} style={{ width: Math.max(4, Math.round(pub.share * 100)) + '%' }} />
              </div>
            </li>)}
          </ul>
        </div>

        {surface === 'pods' && <div className="audit-card">
          <h3>Duration buckets &amp; media mix</h3>
          <div className="bucket-chart" aria-label="Duration bucket distribution">
            {audit.durationBuckets.map(bucket => <div key={bucket.bucket} className="bucket-col">
              <span className="bucket-count">{bucket.count}</span>
              <div className="bucket-bar-wrap" aria-hidden="true">
                <div className="bucket-bar" style={{ height: bucket.count ? Math.max(12, Math.round((bucket.count / maxBucket) * 100)) + '%' : '2px' }} />
              </div>
              <span className="bucket-label">{bucket.bucket}</span>
            </div>)}
          </div>
          <div className="mix-pills">
            <span className="meta-pill">Chapters: {audit.atomizedCount}</span>
            <span className="meta-pill">Raw: {audit.rawCount}</span>
            <span className="meta-pill">HLS: {audit.formatMix.hls}</span>
            <span className="meta-pill">MP4: {audit.formatMix.mp4}</span>
            <span className="meta-pill">Audio: {audit.formatMix.audio}</span>
          </div>
        </div>}

        {surface === 'news' && audit.newsMetrics && <div className="audit-card">
          <h3>Cluster &amp; slide quality</h3>
          <dl className="inspector-facts">
            <div><dt>Multi-source clusters</dt><dd>{audit.newsMetrics.multiSourceSlides}</dd></div>
            <div><dt>Single-source stories</dt><dd>{audit.newsMetrics.singleSourceSlides}</dd></div>
            <div><dt>Avg sources / story</dt><dd>{audit.newsMetrics.avgSources}</dd></div>
            <div><dt>Avg related / slide</dt><dd>{audit.newsMetrics.avgRelated}</dd></div>
            <div><dt>Missing excerpts</dt><dd>{audit.newsMetrics.missingExcerptCount}</dd></div>
          </dl>
        </div>}
      </div>
    </>}
  </section>
}
