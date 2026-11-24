import { getLaunch } from './launch'
import { redact, type Evidence } from './evidence'

export interface Health { runtime_id: string; environment: string; console_url: string; services: string[]; quickSignIn: boolean }
export interface Identity { state: string; id?: string; email?: string }
export interface Identities { operator: Identity; consumer: Identity }
export interface Scope {
  health: Health
  mode: 'inspect' | 'test'
  signed: boolean
  consumerID?: string
  operatorID?: string
  session: string
}
export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export async function responseData(response: Response): Promise<unknown> {
  const raw = await response.text()
  try { return JSON.parse(raw) } catch { return raw || null }
}
export async function lab<T>(health: Health, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('x-feed-lab-runtime', health.runtime_id)
  if (init?.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers, cache: 'no-store' })
  const data = await responseData(response)
  if (!response.ok) throw new RequestError(response.status, message(data, response.status))
  return data as T
}
function message(data: unknown, status: number) {
  if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') return data.message
  return 'Request returned HTTP ' + status
}
export async function health(): Promise<Health> {
  const config = await getLaunch()
  if (!config.runtime_id) throw new Error('Start the selected Wahb environment with ./start.sh --env ID.')
  return config
}
export async function owner<T>(scope: Scope, path: string, options: {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; query?: Record<string, string>; body?: object
  signal?: AbortSignal; record: (entry: Evidence) => void
}): Promise<T> {
  const method = options.method ?? 'GET'
  const query = new URLSearchParams({ path, ...options.query })
  const at = new Date().toISOString()
  const id = crypto.randomUUID()
  const start = performance.now()
  const headers: Record<string, string> = {
    'x-feed-lab-runtime': scope.health.runtime_id, 'x-feed-lab-mode': scope.mode,
    'x-feed-lab-consumer': scope.signed ? 'signed-in' : 'anonymous', 'x-feed-lab-session': scope.session,
    'x-feed-lab-consumer-id': scope.consumerID ?? '', 'x-feed-lab-operator-id': scope.operatorID ?? '',
  }
  if (options.body) headers['Content-Type'] = 'application/json'
  if (method === 'POST' && path === '/interactions') headers['Idempotency-Key'] = crypto.randomUUID()
  let result: Response
  try {
    result = await fetch('/api/owner?' + query, {
      method, headers, cache: 'no-store', signal: options.signal,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  } catch (error) {
    options.record({ id, at, label: method + ' ' + path, detail: { request: redact(options.body), outcome: method === 'GET' ? 'No response' : 'No response. A sent write may have committed.' } })
    throw error
  }
  const data = await responseData(result)
  options.record({ id, at, requestId: result.headers.get('x-request-id') ?? undefined, label: method + ' ' + path, detail: redact({
    mode: scope.mode, query: options.query, request: options.body, request_id: result.headers.get('x-request-id'),
    retry_after: result.headers.get('retry-after'), idempotency_key: headers['Idempotency-Key'],
    status: result.status, elapsed_ms: Math.round(performance.now() - start), response: data,
  }) })
  if (!result.ok) throw new RequestError(result.status, message(data, result.status))
  return data as T
}
