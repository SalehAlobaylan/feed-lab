import type { FeedCapture, FeedRow } from './evidence'

export interface Item {
  id: string
  title?: string
  excerpt?: string
  summary?: string
  thumbnail_url?: string
  source_image_url?: string
  original_url?: string
  source_name?: string
  author?: string
  published_at?: string
  last_member_at?: string
  type?: string
  format?: string
  source?: string
  duration_bucket?: string
  parent_id?: string
  chapter_index?: number
  chapter_start_ms?: number
  chapter_end_ms?: number
  content_language?: string
  rendition_digest?: string
  active_rendition_generation_id?: string
  body_text?: string
  label?: string
  member_count?: number
  capture?: FeedCapture
  responseRow?: string
  capturedFields?: Record<string, string>
  rendition_set_version?: number
  audio_scene_profile?: unknown
  like_count?: number
  comment_count?: number
  source_count?: number
  duration_sec?: number
  playback_url?: string
  playback_type?: string
  media_url?: string
  fallback_playback_url?: string
  fallback_playback_type?: string
  has_video?: boolean
  fallback_has_video?: boolean
  transcript_id?: string
  is_liked?: boolean
  is_bookmarked?: boolean
  bookmarked_at?: string
  story_id?: string
  related?: Item[]
  members?: Item[]
}
export interface Omission { row: string; reason: string; itemId?: string; storyId?: string; captureId?: string }
export interface Page {
  items: Item[]
  cursor?: string | null
  session_id?: string
  expiresAt?: string
  caughtUp: boolean
  captures: FeedCapture[]
  rows: FeedRow[]
  omitted: string[]
  omissions: Omission[]
}
const idPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
export const validID = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value)
export function safeURL(value?: string): string | undefined {
  if (typeof value !== 'string' || !value) return
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href } catch { /* invalid URL */ }
}
const displayFields = ['title', 'excerpt', 'summary', 'thumbnail_url', 'source_image_url', 'original_url', 'source_name', 'author',
  'published_at', 'last_member_at', 'type', 'format', 'source', 'duration_bucket', 'parent_id'] as const
