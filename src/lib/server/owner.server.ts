import { createHmac } from 'node:crypto'

export class LabError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
export const services = ['cms', 'iam', 'enrichment', 'media', 'media-worker', 'aggregation-intake',
  'aggregation-news', 'aggregation-pods-control', 'aggregation-legacy-drain',
  'aggregation-media-executor', 'aggregation-media-maintenance', 'database-migration-coordinator',
  'console', 'wahb', 'feed-lab'] as const

export function runtime() {
  return { runtime_id: process.env.WAHB_RUNTIME_ID ?? '', environment: process.env.WAHB_ENVIRONMENT_ID ?? '', console_url: process.env.CONSOLE_BASE_URL ?? '' }
}

export function quickSignInCredentials() {
  if (process.env.WAHB_MANAGED_ENV !== '1' || !runtime().runtime_id) return
  const email = process.env.LOCAL_QUICK_SIGN_IN_EMAIL
  const password = process.env.LOCAL_QUICK_SIGN_IN_PASSWORD
  if (email && password) return { email, password }
}
export function json(data: unknown, status = 200, extra?: Headers) {
  const headers = new Headers(extra)
  headers.set('Cache-Control', 'no-store')
  return Response.json(data, { status, headers })
}

export function guard(request: Request, interruptLaunch: string | null = null) {
  const current = runtime().runtime_id
  if (!current) throw new LabError(503, 'Start Feed Lab with the managed launcher.')
  if ((request.headers.get('x-feed-lab-runtime') ?? interruptLaunch) !== current) throw new LabError(409, 'Launch changed. Reload Feed Lab.')
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) {
    throw new LabError(403, 'The request must come from Feed Lab.')
  }
}

export async function readBody(request: Request | Response, max = 256 * 1024) {
  if (Number(request.headers.get('content-length')) > max) throw new LabError(413, 'Evidence exceeds the size limit.')
  const reader = request.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new LabError(413, 'Evidence exceeds the size limit.')
    }
    text += decoder.decode(value, { stream: true })
  }
}

export async function readJSON(request: Request, max?: number): Promise<Record<string, unknown>> {
  const raw = await readBody(request, max)
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* invalid JSON */ }
  throw new LabError(400, 'Expected a JSON object.')
}

type Slot = 'operator' | 'consumer'
interface Principal { user_id: string; tenant_id: string; email: string; permissions?: string[]; is_admin?: boolean }
const cookieName = (slot: Slot, kind: string) => `feed_lab_${slot}_${kind}`

function getToken(request: Request, slot: Slot, kind = 'access') {
  const entry = request.headers.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(cookieName(slot, kind) + '='))
  const prefix = runtime().runtime_id + '.'
  const token = entry?.slice(cookieName(slot, kind).length + 1)
  return token?.startsWith(prefix) ? token.slice(prefix.length) : undefined
}

function tokenCookie(headers: Headers, slot: Slot, kind: string, token: string, age: number) {
  const value = token ? runtime().runtime_id + '.' + token : ''
  headers.append('Set-Cookie', `${cookieName(slot, kind)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}`)
}

export function upstream(owner: 'CMS' | 'IAM', path: string, init?: RequestInit) {
  const base = process.env[owner + '_BASE_URL']
  if (!base) throw new LabError(503, owner + ' is unavailable.')
  return fetch(new URL(path, base), {
    ...init, redirect: 'error', cache: 'no-store',
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  })
}

async function access(token: string): Promise<Principal> {
  const result = await upstream('IAM', '/api/v1/roles/me', { headers: { Authorization: 'Bearer ' + token } })
  if (!result.ok) {
    await result.body?.cancel()
    throw new LabError(result.status >= 500 ? 503 : 401, 'IAM could not verify this session. Refresh the session or sign in again.')
  }
  const principal = await result.json() as Principal
  if (!uuid.test(principal.user_id) || !principal.tenant_id) throw new LabError(502, 'IAM returned an invalid identity.')
  return principal
}

export function hasPermission(principal: Principal, permission: string) {
  const resource = permission.split(':')[0]
  return principal.is_admin || principal.permissions?.some(value => [permission, resource + ':*', '*:*'].includes(value))
}
function canInspect(principal: Principal) {
  return hasPermission(principal, 'feed:read') && hasPermission(principal, 'content:read')
}

