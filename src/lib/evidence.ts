export type Verdict = 'running' | 'passed' | 'failed' | 'blocked' | 'unverified' | 'interrupted' | 'saved'
export interface Evidence {
  at: string
  label: string
  detail: unknown
  id?: string
  captureId?: string
  itemId?: string
  storyId?: string
  actionId?: string
  requestId?: string
}
export interface FeedCapture {
  id: string
  at: string
  surface: 'pods' | 'news' | 'saved'
  mode: 'inspect' | 'test'
  consumer: string
  session?: string
  query: Record<string, string>
}
export interface FeedRow {
  itemId: string
  storyId?: string
  title?: string
  publisher?: string
  related?: string[]
  captureId: string
  responseRow: string
}
export interface FeedSnapshot {
  environment: string
  runtime: string
  pages: FeedCapture[]
  rows: FeedRow[]
  hasMore: boolean
  omitted: number
  missingResponses: string[]
  rowsTrimmed?: boolean
}
export interface FeedComparison { baseline: FeedSnapshot; current: FeedSnapshot }
export function feedDifferences({ baseline, current }: FeedComparison) {
  const index = (snapshot: FeedSnapshot) => {
    const occurrences = new Map<string, number>()
    return new Map(snapshot.rows.map((row, position) => {
      const identity = snapshot.pages[0]?.surface === 'news' ? row.storyId ?? row.itemId : row.itemId
      const occurrence = (occurrences.get(identity) ?? 0) + 1
      occurrences.set(identity, occurrence)
      return [identity + '/' + occurrence, { ...row, position: position + 1 }] as const
    }))
  }
  const before = index(baseline), after = index(current)
  return [...new Set([...before.keys(), ...after.keys()])].map(key => ({
    key, before: before.get(key), after: after.get(key),
  }))
}

export function feedDifferenceLabel({ before, after }: ReturnType<typeof feedDifferences>[number]) {
  if (!before) return 'Only observed in current capture'
  if (!after) return 'Only observed in baseline'
  const changes = []
  if (before.position !== after.position) changes.push('Position changed')
  if (before.storyId && before.itemId !== after.itemId) changes.push('Lead article changed')
  if ((before.related ?? []).join(',') !== (after.related ?? []).join(',')) changes.push('Related stories changed')
  if (before.title !== after.title) changes.push('Title changed')
  if (before.publisher !== after.publisher) changes.push('Publisher changed')
  return changes.join(' · ') || 'Same captured row'
}
export interface CheckResult {
  label: string
  status: 'passed' | 'failed' | 'blocked' | 'unverified' | 'interrupted'
  detail?: string
}
export interface CheckSettings {
  surface: FeedCapture['surface']
  duration: string
  language: string
  windowName: string
  savedFilter?: 'all' | 'pods' | 'news'
  savedSort?: 'saved_desc' | 'saved_asc'
  ordinary?: boolean
  consumerId?: string
  itemId?: string
  itemTitle?: string
}
export interface InspectionSnapshot {
  itemId: string
  storyId?: string
  title: string
  storyView?: boolean
  capture?: FeedCapture
  responseRow?: string
  captured: Record<string, string>
  preview: Record<string, string>
  current: Record<string, string>
  checkedAt?: string
  findings: string[]
}
export interface RunDraft {
  title: string
  mode: 'inspect' | 'test'
  consumer: string
  scenario?: string
  restore?: boolean
  verdict: Verdict
  sequence: number
  evidence: Evidence[]
  note?: string
  inspection?: InspectionSnapshot
  comparison?: FeedComparison
  checks?: CheckResult[]
  settings?: CheckSettings
  trimmed?: boolean
}
export interface SavedRun extends RunDraft {
  version: 1
  id: string
  environment: string
  runtime: string
  created: string
  updated: string
  owner: string
  revisions?: { lab: string; cms: string; iam: string }
}

export function isFeedResponse(entry: Evidence) {
  return /^(GET|POST) \/(feed\/|interactions\/bookmarks$)/.test(entry.label) &&
    !entry.itemId && Boolean(entry.detail && typeof entry.detail === 'object' && 'response' in entry.detail)
}

export function fitRunEvidence<T extends RunDraft>(run: T): T {
  const encode = new TextEncoder()
  const evidence: Evidence[] = []
  // Leave space for server metadata and missing-response references.
  let size = encode.encode(JSON.stringify({ ...run, evidence: [] })).length
  for (const entry of [...run.evidence].reverse()) {
    const bytes = encode.encode(JSON.stringify(entry)).length + 1
    if (evidence.length === 200 || size + bytes > 4.75 * 1024 * 1024) continue
    evidence.push(entry)
    size += bytes
  }
  evidence.reverse()
  const available = new Set(evidence.filter(isFeedResponse).map(entry => entry.captureId))
  const snapshot = (side: FeedSnapshot): FeedSnapshot => ({
    ...side, missingResponses: side.pages.map(page => page.id).filter(id => !available.has(id)),
  })
  return {
    ...run, evidence, trimmed: run.trimmed || evidence.length < run.evidence.length || undefined,
    comparison: run.comparison && { baseline: snapshot(run.comparison.baseline), current: snapshot(run.comparison.current) },
  }
}