function hasDisplayFields(item: Item) {
  return displayFields.every(field => item[field] == null || typeof item[field] === 'string')
}
function omission(row: string, reason: string, value?: unknown): Omission {
  const item = value as (Item & { lead_id?: string }) | null | undefined
  const id = item?.id ?? item?.lead_id
  return { row, reason, itemId: validID(id) ? id : undefined, storyId: validID(item?.story_id) ? item.story_id : undefined }
}
function story(value: unknown, path: string, omitted: Omission[], capture?: FeedCapture): Item | undefined {
  if (!value || typeof value !== 'object') return
  const row = value as Item & { lead_id?: string; label?: string }
  if (!row.story_id || !validID(row.story_id) || !row.lead_id || !validID(row.lead_id) || !hasDisplayFields(row) ||
      (row.label != null && typeof row.label !== 'string')) return
  if (row.members != null && !Array.isArray(row.members)) omitted.push(omission(`${path}.members`, 'has invalid coverage.'))
  const members = Array.isArray(row.members) ? row.members.flatMap((member, index) => {
    const responseRow = `${path}.members[${index}]`
    if (member && validID(member.id) && hasDisplayFields(member)) {
      return [{ ...member, story_id: row.story_id, capture, responseRow }]
    }
    omitted.push(omission(responseRow, 'has invalid article metadata.', member))
    return []
  }) : []
  return { ...row, id: row.lead_id, title: row.title || row.label, members, capture, responseRow: path }
}
export function adapt(value: unknown, surface: 'pods' | 'news' | 'saved', capture?: FeedCapture): Page {
  const data = value as { items?: unknown[]; slides?: unknown[]; cursor?: string | null; session_id?: string; expires_at?: string; caught_up?: boolean } | null
  const raw = surface === 'news' ? data?.slides : data?.items
  if (!Array.isArray(raw)) throw new Error('CMS returned an invalid feed shape. See Requests for the original response.')
  if (data?.cursor != null && typeof data.cursor !== 'string') throw new Error('CMS returned an invalid feed cursor. See Requests for the original response.')
  const omissions: Omission[] = []
  const items = raw.flatMap<Item>((entry, index) => {
    const row = entry as Item & { featured?: unknown; related?: unknown[] }
    if (surface === 'news') {
      const path = `slides[${index}]`
      const featured = story(row?.featured, `${path}.featured`, omissions, capture)
      if (!featured) { omissions.push(omission(`${path}.featured`, 'has no valid story or lead ID.', row?.featured)); return [] }
      if (row.related != null && !Array.isArray(row.related)) omissions.push(omission(`${path}.related`, 'has invalid coverage.'))
      const related = (Array.isArray(row.related) ? row.related : []).flatMap((value, relatedIndex) => {
        const relatedPath = `${path}.related[${relatedIndex}]`
        const item = story(value, relatedPath, omissions, capture)
        if (!item) { omissions.push(omission(relatedPath, 'has no valid story or lead ID.', value)); return [] }
        return [item]
      })
      for (const item of related.slice(3)) {
        omissions.push(omission(item.responseRow!, 'exceeds the three related stories per slide.', item))
      }
      return [{ ...featured, related: related.slice(0, 3) }]
    }
    const path = `items[${index}]`
    if (!row?.id || !validID(row.id)) { omissions.push(omission(path, 'has no valid ID.')); return [] }
    if (!hasDisplayFields(row)) { omissions.push(omission(path, 'has invalid display metadata.', row)); return [] }
    if (surface === 'pods' && (!safeURL(row.playback_url || row.media_url) || typeof row.duration_sec !== 'number' ||
        !Number.isFinite(row.duration_sec) ||
        row.duration_sec < 270 || row.duration_sec > 2400)) {
      omissions.push(omission(path, 'has invalid duration or playback metadata.', row))
      return []
    }
    return [{ ...row, capture, responseRow: path }]
  })
  const rows = capture ? items.map(item => ({
    itemId: item.id, storyId: validID(item.story_id) ? item.story_id : undefined, title: item.title?.slice(0, 300), publisher: item.source_name?.slice(0, 300),
    related: item.related?.map(story => story.story_id!), captureId: capture.id, responseRow: item.responseRow!,
  })) : []
  return {
    items, cursor: data?.cursor, session_id: data?.session_id,
    expiresAt: typeof data?.expires_at === 'string' && Number.isFinite(Date.parse(data.expires_at)) ? data.expires_at : undefined,
    caughtUp: data?.caught_up === true, captures: capture ? [capture] : [], rows,
    omissions: omissions.map(entry => ({ ...entry, captureId: capture?.id })),
    omitted: omissions.map(entry => `${entry.row} ${entry.reason}`),
  }
}
export function playback(item: Item, fallback: boolean) {
  const url = safeURL(fallback ? item.fallback_playback_url : item.playback_url || item.media_url)
  const declared = fallback ? item.fallback_playback_type : item.playback_type
  const type = declared === 'hls' || declared === 'audio' || declared === 'mp4' ? declared :
    url?.includes('.m3u8') ? 'hls' : /\.(mp3|m4a|ogg|aac)(?:\?|$)/i.test(url ?? '') ? 'audio' : 'mp4'
  return { url, type, audio: type === 'audio' || (fallback ? item.fallback_has_video : item.has_video) === false } as const
}
export function consumptionThreshold(duration: number) {
  return duration >= 1 ? Math.max(1, Math.min(30, Math.floor(duration / 10))) : 0
}
export function consumption(played: number, furthest: number, duration: number) {
  const actual = Math.floor(played)
  const position = Math.floor(furthest)
  if (duration < 1 || actual < consumptionThreshold(duration)) return null
  const classification = position * 100 >= duration * 90 ? 'complete' : 'meaningful'
  return { consumption_contract_version: 1, actual_played_seconds: actual, furthest_position_seconds: position, consumption_classification: classification }
}