export async function operator(request: Request) {
  const token = getToken(request, 'operator')
  if (!token) throw new LabError(401, 'Sign in as an operator with feed read access.')
  const principal = await access(token)
  if (!canInspect(principal)) throw new LabError(403, 'Operator needs feed and content read access.')
  return { token, principal }
}

export async function identities(request: Request) {
  const op = getToken(request, 'operator')
  const consumer = getToken(request, 'consumer')
  const resolve = async (token: string | undefined, slot: Slot) => {
    if (!token) return { state: getToken(request, slot, 'refresh') ? 'expired' : 'signed-out' }
    try {
      const principal = await access(token)
      if (slot === 'operator' && !canInspect(principal)) return { state: 'denied' }
      return { state: 'signed-in', id: principal.user_id, email: principal.email }
    } catch (error) {
      return { state: error instanceof LabError && error.status === 401 ? 'expired' : 'unavailable' }
    }
  }
  return { operator: await resolve(op, 'operator'), consumer: await resolve(consumer, 'consumer') }
}

export async function auth(request: Request) {
  const input = await readJSON(request, 8192)
  const slot = input.slot
  if (slot !== 'operator' && slot !== 'consumer') throw new LabError(400, 'Choose an identity.')
  let action = input.action
  const headers = new Headers()
  if (action === 'logout') {
    const refresh = getToken(request, slot, 'refresh')
    if (refresh) {
      const result = await upstream('IAM', '/api/v1/auth/logout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (getToken(request, slot) ?? '') },
        body: JSON.stringify({ refresh_token: refresh }),
      })
      await result.body?.cancel()
      if (!result.ok && ![400, 401, 404].includes(result.status)) throw new LabError(503, 'IAM could not revoke the session.')
    }
    for (const kind of ['access', 'refresh']) tokenCookie(headers, slot, kind, '', 0)
    return json({ ok: true }, 200, headers)
  }
  let payload: object
  if (action === 'quick-sign-in') {
    const credentials = quickSignInCredentials()
    if (!credentials) throw new LabError(404, 'Quick Sign In is unavailable for this launch.')
    action = 'login'
    payload = credentials
  } else if (action === 'login' && typeof input.email === 'string' && typeof input.password === 'string') {
    payload = { email: input.email, password: input.password }
  } else if (action === 'refresh') {
    const refresh = getToken(request, slot, 'refresh')
    if (!refresh) throw new LabError(401, 'Sign in again.')
    payload = { refresh_token: refresh }
  } else throw new LabError(400, 'Invalid sign-in request.')
  const result = await upstream('IAM', '/api/v1/auth/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  if (!result.ok) {
    await result.body?.cancel()
    throw new LabError(result.status >= 500 ? 503 : 401, 'IAM did not accept the credentials.')
  }
  const pair = await result.json()
  const safeToken = (value: unknown): value is string => typeof value === 'string' && /^[\w.~-]+$/.test(value)
  if (!safeToken(pair.access_token) || !safeToken(pair.refresh_token)) throw new LabError(502, 'IAM returned an invalid session.')
  const principal = await access(pair.access_token)
  if (slot === 'operator' && !canInspect(principal)) throw new LabError(403, 'Operator needs feed and content read access.')
  tokenCookie(headers, slot, 'access', pair.access_token, Number(pair.expires_in) || 3600)
  tokenCookie(headers, slot, 'refresh', pair.refresh_token, 30 * 86400)
  return json({ ok: true }, 200, headers)
}

