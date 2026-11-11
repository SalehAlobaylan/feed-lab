import assert from 'node:assert/strict'
import test from 'node:test'
import { adapt, consumption } from '../src/lib/feed.ts'
import { feedDifferenceLabel, feedDifferences, fitRunEvidence, markdown, redact } from '../src/lib/evidence.ts'

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
