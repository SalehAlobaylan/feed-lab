import type { Verdict } from '../lib/evidence'

export const scenarios = [
  { id: 'pods', label: 'Pods load and paginate', surface: 'pods', item: false, writes: false },
  { id: 'news', label: 'News load, paginate and read', surface: 'news', item: false, writes: false },
  { id: 'audit', label: 'Feed contract audit (multi-page)', surface: 'pods', item: false, writes: false },
  { id: 'playback', label: 'Playback startup', surface: 'pods', item: true, writes: false },
  { id: 'like', label: 'Like and unlike', item: true, writes: true },
  { id: 'bookmark', label: 'Bookmark and Saved readback', item: true, writes: true },
  { id: 'consumption', label: 'View and qualifying consumption', surface: 'pods', item: true, writes: true },
] as const
export type Scenario = typeof scenarios[number]['id']
export class Check extends Error {
  constructor(public verdict: Extract<Verdict, 'blocked' | 'failed' | 'unverified'>, message: string) { super(message) }
}
export function requireCheck(condition: unknown, verdict: Check['verdict'], message: string): asserts condition {
  if (!condition) throw new Check(verdict, message)
}
