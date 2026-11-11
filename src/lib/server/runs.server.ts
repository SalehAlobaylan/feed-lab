import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { markdown, redact, redactText, type CheckResult, type CheckSettings, type FeedCapture, type FeedComparison, type FeedSnapshot, type RunDraft, type SavedRun } from '../evidence'
import { json, LabError, readJSON, runtime, services, uuid } from './owner.server'

const maxBytes = 5 * 1024 * 1024
const verdicts = new Set(['running', 'passed', 'failed', 'blocked', 'unverified', 'interrupted', 'saved'])
let pending: Promise<unknown> = Promise.resolve()

function launchRevisions(): NonNullable<SavedRun['revisions']> {
  let values: Record<string, unknown> = {}
  try { values = JSON.parse(process.env.FEED_LAB_REVISIONS ?? '{}') ?? {} }
  catch { /* launch without revision metadata */ }
  const read = (key: string) => {
    const value = values[key]
    return typeof value === 'string' && /^[a-f0-9]{40,64}(?: \(working tree changes\))?$/.test(value) ? value : 'unavailable'
  }
  return { lab: read('lab'), cms: read('cms'), iam: read('iam') }
}

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.then(work)
  pending = next.catch(() => {})
  return next
}

async function directory(variable: string, create = false) {
  const value = process.env[variable]
  if (!value || !value.startsWith('/')) throw new LabError(503, 'Managed storage is unavailable.')
  const path = resolve(value)
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new LabError(403, 'Invalid managed storage directory.')
  return path
}

async function runDir(root: string, id: string) {
  if (!uuid.test(id)) throw new LabError(404, 'Report not found.')
  const path = join(root, id)
  const info = await lstat(path).catch(() => null)
  if (!info?.isDirectory() || (info.mode & 0o077) !== 0) throw new LabError(404, 'Report not found.')
  return path
}

async function load(root: string, id: string, owner: string) {
  const folder = await runDir(root, id)
  const file = await open(join(folder, 'evidence.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0) throw new LabError(422, 'Invalid saved evidence.')
    const run = JSON.parse(await file.readFile('utf8')) as SavedRun
    if (run.id !== id || run.owner !== owner || run.version !== 1) throw new LabError(404, 'Report not found.')
    return run
  } finally { await file.close() }
}

function visible(run: SavedRun): SavedRun {
  if (run.verdict === 'running' && (run.runtime !== runtime().runtime_id || Date.now() - Date.parse(run.updated) > 90_000)) {
    return { ...run, verdict: 'interrupted', evidence: [...run.evidence, {
      id: run.id, at: run.updated, label: 'Run interrupted', detail: 'The last acknowledged step may have reached CMS. Review restoration before retrying.',
    }] }
  }
  return run
}

async function write(folder: string, run: SavedRun) {
  const body = JSON.stringify(run)
  if (Buffer.byteLength(body) > maxBytes) throw new LabError(413, 'This run reached its 5 MiB evidence limit.')
  const temp = join(folder, randomUUID() + '.tmp')
  try {
    await writeFile(temp, body, { mode: 0o600, flag: 'wx', flush: true })
    await rename(temp, join(folder, 'evidence.json'))
  } finally { await rm(temp, { force: true }) }
}

async function draft(request: Request): Promise<RunDraft> {
  const body = await readJSON(request, maxBytes)
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 150 ||
      !['inspect', 'test'].includes(String(body.mode)) || typeof body.consumer !== 'string' ||
      body.consumer.length > 100 || !verdicts.has(String(body.verdict)) ||
      !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0 ||
      !Array.isArray(body.evidence) || body.evidence.length > 200 ||
      body.evidence.some(e => !e || typeof e.label !== 'string' || e.label.length > 240 ||
        typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)))) throw new LabError(400, 'Invalid run evidence.')
  return {
    title: redactText(body.title), mode: body.mode as RunDraft['mode'], consumer: redactText(body.consumer),
    scenario: typeof body.scenario === 'string' ? redactText(body.scenario.slice(0, 100)) : undefined,
    restore: typeof body.restore === 'boolean' ? body.restore : undefined,
    verdict: body.verdict as RunDraft['verdict'], sequence: Number(body.sequence),
    evidence: redact(body.evidence) as RunDraft['evidence'],
    note: typeof body.note === 'string' ? redactText(body.note.slice(0, 2000)) : undefined,
    inspection: readInspection(body.inspection),
    comparison: readComparison(body.comparison),
    settings: readSettings(body.settings),
    checks: readChecks(body.checks),
    trimmed: body.trimmed === true || undefined,
  }
}

