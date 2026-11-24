import type { CheckSettings, Evidence } from './evidence'
import type { Item, Page } from './feed'

function isFeedResponse(entry: Evidence) {
  return /^(GET|POST) \/(feed\/|interactions\/bookmarks$)/.test(entry.label) &&
    !entry.itemId && Boolean(entry.detail && typeof entry.detail === 'object' && 'response' in entry.detail)
}

function safeURL(value?: string): string | undefined {
  if (typeof value !== 'string' || !value) return
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href } catch { /* invalid URL */ }
}

function playbackInfo(item: Item) {
  const url = safeURL(item.playback_url || item.media_url)
  const declared = item.playback_type
  const type = declared === 'hls' || declared === 'audio' || declared === 'mp4' ? declared :
    url?.includes('.m3u8') ? 'hls' : /\.(mp3|m4a|ogg|aac)(?:\?|$)/i.test(url ?? '') ? 'audio' : 'mp4'
  return { url, type } as const
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

export interface PublisherShare {
  name: string
  count: number
  share: number
  indices: number[]
}

export interface BucketCount {
  bucket: string
  count: number
  share: number
}

export interface AuditFlag {
  severity: 'danger' | 'warning'
  code: string
  title: string
  detail: string
  itemIndex?: number
}

export interface FeedAudit {
  totalItems: number
  pageCount: number
  omissionCount: number
  publishers: PublisherShare[]
  topPublisherShare: number
  durationBuckets: BucketCount[]
  formatMix: { hls: number; mp4: number; audio: number }
  atomizedCount: number
  rawCount: number
  transcriptCount: number
  artworkCount: number
  languageMix: { label: string; count: number }[]
  newsMetrics?: {
    multiSourceSlides: number
    singleSourceSlides: number
    avgSources: number
    avgRelated: number
    missingExcerptCount: number
  }
  latency: {
    samples: number[]
    p50?: number
    max?: number
  }
  duplicateIds: number[]
  siblingCollisions: { parentId: string; indices: number[] }[]
  flags: AuditFlag[]
}

export type EligibilityTone = 'pass' | 'fail' | 'warning' | 'unknown'

export interface EligibilityGate {
  id: string
  label: string
  status: EligibilityTone
  detail: string
}

const BUCKET_ORDER = ['5m', '10m', '15m', '20m', '30m', '40m'] as const

function durationBucket(sec: number): string {
  if (sec < 450) return '5m'
  if (sec < 750) return '10m'
  if (sec < 1050) return '15m'
  if (sec < 1500) return '20m'
  if (sec < 2100) return '30m'
  return '40m'
}

export function auditFeed(page: Page | null, surface: 'pods' | 'news' | 'saved', evidence: Evidence[]): FeedAudit {
  const items = page?.items ?? []
  const totalItems = items.length
  const pageCount = page?.captures.length ?? 0
  const omissionCount = page?.omissions.length ?? 0

  const publisherMap = new Map<string, number[]>()
  const bucketMap = new Map<string, number>(BUCKET_ORDER.map(key => [key, 0]))
  const formatMix = { hls: 0, mp4: 0, audio: 0 }
  const langMap = new Map<string, number>()
  const seenIdentity = new Map<string, number>()
  const parentMap = new Map<string, number[]>()
  const duplicateIds: number[] = []
  const flags: AuditFlag[] = []

  let atomizedCount = 0
  let rawCount = 0
  let transcriptCount = 0
  let artworkCount = 0
  let multiSourceSlides = 0
  let singleSourceSlides = 0
  let totalSources = 0
  let totalRelated = 0
  let missingExcerptCount = 0

  items.forEach((item, index) => {
    const pub = (item.source_name || item.author || 'Unknown publisher').trim()
    const indices = publisherMap.get(pub) ?? []
    indices.push(index)
    publisherMap.set(pub, indices)

    const lang = (item.content_language || 'unspecified').toLowerCase()
    langMap.set(lang, (langMap.get(lang) ?? 0) + 1)

    if (safeURL(item.thumbnail_url)) artworkCount++

    const identity = surface === 'news' ? item.story_id || item.id : item.id
    if (seenIdentity.has(identity)) {
      duplicateIds.push(index)
      flags.push({
        severity: 'danger',
        code: 'duplicate_identity',
        title: `Duplicate ${surface === 'news' ? 'story' : 'item'} at #${index + 1}`,
        detail: `${item.title || identity} also appeared at #${seenIdentity.get(identity)! + 1}.`,
        itemIndex: index,
      })
    } else {
      seenIdentity.set(identity, index)
    }

    if (surface === 'pods') {
      const dur = item.duration_sec
      if (typeof dur !== 'number' || !Number.isFinite(dur) || dur < 270 || dur > 2400) {
        flags.push({
          severity: 'danger',
          code: 'duration_bounds',
          title: `Duration out of bounds at #${index + 1}`,
          detail: `${item.title || item.id} has duration ${dur ?? 'missing'}s (allowed: 270–2400s).`,
          itemIndex: index,
        })
      } else {
        const key = durationBucket(dur)
        bucketMap.set(key, (bucketMap.get(key) ?? 0) + 1)
      }

      const resolved = playbackInfo(item)
      formatMix[resolved.type]++
      if (!resolved.url) {
        flags.push({
          severity: 'danger',
          code: 'missing_playback',
          title: `Missing playback source at #${index + 1}`,
          detail: `${item.title || item.id} has no approved playback URL.`,
          itemIndex: index,
        })
      }

      if (item.parent_id) {
        atomizedCount++
        const siblings = parentMap.get(item.parent_id) ?? []
        siblings.push(index)
        parentMap.set(item.parent_id, siblings)
      } else {
        rawCount++
      }

      if (item.transcript_id) transcriptCount++
    } else if (surface === 'news') {
      const sourceCount = item.source_count || item.members?.length || 1
      totalSources += sourceCount
      if (sourceCount > 1) multiSourceSlides++
      else singleSourceSlides++
      totalRelated += item.related?.length ?? 0
      if (!item.summary && !item.excerpt) missingExcerptCount++
    }
  })

  const publishers: PublisherShare[] = [...publisherMap.entries()]
    .map(([name, indices]) => ({
      name,
      count: indices.length,
      share: totalItems ? indices.length / totalItems : 0,
      indices,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const topPublisherShare = publishers[0]?.share ?? 0
  if (totalItems >= 4 && topPublisherShare > 0.4) {
    flags.push({
      severity: 'warning',
      code: 'source_dominance',
      title: `Publisher concentration (${Math.round(topPublisherShare * 100)}%)`,
      detail: `${publishers[0].name} accounts for ${publishers[0].count} of ${totalItems} loaded items.`,
      itemIndex: publishers[0].indices[0],
    })
  }

  const siblingCollisions: { parentId: string; indices: number[] }[] = []
  for (const [parentId, indices] of parentMap.entries()) {
    if (indices.length > 1) {
      siblingCollisions.push({ parentId, indices })
      const adjacent = indices.some((idx, pos) => pos > 0 && idx - indices[pos - 1] <= 2)
      if (adjacent) {
        flags.push({
          severity: 'warning',
          code: 'sibling_proximity',
          title: 'Multiple chapters from the same parent appear close together',
          detail: `Parent ${parentId.slice(0, 8)} appears at positions ${indices.map(i => '#' + (i + 1)).join(', ')}.`,
          itemIndex: indices[1],
        })
      }
    }
  }

  if (omissionCount > 0) {
    flags.push({
      severity: 'danger',
      code: 'contract_omissions',
      title: `${omissionCount} response row${omissionCount === 1 ? '' : 's'} omitted by preview contract`,
      detail: 'Inspect Evidence for exact malformed or ineligible rows.',
    })
  }

  if (surface === 'pods' && totalItems >= 3 && transcriptCount === 0) {
    flags.push({
      severity: 'warning',
      code: 'no_transcripts',
      title: 'Zero transcript coverage across loaded Pods',
      detail: 'None of the loaded items carry a transcript_id.',
    })
  }

  const captureIds = new Set((page?.captures ?? []).map(c => c.id))
  const samples = evidence
    .filter(entry => isFeedResponse(entry) && (!captureIds.size || (entry.captureId && captureIds.has(entry.captureId))))
    .map(entry => fields(entry.detail).elapsed_ms)
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))
  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.5)] : undefined
  const max = sorted.length ? sorted[sorted.length - 1] : undefined

  const durationBuckets: BucketCount[] = BUCKET_ORDER.map(bucket => {
    const count = bucketMap.get(bucket) ?? 0
    return { bucket, count, share: totalItems ? count / totalItems : 0 }
  })

  const languageMix = [...langMap.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)

  return {
    totalItems,
    pageCount,
    omissionCount,
    publishers,
    topPublisherShare,
    durationBuckets,
    formatMix,
    atomizedCount,
    rawCount,
    transcriptCount,
    artworkCount,
    languageMix,
    newsMetrics: surface === 'news' ? {
      multiSourceSlides,
      singleSourceSlides,
      avgSources: totalItems ? Number((totalSources / totalItems).toFixed(1)) : 0,
      avgRelated: totalItems ? Number((totalRelated / totalItems).toFixed(1)) : 0,
      missingExcerptCount,
    } : undefined,
    latency: { samples, p50, max },
    duplicateIds,
    siblingCollisions,
    flags,
  }
}

