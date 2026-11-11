import { auth, guard, hasPermission, identities, json, LabError, operator, ownerRequest, runtime, services } from './owner.server'
import { logs, reports } from './runs.server'

export async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  try {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.url).hostname)) {
      return json({ message: 'Open Feed Lab on loopback.' }, 403)
    }
    if (request.method === 'GET' && path === '/api/health') {
      const info = runtime()
      return json({ ...info, services }, info.runtime_id ? 200 : 503)
    }
    const interrupt = request.method === 'POST' && path === '/api/runs' && url.searchParams.get('interrupt') === '1'
    guard(request, interrupt ? url.searchParams.get('launch') : null)
    if (path === '/api/auth' && request.method === 'POST') return await auth(request)
    if (path === '/api/identity' && request.method === 'GET') return json(await identities(request))
    if (path === '/api/owner') return await ownerRequest(request)
    if (path === '/api/logs' && request.method === 'GET') {
      const { principal } = await operator(request)
      if (!hasPermission(principal, 'aggregation:read')) throw new LabError(403, 'Service logs require aggregation read access.')
      return await logs(request)
    }
    if (path === '/api/runs') {
      const { principal } = await operator(request)
      return await reports(request, principal.tenant_id + '/' + principal.user_id)
    }
    return json({ message: 'Feed Lab route not found.' }, 404)
  } catch (error) {
    if (error instanceof LabError) return json({ message: error.message }, error.status)
    return json({ message: 'The owner service or local evidence storage is unavailable.' }, 503)
  }
}