const surfaces = ['pods', 'news', 'saved']
const modes = ['inspect', 'test']
const rowPath = /^(?:items\[\d+\]|slides\[\d+\]\.(?:featured|related\[\d+\])(?:\.members\[\d+\])?)$/
const identifier = (value: unknown) => typeof value === 'string' && uuid.test(value)
const bounded = (value: unknown, length: number) => typeof value === 'string' && value.length <= length
const optionalText = (value: unknown, length: number) => value === undefined || bounded(value, length)

function validCapture(value: FeedCapture) {
  return value && identifier(value.id) && bounded(value.at, 80) && Number.isFinite(Date.parse(value.at)) &&
    surfaces.includes(value.surface) && modes.includes(value.mode) && bounded(value.consumer, 100) &&
    (value.session === undefined || identifier(value.session)) && value.query && typeof value.query === 'object' &&
    !Array.isArray(value.query) && Object.keys(value.query).length <= 20 &&
    Object.values(value.query).every(entry => bounded(entry, 1500))
}

function validSnapshot(value: FeedSnapshot) {
  if (!value || !bounded(value.environment, 100) || !identifier(value.runtime) ||
      !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 200 || !value.pages.every(validCapture) ||
      !Array.isArray(value.rows) || value.rows.length > 1200 || typeof value.hasMore !== 'boolean' ||
      !Number.isSafeInteger(value.omitted) || value.omitted < 0 ||
      !Array.isArray(value.missingResponses) || value.missingResponses.length > 200 ||
      (value.rowsTrimmed !== undefined && typeof value.rowsTrimmed !== 'boolean')) return false
  const pages = new Set(value.pages.map(page => page.id))
  const scope = value.pages[0]
  return pages.size === value.pages.length &&
    value.pages.every(page => page.surface === scope.surface && page.mode === scope.mode && page.consumer === scope.consumer && page.session === scope.session) &&
    value.missingResponses.every(id => pages.has(id)) &&
    value.rows.every(row => row && pages.has(row.captureId) && identifier(row.itemId) &&
      (row.storyId === undefined || identifier(row.storyId)) && typeof row.responseRow === 'string' && rowPath.test(row.responseRow) &&
      optionalText(row.title, 300) && optionalText(row.publisher, 300) &&
      (row.related === undefined || Array.isArray(row.related) && row.related.length <= 3 && row.related.every(identifier)))
}

function readComparison(value: unknown): RunDraft['comparison'] {
  if (value == null) return
  const pair = value as FeedComparison
  if (!validSnapshot(pair.baseline) || !validSnapshot(pair.current) ||
      pair.baseline.runtime !== pair.current.runtime || pair.current.runtime !== runtime().runtime_id ||
      pair.baseline.environment !== pair.current.environment || pair.current.environment !== runtime().environment ||
      pair.baseline.pages[0].surface !== pair.current.pages[0].surface) throw new LabError(400, 'Invalid feed comparison.')
  return redact(pair) as FeedComparison
}

function readChecks(value: unknown): RunDraft['checks'] {
  if (value == null) return
  if (!Array.isArray(value) || value.length > 30 || !value.every(check => check && bounded(check.label, 240) &&
      ['passed', 'failed', 'blocked', 'unverified', 'interrupted'].includes(check.status) && optionalText(check.detail, 1000))) {
    throw new LabError(400, 'Invalid check results.')
  }
  return redact(value) as CheckResult[]
}