const secretKey = /password|authorization|cookie|token|secret|credential|api.?key|signature/i
export function redactText(value: string): string {
  return value
    .replace(/\b(?:https?|postgres(?:ql)?|redis(?:s)?):\/\/[^\s"'<>]+/gi, raw => {
      try {
        const url = new URL(raw)
        if (url.username || url.password || !/^https?:$/.test(url.protocol)) return '[redacted URL]'
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch { return '[redacted URL]' }
    })
    .replace(/\bBearer\s+[^\s,"]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gi, '[redacted credential]')
    .replace(/\b(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,]+/gi, '[redacted credential]')
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[depth limit]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(entry => redact(entry, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [key, secretKey.test(key) ? '[redacted]' : redact(entry, depth + 1)],
    ))
  }
  return value
}

export function markdown(run: SavedRun): string {
  const lines = [
    '# Feed Lab report', '', run.title.replace(/[\r\n]/g, ' '), '',
    `- Result: ${run.verdict}`, `- Environment: ${run.environment}`, `- Launch: ${run.runtime}`,
    `- Mode: ${run.mode}`, `- Consumer: ${run.consumer}`, `- Created: ${run.created}`,
    `- Scenario: ${run.scenario ?? 'Manual investigation'}`,
    `- Launch revisions: Feed Lab ${run.revisions?.lab ?? 'unavailable'} · CMS ${run.revisions?.cms ?? 'unavailable'} · IAM ${run.revisions?.iam ?? 'unavailable'}`,
    `- Restore reversible state: ${run.restore === undefined ? 'Not applicable' : run.restore ? 'Yes' : 'No'}`,
  ]
  lines.push('- Media links may expire. Playback observations describe the original capture.')
  if (run.inspection) {
    const item = run.inspection
    lines.push('', '## Selected item', '', item.title.replace(/[\r\n]/g, ' '), '', '- Content ID: ' + item.itemId)
    if (item.capture) lines.push('- Captured: ' + item.capture.at + ' · ' + item.capture.surface)
    if (item.responseRow) lines.push('- Response row: ' + item.responseRow)
    lines.push(...item.findings.map(finding => '- ' + finding.replace(/[\r\n]/g, ' ')))
    const fields = [...new Set([...Object.keys(item.captured), ...Object.keys(item.preview), ...Object.keys(item.current)])]
    if (fields.length) {
      const cell = (value?: string) => (value ?? 'Unavailable').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
      lines.push('', '| Field | Captured feed | Preview interpretation | Current CMS |', '| --- | --- | --- | --- |')
      for (const field of fields) {
        lines.push('| ' + [field, item.captured[field], item.preview[field], item.current[field]].map(cell).join(' | ') + ' |')
      }
    }
  }
  if (run.note) lines.push('', '## Investigation note', '', ...run.note.split(/\r?\n/).map(line => '> ' + line))
  if (run.checks?.length) {
    lines.push('', '## Check results', '', ...run.checks.map(check =>
      '- ' + [check.label, check.status, check.detail].filter(Boolean).join(' · ').replace(/[\r\n]+/g, ' ')))
  }
  if (run.comparison) {
    lines.push('', '## Feed comparison')
    for (const [label, snapshot] of [['Baseline', run.comparison.baseline], ['Current capture', run.comparison.current]] as const) {
      const first = snapshot.pages[0]
      if (!first) continue
      lines.push('', '### ' + label, '',
        '- Scope: ' + [snapshot.environment, snapshot.runtime, first.surface, first.mode, first.consumer].join(' · '),
        '- Captured: ' + snapshot.pages.map(page => page.at).join(', '),
        '- Frozen session: ' + (first.session ?? 'None'),
        '- Filters: ' + JSON.stringify(first.query),
        '- Coverage: ' + snapshot.pages.length + ' pages · ' + snapshot.rows.length + ' rows · ' +
          (snapshot.hasMore ? 'Continuation available' : 'No continuation') + ' · ' + snapshot.omitted + ' omissions')
      if (snapshot.rowsTrimmed || snapshot.missingResponses.length) lines.push('- Some rows or original responses are unavailable.')
    }
    for (const row of feedDifferences(run.comparison)) {
      const item = row.after ?? row.before
      const locator = (entry?: typeof row.before) => entry ? '#' + entry.position + ' (' + entry.captureId + ' ' + entry.responseRow + ')' : 'Unobserved'
      lines.push('- ' + (item?.title || item?.itemId || 'Item').replace(/[\r\n]+/g, ' ') + ' · ' + feedDifferenceLabel(row) +
        ' · ' + locator(row.before) + ' → ' + locator(row.after))
    }
  }
  if (run.trimmed) lines.push('', 'Some earlier evidence reached the capture limit.')
  for (const evidence of run.evidence) {
    const detail = JSON.stringify(evidence.detail, null, 2) ?? 'null'
    let fenceLength = 3
    for (const match of detail.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1)
    const fence = '`'.repeat(fenceLength)
    lines.push('', `## ${evidence.label.replace(/[\r\n]/g, ' ')}`, '', evidence.at, '', fence + 'json', detail, fence)
  }
  return lines.join('\n') + '\n'
}