const itemID = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
const feedPath = new RegExp(`^/feed/(?:news|pods(?:/sessions(?:/${itemID}(?:/freshness)?)?)?)$`)
const readPath = new RegExp(`^/(?:content/${itemID}|transcripts/${itemID}|interactions/(?:likes|bookmarks|history)|preferences(?:/profile)?|topics/picker)$`)
const prefMutePath = new RegExp(`^/preferences/topics/${itemID}/mute$`)
const diagnosticPath = new RegExp(`^/admin/(?:content(?:/${itemID})?|stories/${itemID}|content-stages/items/${itemID}/trace(?:-summary|-evidence)?|media-atomization/parents/${itemID}/journey/chapters|media/delivery/content/${itemID}/diagnostics|media/circulation/source-runs/${itemID}/trace|experience/evidence/events)$`)
const allowedQuery = new Set(['cursor', 'limit', 'duration', 'content_language', 'window', 'locale', 'sort', 'feed', 'content_id',
  'journey_id', 'release', 'event_type', 'start', 'end', 'client_platform', 'type', 'content_item_id'])

export async function ownerRequest(request: Request) {
  const url = new URL(request.url)
  const target = url.searchParams.get('path') ?? ''
  const test = request.headers.get('x-feed-lab-mode') === 'test'
  const signed = request.headers.get('x-feed-lab-consumer') === 'signed-in'
  const session = request.headers.get('x-feed-lab-session') ?? ''
  const method = request.method
  const isFeed = feedPath.test(target)
  const diagnostic = diagnosticPath.test(target)
  const frozenStart = target === '/feed/pods/sessions' && method === 'POST'
  const interaction = target === '/interactions' && ['POST', 'DELETE'].includes(method)
  const historyClear = target === '/interactions/history' && method === 'DELETE'
  const prefTopics = target === '/preferences/topics' && method === 'PUT'
  const prefMute = prefMutePath.test(target) && ['POST', 'DELETE'].includes(method)
  const consumerWrite = interaction || historyClear || prefTopics || prefMute
  const telemetry = target === '/experience/events' && method === 'POST'
  const readable = method === 'GET' && (isFeed || diagnostic || readPath.test(target))
  if (!readable && !frozenStart && !consumerWrite && !telemetry) throw new LabError(404, 'This operation is unavailable in Feed Lab.')
  if (!test && (consumerWrite || telemetry)) throw new LabError(403, 'Switch to Test as user to send activity.')
  if ((prefTopics || prefMute) && !signed) throw new LabError(401, 'Sign in as a consumer to edit preferences.')
  if (!diagnostic && !uuid.test(session)) throw new LabError(400, 'Invalid consumer session.')
  const op = await operator(request)
  if (request.headers.get('x-feed-lab-operator-id') !== op.principal.user_id) {
    throw new LabError(409, 'The operator identity changed. Refresh the preview.')
  }
  const publicTenant = process.env.FEED_LAB_PUBLIC_TENANT?.trim()
  if (!diagnostic && (!publicTenant || publicTenant !== op.principal.tenant_id)) {
    throw new LabError(403, 'The operator must belong to the configured public feed tenant.')
  }
  const headers = new Headers({ Accept: 'application/json' })
  let consumer: string | undefined
  if (!diagnostic && signed) {
    consumer = getToken(request, 'consumer')
    if (!consumer) throw new LabError(401, 'Refresh the signed-in consumer session.')
    const identity = await access(consumer)
    if (identity.tenant_id !== op.principal.tenant_id) throw new LabError(403, 'The consumer and operator must belong to the same tenant.')
    if (request.headers.get('x-feed-lab-consumer-id') !== identity.user_id) throw new LabError(409, 'The consumer identity changed. Reload the preview.')
    // The public feed middleware allows anonymous fallback for invalid JWTs.
    // Verify that CMS accepts this IAM token before serving a signed preview.
    if (test || !isFeed) {
      const proof = await upstream('CMS', '/admin/me', { headers: { Authorization: 'Bearer ' + consumer } })
      if (!proof.ok) {
        await proof.body?.cancel()
        throw new LabError(proof.status >= 500 ? 503 : 401, 'CMS could not verify the selected consumer.')
      }
      if ((await proof.json()).id !== identity.user_id) throw new LabError(401, 'CMS returned a different consumer identity.')
    }
  }
  let path = '/api/v1' + target
  if (diagnostic || (isFeed && !test)) {
    path = diagnostic ? target : target.replace('/feed/', '/admin/feed-inspection/')
    headers.set('Authorization', 'Bearer ' + op.token)
    if (consumer) headers.set('X-Wahb-Consumer-Authorization', 'Bearer ' + consumer)
  } else if (consumer) headers.set('Authorization', 'Bearer ' + consumer)
  const query = new URLSearchParams()
  for (const [key, value] of url.searchParams) if (allowedQuery.has(key)) query.set(key, value)
  if (target === '/admin/content') {
    const story = url.searchParams.get('story_id') ?? ''
    const page = url.searchParams.get('page') ?? '1'
    if (!uuid.test(story) || !/^[1-9][0-9]{0,3}$/.test(page)) throw new LabError(400, 'Choose a story and a valid page.')
    for (const key of [...query.keys()]) query.delete(key)
    query.set('story_id', story); query.set('page', page); query.set('type', 'NEWS'); query.set('limit', '25')
  }
  if (target.endsWith('/trace-evidence')) {
    const section = url.searchParams.get('section') ?? 'attempts'
    const before = url.searchParams.get('before')
    if (!['attempts', 'receipts', 'ranking'].includes(section) || (before !== null && !/^\d{1,19}$/.test(before))) {
      throw new LabError(400, 'Choose a valid trace section and cursor.')
    }
    for (const key of [...query.keys()]) query.delete(key)
    query.set('section', section)
    if (before) query.set('before', before)
  }
  if (target.endsWith('/journey/chapters')) {
    const cursor = query.get('cursor')
    if (cursor && !new RegExp(`^${itemID}:\\d{1,9}$`).test(cursor)) throw new LabError(400, 'Invalid chapter cursor.')
    for (const key of [...query.keys()]) if (key !== 'cursor') query.delete(key)
    query.set('limit', '25')
  }
  if (!consumer && !diagnostic) query.set('session_id', session)
  let body: string | undefined
  if (interaction && method === 'POST') {
    const input = await readJSON(request, 8192)
    if (typeof input.content_item_id !== 'string' || !uuid.test(input.content_item_id) ||
        !['like', 'bookmark', 'view', 'meaningful', 'complete'].includes(String(input.interaction_type))) {
      throw new LabError(400, 'Invalid consumer interaction.')
    }
    body = JSON.stringify({
      content_item_id: input.content_item_id, interaction_type: input.interaction_type,
      metadata: input.metadata, session_id: consumer ? undefined : session,
    })
    const key = request.headers.get('idempotency-key')
    if (key && uuid.test(key)) headers.set('Idempotency-Key', key)
  }
  if (prefTopics) {
    const input = await readJSON(request, 8192)
    if (!Array.isArray(input.topic_ids) || input.topic_ids.length > 50 ||
        !input.topic_ids.every((value): value is string => typeof value === 'string' && uuid.test(value))) {
      throw new LabError(400, 'Provide a valid list of topic IDs.')
    }
    body = JSON.stringify({ topic_ids: input.topic_ids })
  }
  if (telemetry) {
    const token = process.env.RUX_INGEST_TOKEN
    if (!token) return json({ disabled: true, reason: 'RUX collection credential is unavailable.' })
    const input = await readJSON(request, 32 * 1024)
    if (input.schema_version !== 2 || !Array.isArray(input.events) || input.events.length !== 1 ||
        input.events[0]?.session_id !== session || input.events[0]?.client?.platform !== 'web' ||
        input.events[0]?.release !== 'dev') throw new LabError(400, 'Invalid Feed Lab experience event.')
    headers.set('X-Rux-Ingest-Token', token)
    headers.set('X-Rux-Rate-Key', createHmac('sha256', token).update(op.principal.user_id).digest('hex'))
    body = JSON.stringify(input)
  }
  if (body) headers.set('Content-Type', 'application/json')
  const response = await upstream('CMS', path + (query.size ? '?' + query : ''), { method, headers, body, signal: request.signal })
  const outgoing = new Headers({ 'Cache-Control': 'no-store' })
  for (const key of ['content-type', 'x-request-id', 'retry-after']) {
    const value = response.headers.get(key)
    if (value) outgoing.set(key, value)
  }
  const raw = await readBody(response, 2 * 1024 * 1024)
  return new Response([204, 205, 304].includes(response.status) ? null : raw, { status: response.status, headers: outgoing })
}