function readSettings(value: unknown): RunDraft['settings'] {
  if (value == null) return
  const settings = value as CheckSettings
  if (!surfaces.includes(settings.surface) || !['', '5', '10', '15', '20', '30', '40'].includes(settings.duration) ||
      !['', 'ar', 'en'].includes(settings.language) || !['today', 'week', 'month'].includes(settings.windowName) ||
      (settings.consumerId !== undefined && !identifier(settings.consumerId)) ||
      (settings.itemId !== undefined && !identifier(settings.itemId)) || !optionalText(settings.itemTitle, 300) ||
      (settings.ordinary !== undefined && typeof settings.ordinary !== 'boolean') ||
      (settings.savedFilter !== undefined && !['all', 'pods', 'news'].includes(settings.savedFilter)) ||
      (settings.savedSort !== undefined && !['saved_desc', 'saved_asc'].includes(settings.savedSort))) {
    throw new LabError(400, 'Invalid check settings.')
  }
  return redact(settings) as CheckSettings
}

function readInspection(value: unknown): RunDraft['inspection'] {
  if (value == null) return
  const item = value as NonNullable<RunDraft['inspection']>
  const fields = (values: unknown) => values && typeof values === 'object' && !Array.isArray(values) &&
    Object.keys(values).length <= 30 && Object.values(values).every(entry => typeof entry === 'string' && entry.length <= 1500)
  const capture = item.capture
  if (typeof item.itemId !== 'string' || !uuid.test(item.itemId) ||
      (item.storyId !== undefined && !uuid.test(item.storyId)) ||
      typeof item.title !== 'string' || item.title.length > 300 ||
      (item.responseRow !== undefined && (typeof item.responseRow !== 'string' ||
        !rowPath.test(item.responseRow))) ||
      !fields(item.captured) || !fields(item.preview) || !fields(item.current) ||
      !Array.isArray(item.findings) || item.findings.length > 3 ||
      item.findings.some(text => typeof text !== 'string' || text.length > 500) ||
      (capture && (!uuid.test(capture.id) || !Number.isFinite(Date.parse(capture.at)) ||
        !['pods', 'news', 'saved'].includes(capture.surface) || !['inspect', 'test'].includes(capture.mode) ||
        typeof capture.consumer !== 'string' || capture.consumer.length > 100 || !fields(capture.query)))) {
    throw new LabError(400, 'Invalid item snapshot.')
  }
  return redact(item) as RunDraft['inspection']
}

