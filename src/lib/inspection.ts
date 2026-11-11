import type { Evidence, FeedCapture, InspectionSnapshot } from './evidence'
import { redactText } from './evidence'
import { safeURL } from './feed'

export type Fields = Record<string, unknown>
export function fields(value: unknown): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {}
}
export function rows(value: unknown): Fields[] {
  return Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : []
}
export function text(value: unknown) {
  return typeof value === 'string' ? value : undefined
}
export function valueText(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || typeof value === 'string'
    ? String(value) : undefined
}
export function time(value?: string) {
  const date = value ? new Date(value) : undefined
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable'
}
export function duration(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return
  return Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0')
}
export function asset(value: unknown) {
  const url = safeURL(text(value))
  return url ? redactText(url) : undefined
}

export function comparisonFields(value: Fields): Record<string, string> {
  const values = {
    Title: text(value.title) || text(value.label),
    Duration: duration(value.duration_sec),
    Artwork: asset(value.thumbnail_url),
    'Playback format': valueText(value.playback_type),
    'Primary source': asset(value.playback_url || value.media_url),
    'Fallback format': text(value.fallback_playback_type),
    'Fallback source': asset(value.fallback_playback_url),
    'Rendition version': valueText(value.rendition_set_version),
    'Rendition digest': text(value.rendition_digest),
    'Story ID': text(value.story_id),
    'Lead article': text(value.lead_id),
    'Coverage count': valueText(value.member_count) ?? (Array.isArray(value.members) ? String(value.members.length) : undefined),
    'Related stories': Array.isArray(value.related) ? rows(value.related).map(row => text(row.story_id) || text(row.id)).filter(Boolean).join(', ') : undefined,
  }
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => value === undefined ? [] : [[key, value.slice(0, 1500)]]))
}

export function responseRow(value: unknown, locator?: string) {
  if (!locator) return {}
  const item = /^items\[(\d+)\]$/.exec(locator)
  const at = (list: unknown, index: number) => Array.isArray(list) ? fields(list[index]) : undefined
  const body = fields(value)
  if (item) return at(body.items, Number(item[1])) ?? {}
  const path = /^slides\[(\d+)\]\.(featured|related\[(\d+)\])(?:\.members\[(\d+)\])?$/.exec(locator)
  if (!path) return {}
  const slide = at(body.slides, Number(path[1]))
  const story = path[2] === 'featured' ? fields(slide?.featured) : at(slide?.related, Number(path[3])) ?? {}
  if (path[4] !== undefined) return at(story.members, Number(path[4])) ?? {}
  return path[2] === 'featured' && Object.keys(story).length ? { ...story, related: slide?.related } : story
}

export function belongs(entry: Evidence, itemId?: string, storyId?: string, capture?: FeedCapture, story = false) {
  if (!itemId) return false
  if (entry.captureId !== capture?.id) return false
  if (entry.itemId) return entry.itemId === itemId || (story && Boolean(storyId) && entry.storyId === storyId)
  return Boolean(capture && entry.captureId === capture.id)
}

export function canCompare(left?: InspectionSnapshot, right?: InspectionSnapshot) {
  if (!left?.capture || !right?.capture || left.capture.surface !== right.capture.surface) return false
  if (left.storyView || right.storyView) {
    return Boolean(left.storyView && right.storyView && left.storyId && left.storyId === right.storyId)
  }
  return left.itemId === right.itemId
}
