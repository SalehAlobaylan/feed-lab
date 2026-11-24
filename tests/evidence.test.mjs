import assert from 'node:assert/strict'
import test from 'node:test'
import { adapt, consumption } from '../src/lib/feed.ts'
import { feedDifferenceLabel, feedDifferences, fitRunEvidence, markdown, redact } from '../src/lib/evidence.ts'
import { auditFeed, evaluateEligibility } from '../src/lib/feed-audit.ts'

test('preview exposes invalid Pods and retains the original cursor', () => {
  const result = adapt({ cursor: 'next', items: [
    { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', duration_sec: 270, playback_url: 'https://media.example/audio' },
    { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', duration_sec: 269, playback_url: 'https://media.example/audio' },
  ] }, 'pods')
  assert.equal(result.items.length, 1)
  assert.equal(result.omitted.length, 1)
  assert.equal(result.cursor, 'next')
})

test('News coverage retains the exact source row and reports malformed articles', () => {
  const featured = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const related = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const article = 'cccccccc-cccc-4ccc-accc-cccccccccccc'
  const capture = { id: 'capture' }
  const result = adapt({ slides: [{
    featured: { story_id: featured, lead_id: article },
    related: [{ story_id: related, lead_id: article, members: [{ id: 'invalid' }, { id: article }] }],
  }] }, 'news', capture)

  const member = result.items[0].related[0].members[0]
  assert.equal(member.story_id, related)
  assert.equal(member.capture, capture)
  assert.equal(member.responseRow, 'slides[0].related[0].members[1]')
  assert.deepEqual(result.omitted, ['slides[0].related[0].members[0] has invalid article metadata.'])
})

test('a seek without measured playback cannot qualify consumption', () => {
  assert.equal(consumption(1, 267, 270), null)
  assert.equal(consumption(27, 30, 270).consumption_classification, 'meaningful')
  assert.equal(consumption(27, 243, 270).consumption_classification, 'complete')
})

test('export derives from redacted evidence and fences embedded Markdown', () => {
  const detail = redact({ authorization: 'sensitive', url: 'https://media.example/play?sig=private', text: '```\n# Content' })
  assert.equal(detail.authorization, '[redacted]')
  assert.equal(detail.url, 'https://media.example/play')
  const report = markdown({ title: 'Observed run', verdict: 'interrupted', evidence: [{ at: '2026-11-10', label: 'Evidence', detail }] })
  assert.match(report, /\- Result: interrupted/)
  assert.match(report, /````json/)
  assert.doesNotMatch(report, /sensitive|sig=private/)
})

test('feed comparison keeps News story positions and reports lead and related changes', () => {
  const first = { storyId: 'story-1', itemId: 'old-lead', title: 'Story 1', related: ['related-1'] }
  const second = { storyId: 'story-2', itemId: 'second-lead', title: 'Story 2' }
  const comparison = {
    baseline: { pages: [{ surface: 'news' }], rows: [first, second] },
    current: { pages: [{ surface: 'news' }], rows: [second, { ...first, itemId: 'new-lead', related: ['related-2'] }] },
  }
  const rows = feedDifferences(comparison)
  assert.equal(rows.length, 2)
  assert.equal(feedDifferenceLabel(rows[0]), 'Position changed · Lead article changed · Related stories changed')
  assert.equal(rows[0].after.itemId, 'new-lead')
})

test('report evidence stays bounded and marks any omitted original responses', () => {
  const side = { pages: [{ id: 'old' }, { id: 'retained' }], missingResponses: [] }
  const evidence = [
    { label: 'GET /feed/news', captureId: 'old', detail: { response: 'x'.repeat(5 * 1024 * 1024) } },
    { label: 'GET /feed/news', captureId: 'retained', detail: { response: [] } },
  ]
  const fit = fitRunEvidence({ evidence, comparison: { baseline: side, current: side } })
  assert.equal(fit.trimmed, true)
  assert.deepEqual(fit.evidence, evidence.slice(1))
  assert.deepEqual(fit.comparison.baseline.missingResponses, ['old'])
})

test('auditFeed reports source concentration, duration buckets, duplicates, and latency', () => {
  const capture = { id: 'cap-1', at: '2026-11-11T00:00:00Z', surface: 'pods', mode: 'inspect', consumer: 'Anonymous', query: {} }
  const idA = '11111111-1111-4111-8111-111111111111'
  const idB = '22222222-2222-4222-8222-222222222222'
  const idC = '33333333-3333-4333-8333-333333333333'
  const page = {
    items: [
      { id: idA, title: 'A', source_name: 'Pub 1', duration_sec: 300, playback_url: 'https://m.example/a.m3u8', playback_type: 'hls', transcript_id: 't1', parent_id: 'p1' },
      { id: idB, title: 'B', source_name: 'Pub 1', duration_sec: 900, playback_url: 'https://m.example/b.mp4', playback_type: 'mp4', parent_id: 'p1' },
      { id: idC, title: 'C', source_name: 'Pub 1', duration_sec: 1800, playback_url: 'https://m.example/c.mp3', playback_type: 'audio' },
      { id: idA, title: 'A dup', source_name: 'Pub 2', duration_sec: 300, playback_url: 'https://m.example/a.m3u8', playback_type: 'hls' },
    ],
    caughtUp: false, captures: [capture], rows: [], omitted: [], omissions: [],
  }
  const evidence = [{ at: '2026-11-11T00:00:00Z', label: 'POST /feed/pods/sessions', captureId: 'cap-1', detail: { elapsed_ms: 42, response: { items: [] } } }]
  const report = auditFeed(page, 'pods', evidence)
  assert.equal(report.totalItems, 4)
  assert.equal(report.publishers[0].name, 'Pub 1')
  assert.equal(report.publishers[0].count, 3)
  assert.deepEqual(report.duplicateIds, [3])
  assert.equal(report.atomizedCount, 2)
  assert.equal(report.rawCount, 2)
  assert.equal(report.transcriptCount, 1)
  assert.equal(report.latency.p50, 42)
  assert.ok(report.flags.some(f => f.code === 'duplicate_identity'))
  assert.ok(report.flags.some(f => f.code === 'source_dominance'))
  assert.ok(report.flags.some(f => f.code === 'sibling_proximity'))
})

test('evaluateEligibility flags non-READY status, >2400s parent rule, and language mismatch', () => {
  const gates = evaluateEligibility({
    item: { id: '11111111-1111-4111-8111-111111111111', duration_sec: 3600, content_language: 'ar' },
    cms: { status: 'PROCESSING', duration_sec: 3600, content_language: 'ar' },
    summary: { item_type: 'PODS_PARENT', eligibility: { status: 'Excluded by policy', detail: 'Parent publishes via chapters' } },
    surface: 'pods',
    filters: { duration: '', language: 'en', windowName: 'today' },
    isNews: false,
  })
  assert.equal(gates.find(g => g.id === 'status')?.status, 'fail')
  assert.equal(gates.find(g => g.id === 'cms_eligibility')?.status, 'fail')
  assert.equal(gates.find(g => g.id === 'duration')?.status, 'fail')
  assert.equal(gates.find(g => g.id === 'language_filter')?.status, 'warning')
})
