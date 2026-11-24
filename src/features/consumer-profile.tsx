import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, SlidersHorizontal, Trash2, UserCheck, Volume2, VolumeX, X } from 'lucide-react'
import { useState } from 'react'
import { owner, type Scope } from '../lib/client'
import type { Evidence } from '../lib/evidence'
import { fields, rows, text, time } from '../lib/inspection'

interface TopicItem {
  id: string
  slug: string
  label_ar?: string
  label_en?: string
  category_slug?: string
  score?: number
}

function topicLabel(topic: TopicItem) {
  return [topic.label_en, topic.label_ar].filter(Boolean).join(' · ') || topic.slug || topic.id.slice(0, 8)
}

export function ConsumerProfilePanel({ scope, ready, locked, onEvidence, onRefreshFeed, onClose }: {
  scope: Scope
  ready: boolean
  locked: boolean
  onEvidence: (entry: Evidence) => void
  onRefreshFeed: () => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  const keyBase = ['consumer-profile', scope.health.runtime_id, scope.operatorID, scope.mode, scope.consumerID]
  const canEdit = scope.mode === 'test' && scope.signed && ready && !locked && !mutating

  const prefsQuery = useQuery({
    queryKey: [...keyBase, 'prefs'],
    enabled: ready && scope.signed,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => owner<unknown>(scope, '/preferences', { signal, record: onEvidence }),
  })

  const pickerQuery = useQuery({
    queryKey: [...keyBase, 'picker'],
    enabled: ready && scope.signed,
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) => owner<unknown>(scope, '/topics/picker', { signal, record: onEvidence }),
  })

  const historyQuery = useQuery({
    queryKey: [...keyBase, 'history'],
    enabled: ready && scope.signed,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => owner<unknown>(scope, '/interactions/history', { signal, query: { limit: '15' }, record: onEvidence }),
  })

  const prefs = fields(prefsQuery.data)
  const toTopics = (list: unknown): TopicItem[] => rows(list).flatMap(row => {
    const id = text(row.id) ?? text(row.public_id)
    if (!id) return []
    return [{
      id,
      slug: text(row.slug) ?? '',
      label_ar: text(row.label_ar),
      label_en: text(row.label_en),
      category_slug: text(row.category_slug),
      score: typeof row.score === 'number' ? row.score : undefined,
    }]
  })

  const declared = toTopics(prefs.declared)
  const learned = toTopics(prefs.learned)
  const muted = toTopics(prefs.muted)
  const mutedSources = rows(prefs.muted_sources)
  const pickerTopics = toTopics(fields(pickerQuery.data).topics)
  const historyRows = rows(fields(historyQuery.data).items ?? fields(historyQuery.data).data)
  const declaredIds = new Set(declared.map(t => t.id))

  async function runMutation(work: () => Promise<void>, message: string) {
    if (!canEdit) return
    setMutating(true); setError(''); setStatus('')
    try {
      await work()
      setStatus(message)
      await queryClient.invalidateQueries({ queryKey: keyBase })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preference update failed.')
    } finally {
      setMutating(false)
    }
  }

  function toggleDeclaredTopic(topicId: string) {
    const next = new Set(declaredIds)
    if (next.has(topicId)) next.delete(topicId)
    else next.add(topicId)
    void runMutation(
      () => owner(scope, '/preferences/topics', { method: 'PUT', body: { topic_ids: [...next] }, record: onEvidence }).then(() => {}),
      'Updated declared topics. Refresh the feed to test ranking impact.',
    )
  }

  function toggleMuteTopic(topicId: string, currentlyMuted: boolean) {
    void runMutation(
      () => owner(scope, `/preferences/topics/${topicId}/mute`, { method: currentlyMuted ? 'DELETE' : 'POST', record: onEvidence }).then(() => {}),
      currentlyMuted ? 'Topic unmuted.' : 'Topic muted.',
    )
  }

  function clearHistory() {
    void runMutation(
      () => owner(scope, '/interactions/history', { method: 'DELETE', record: onEvidence }).then(() => {}),
      'Watch history cleared. Refresh the feed to compare.',
    )
  }

  return <section className="studio-drawer" aria-label="Consumer profile and preferences">
    <div className="studio-drawer-head">
      <div className="summary-label">
        <UserCheck size={16} className="text-[var(--accent)]" aria-hidden="true" />
        <div>
          <h2>Consumer profile &amp; personalization</h2>
          <p className="hint">{scope.mode === 'test' ? 'Test as user: toggle topics, mute affinities, or clear watch history to test feed impact.' : 'Read-only in Inspect mode. Switch to Test as user to edit preferences.'}</p>
        </div>
      </div>
      <div className="studio-drawer-actions">
        <button type="button" className="btn-subtle" disabled={locked || mutating} onClick={() => {
          void prefsQuery.refetch(); void historyQuery.refetch()
        }}><RefreshCw size={13} aria-hidden="true" />Reload profile</button>
        <button type="button" className="primary" disabled={locked || mutating} onClick={onRefreshFeed}>Refresh feed</button>
        <button type="button" className="btn-ghost" aria-label="Close consumer profile" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </div>

    {error && <p className="problem" role="alert">{error}</p>}
    {status && <p className="notice" role="status">{status}</p>}

    <div className="profile-grid">
      <div className="audit-card">
        <h3>Declared topics ({declared.length})</h3>
        {prefsQuery.isFetching ? <p className="hint">Loading preferences…</p> :
          prefsQuery.error ? <p className="inspector-message" role="alert">{prefsQuery.error instanceof Error ? prefsQuery.error.message : 'Unable to load preferences.'}</p> :
          pickerTopics.length > 0 ? <div className="topic-chips">
            {pickerTopics.map(topic => {
              const active = declaredIds.has(topic.id)
              return <button key={topic.id} type="button" className="topic-chip" aria-pressed={active}
                disabled={!canEdit} title={canEdit ? 'Toggle declared topic' : 'Switch to Test as user to edit'}
                onClick={() => toggleDeclaredTopic(topic.id)} dir="auto">
                {topicLabel(topic)}
              </button>
            })}
          </div> : declared.length > 0 ? <div className="topic-chips">
            {declared.map(topic => <span key={topic.id} className="meta-pill" dir="auto">{topicLabel(topic)}</span>)}
          </div> : <p className="hint">No declared topics yet.</p>}
      </div>

      <div className="audit-card">
        <h3>Learned affinities ({learned.length})</h3>
        {learned.length > 0 ? <ul className="bar-list">
          {learned.slice(0, 8).map(topic => {
            const pct = Math.min(100, Math.max(5, Math.round((topic.score ?? 0) * 100)))
            return <li key={topic.id}>
              <div className="bar-list-head">
                <span dir="auto">{topicLabel(topic)}</span>
                <span className="inline-flex items-center gap-2">
                  <span>{topic.score !== undefined ? topic.score.toFixed(2) : '—'}</span>
                  {canEdit && <button type="button" className="btn-ghost mini-btn" title="Mute topic" onClick={() => toggleMuteTopic(topic.id, false)}>
                    <VolumeX size={12} aria-hidden="true" />Mute
                  </button>}
                </span>
              </div>
              <div className="bar-track" aria-hidden="true"><div className="bar-fill" style={{ width: pct + '%' }} /></div>
            </li>
          })}
        </ul> : <p className="hint">No learned topic affinities above threshold.</p>}
      </div>

      <div className="audit-card">
        <h3>Muted topics &amp; sources</h3>
        {muted.length > 0 ? <div className="topic-chips">
          {muted.map(topic => <span key={topic.id} className="muted-chip" dir="auto">
            {topicLabel(topic)}
            {canEdit && <button type="button" className="btn-ghost mini-btn" onClick={() => toggleMuteTopic(topic.id, true)}>
              <Volume2 size={12} aria-hidden="true" />Unmute
            </button>}
          </span>)}
        </div> : <p className="hint">No muted topics.</p>}
        {mutedSources.length > 0 && <div className="mix-pills">
          {mutedSources.map((src, i) => <span key={i} className="meta-pill">Muted source: {text(src.source_key) ?? 'unknown'}</span>)}
        </div>}
      </div>

      <div className="audit-card">
        <div className="inspector-section-head">
          <h3>Recent watch history ({historyRows.length})</h3>
          {canEdit && historyRows.length > 0 && <button type="button" className="btn-danger mini-btn" onClick={clearHistory}>
            <Trash2 size={12} aria-hidden="true" />Clear history
          </button>}
        </div>
        {historyQuery.isFetching ? <p className="hint">Loading history…</p> :
          historyQuery.error ? <p className="hint">Watch history unavailable.</p> :
          historyRows.length > 0 ? <ul className="inspector-related history-mini-list">
            {historyRows.slice(0, 8).map((row, idx) => <li key={text(row.id) ?? idx}>
              <strong dir="auto">{text(row.title) ?? text(row.content_item_id) ?? 'Watched item'}</strong>
              <small>{[text(row.source_name), time(text(row.viewed_at ?? row.created_at))].filter(Boolean).join(' · ')}</small>
            </li>)}
          </ul> : <p className="hint"><SlidersHorizontal size={12} className="inline mr-1" aria-hidden="true" />No recent watch history.</p>}
      </div>
    </div>
  </section>
}