export async function reports(request: Request, owner: string) {
  const root = await directory('FEED_LAB_RUN_DIR', true)
  const query = new URL(request.url).searchParams
  const id = query.get('id')
  if (request.method === 'GET') {
    if (id) {
      const run = visible(await load(root, id, owner))
      if (!query.has('export')) return json(run)
      const attachments: Record<string, Uint8Array> = {}
      const links: string[] = []
      for (const [index, entry] of run.evidence.entries()) {
        if (entry.label !== 'Service log excerpt' || !entry.detail || typeof entry.detail !== 'object') continue
        const log = entry.detail as { text?: string }
        if (typeof log.text !== 'string') continue
        const name = `attachments/log-${index + 1}.txt`
        attachments[name] = strToU8(log.text)
        links.push(`- [Log excerpt ${index + 1}](${name})`)
      }
      const zip = zipSync({
        'evidence.json': strToU8(JSON.stringify(run, null, 2)),
        'report.md': strToU8(markdown(run) + (links.length ? '\n## Attachments\n\n' + links.join('\n') + '\n' : '')),
        ...attachments,
      })
      return new Response(new Uint8Array(zip), { headers: {
        'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="feed-lab-${id}.zip"`,
      } })
    }
    const runs = []
    for (const folder of (await readdir(root)).filter(name => uuid.test(name)).slice(0, 100)) {
      const run = await load(root, folder, owner).catch(() => null)
      if (run) {
        const { evidence, ...summary } = visible(run)
        runs.push({ ...summary, count: evidence.length })
      }
    }
    return json(runs.sort((a, b) => b.created.localeCompare(a.created)))
  }
  return serialize(async () => {
    if (request.method === 'POST' && id && query.get('interrupt') === '1') {
      const previous = await load(root, id, owner)
      if (previous.verdict !== 'running' || previous.runtime !== runtime().runtime_id) return json(visible(previous))
      const run: SavedRun = { ...previous, verdict: 'interrupted', sequence: previous.sequence + 1,
        updated: new Date().toISOString() }
      const entry = { id: randomUUID(), at: run.updated, label: 'Run interrupted',
        detail: 'The preview closed or became hidden. The last acknowledged action may have reached CMS. Review restoration before retrying.' }
      const recorded = { ...run, evidence: [...run.evidence, entry] }
      await write(await runDir(root, id), Buffer.byteLength(JSON.stringify(recorded)) <= maxBytes ? recorded : run)
      return json({ interrupted: true })
    }
    if (request.method === 'DELETE' && id) {
      const run = visible(await load(root, id, owner))
      if (run.verdict === 'running') throw new LabError(409, 'Stop this run before deleting it.')
      await rm(await runDir(root, id), { recursive: true })
      return json({ deleted: true })
    }
    if (request.method === 'PATCH' && id) {
      const next = await draft(request)
      const previous = await load(root, id, owner)
      if (visible(previous).verdict !== 'running' || next.sequence !== previous.sequence + 1) {
        throw new LabError(409, 'This run changed or ended. Reopen its saved evidence.')
      }
      const run = { ...previous, sequence: next.sequence, evidence: next.evidence, checks: next.checks ?? previous.checks,
        trimmed: next.trimmed ?? previous.trimmed, verdict: next.verdict, updated: new Date().toISOString() }
      await write(await runDir(root, id), run)
      return json(run)
    }
    if (request.method !== 'POST' || id) throw new LabError(405, 'Unsupported report operation.')
    const next = await draft(request)
    if (next.sequence !== 0 || !['running', 'saved'].includes(next.verdict)) throw new LabError(400, 'Invalid initial run state.')
    if ((await readdir(root)).filter(name => uuid.test(name)).length >= 100) throw new LabError(507, 'History is full. Export and delete a saved run.')
    const now = new Date().toISOString()
    const run: SavedRun = {
      ...next, id: randomUUID(), version: 1, owner, revisions: launchRevisions(),
      environment: runtime().environment, runtime: runtime().runtime_id, created: now, updated: now,
    }
    const folder = join(root, run.id)
    await mkdir(folder, { mode: 0o700 })
    try { await write(folder, run) } catch (error) {
      await rm(folder, { recursive: true, force: true })
      throw error
    }
    return json(run, 201)
  })
}

export async function logs(request: Request) {
  const query = new URL(request.url).searchParams
  const service = services.find(name => name === query.get('service'))
  const search = query.get('search') ?? ''
  if (!service || search.length > 150) throw new LabError(400, 'Choose a service and a short search term.')
  const root = await directory('FEED_LAB_LOG_DIR')
  if (!root.endsWith('/' + runtime().runtime_id)) throw new LabError(403, 'Log directory belongs to a different launch.')
  const file = await open(join(root, service + '.log'), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!file) throw new LabError(404, 'This launch has no log for that service.')
  try {
    const info = await file.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new LabError(403, 'Log must be a private regular file.')
    const size = Math.min(info.size, 1024 * 1024)
    const data = Buffer.alloc(size)
    const { bytesRead } = await file.read(data, 0, size, info.size - size)
    const lines = data.subarray(0, bytesRead).toString('utf8').split('\n')
    if (size < info.size) lines.shift()
    const text = lines.slice(-1000)
      .filter(line => !/password|authorization|cookie|token|secret|credential|api.?key|signature/i.test(line))
      .filter(line => !search || line.includes(search)).map(redactText).join('\n')
    return json({ service, search: redactText(search), text, at: new Date().toISOString(), launch: runtime().runtime_id,
      truncated: size < info.size || lines.length > 1000 })
  } finally { await file.close() }
}