export function evaluateEligibility(params: {
  item?: Item
  cms: Record<string, unknown>
  summary: Record<string, unknown>
  surface: 'pods' | 'news' | 'saved'
  filters: Pick<CheckSettings, 'duration' | 'language' | 'windowName'>
  isNews: boolean
}): EligibilityGate[] {
  const { item, cms, summary, surface, filters, isNews } = params
  const gates: EligibilityGate[] = []

  // 1. Workflow status
  const status = text(cms.status)
  if (status) {
    gates.push({
      id: 'status',
      label: 'Content status',
      status: status === 'READY' ? 'pass' : 'fail',
      detail: status === 'READY' ? 'READY for feed consideration' : `Status is ${status} (must be READY)`,
    })
  } else {
    gates.push({ id: 'status', label: 'Content status', status: 'unknown', detail: 'Load CMS record to inspect status.' })
  }

  // 2. CMS eligibility verdict
  const eligibility = fields(summary.eligibility)
  const eligStatus = text(eligibility.status)
  if (eligStatus) {
    const blocked = /excluded|not met|ineligible|suppressed/i.test(eligStatus)
    gates.push({
      id: 'cms_eligibility',
      label: 'CMS eligibility gate',
      status: blocked ? 'fail' : 'pass',
      detail: eligStatus,
    })
  } else {
    gates.push({ id: 'cms_eligibility', label: 'CMS eligibility gate', status: 'unknown', detail: 'CMS eligibility summary unavailable.' })
  }

  // 3. Publication / generation gate
  const publication = fields(summary.publication)
  const pubStatus = text(publication.status)
  if (pubStatus) {
    const active = /in active|published|eligible/i.test(pubStatus)
    const missing = /not in|excluded|withdrawn|unpub/i.test(pubStatus)
    gates.push({
      id: 'publication',
      label: 'Active publication',
      status: active ? 'pass' : missing ? 'fail' : 'warning',
      detail: pubStatus,
    })
  }

  // 4. Pods duration & atomization bounds
  if (!isNews) {
    const dur = typeof item?.duration_sec === 'number' ? item.duration_sec :
      typeof cms.duration_sec === 'number' ? cms.duration_sec : undefined
    const itemType = text(summary.item_type)
    if (itemType === 'PODS_PARENT' || (typeof dur === 'number' && dur > 2400)) {
      gates.push({
        id: 'duration',
        label: 'Pods duration & parent rule',
        status: 'fail',
        detail: `Parent media > 2400s (${dur ? Math.round(dur) + 's' : 'long episode'}) is hidden raw and publishes via atomized chapters.`,
      })
    } else if (typeof dur === 'number') {
      const ok = dur >= 270 && dur <= 2400
      gates.push({
        id: 'duration',
        label: 'Pods duration bounds',
        status: ok ? 'pass' : 'fail',
        detail: ok ? `${Math.round(dur)}s is within the 270–2400s feed unit window.` : `${Math.round(dur)}s violates the 270–2400s feed unit rule.`,
      })
    }
  }

  // 5. Active preview filter match (language / News window)
  if (surface === 'pods' && filters.language) {
    const lang = item?.content_language || text(cms.content_language)
    if (lang) {
      const matches = lang.toLowerCase().startsWith(filters.language.toLowerCase())
      gates.push({
        id: 'language_filter',
        label: 'Preview language filter',
        status: matches ? 'pass' : 'warning',
        detail: matches ? `Matches active filter (${filters.language}).` : `Item language is "${lang}" while preview filters for "${filters.language}".`,
      })
    }
  }

  if (surface === 'news' && isNews) {
    const publishedAt = item?.published_at || text(cms.published_at)
    if (publishedAt && Number.isFinite(Date.parse(publishedAt))) {
      const ageHours = (Date.now() - Date.parse(publishedAt)) / 3600_000
      const maxHours = filters.windowName === 'today' ? 36 : filters.windowName === 'week' ? 24 * 8 : 24 * 32
      const inWindow = ageHours <= maxHours
      gates.push({
        id: 'news_window',
        label: `News "${filters.windowName}" window`,
        status: inWindow ? 'pass' : 'warning',
        detail: inWindow ? 'Published within the active preview time window.' : `Published ~${Math.round(ageHours / 24)}d ago, outside the "${filters.windowName}" window.`,
      })
    }
  }

  return gates
}
