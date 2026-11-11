import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { canCompare, responseRow } from '../src/lib/inspection'

const launch = '11111111-1111-4111-8111-111111111111'
const actor = '22222222-2222-4222-8222-222222222222'
const consumer = '99999999-9999-4999-8999-999999999999'
const first = '33333333-3333-4333-8333-333333333333'
const second = '44444444-4444-4444-8444-444444444444'
const frozen = '55555555-5555-4555-8555-555555555555'
const transcript = '66666666-6666-4666-8666-666666666666'
const relatedStory = '77777777-7777-4777-8777-777777777777'
const parent = '88888888-8888-4888-8888-888888888888'
const missing = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const legacy = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const nestedArticle = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const calls: { path: string; auth?: string; consumer?: string; session: string | null }[] = []
const states = new Set<string>()
const events: unknown[] = []
const interactions: unknown[] = []
let operatorExpired = false
let changedCapture = false
let delayChapter = false
let videoFallback = false
let emptyNewsToday = false
let singlePagePods = false
let hideFirstPod = false
let failPods = false
let expirePodsPage = false
let savedLibrary = false
const removedSaved = new Set<string>()
let fixture: Server
let app: ChildProcess
let folder: string
let url: string
let output = ''
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Invalid fixture address')
  return address.port
}

test.beforeAll(async () => {
  folder = await mkdtemp(join(await realpath(tmpdir()), 'feed-lab-browser-'))
  const logs = join(folder, launch)
  await mkdir(logs, { mode: 0o700 })
  await writeFile(join(logs, 'cms.log'), 'Observed request: example-id\nsecret=private-value\n', { mode: 0o600 })
  // An audio-only transport exercises the same media element as live Pods.
  const wav = Buffer.alloc(44 + 8000 * 270 * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
  const video = await readFile(new URL('./fixtures/preview.webm', import.meta.url))
  fixture = createServer(async (req, res) => {
    const target = new URL(req.url!, 'http://127.0.0.1')
    const path = target.pathname
    const cookieIdentity = req.headers.authorization === 'Bearer consumer-access' ? consumer : actor
    const result = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data))
    }
    if (path === '/audio.wav') {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'audio/wav', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
      })
      res.end(req.method === 'HEAD' ? undefined : wav.subarray(start, end + 1))
      return
    }
    if (path === '/preview.webm') {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': video.length }); res.end(video); return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    if (path === '/api/v1/auth/login') {
      const passwords = {
        'operator@example.com': 'fixture-password',
        'consumer@example.com': 'fixture-password',
        'quick-operator@example.test': 'fixture-quick-password',
      }
      const expected = passwords[body.email as keyof typeof passwords]
      if (!expected || body.password !== expected) return result({}, 401)
      const slot = body.email === 'consumer@example.com' ? 'consumer' : 'operator'
      return result({ access_token: slot + '-access', refresh_token: slot + '-refresh', expires_in: 3600 })
    }
    if (path === '/api/v1/auth/refresh' && body.refresh_token === 'operator-refresh') {
      operatorExpired = false
      return result({ access_token: 'operator-access', refresh_token: 'operator-refresh', expires_in: 3600 })
    }
    if (path === '/api/v1/roles/me') {
      if (!req.headers.authorization) return result({}, 401)
      if (operatorExpired && cookieIdentity === actor) return result({}, 401)
      return result({ user_id: cookieIdentity, tenant_id: 'fixture', email: cookieIdentity === actor ? 'operator@example.com' : 'consumer@example.com', is_admin: cookieIdentity === actor })
    }
    if (path === '/admin/me') return result({ id: cookieIdentity })
    calls.push({ path, auth: req.headers.authorization, consumer: String(req.headers['x-wahb-consumer-authorization'] ?? ''), session: target.searchParams.get('session_id') })
    const pod = (id: string) => ({ id, type: 'PODCAST', title: id === first ? changedCapture ? 'First episode revised' : 'First episode' : 'Next episode', duration_sec: 270,
      playback_url: `http://127.0.0.1:${port}/${id === first ? 'audio.wav' : 'missing-audio'}`,
      playback_type: videoFallback && id === second ? 'mp4' : 'audio', has_video: videoFallback && id === second,
      transcript_id: id === first ? transcript : undefined, parent_id: id === first ? parent : undefined,
      chapter_index: id === first ? 0 : undefined, chapter_start_ms: 120000, chapter_end_ms: 390000,
      source_name: 'Fixture publisher', rendition_digest: 'captured rendition',
      fallback_playback_url: id === second ? `http://127.0.0.1:${port}/audio.wav` : undefined,
      fallback_playback_type: id === second ? 'audio' : undefined, fallback_has_video: false })
    if (path.endsWith('/freshness')) return result({ has_new_content: true })
    if (path.endsWith('/pods') || path.includes('/pods/sessions')) {
      if (failPods) return result({ message: 'CMS temporarily unavailable' }, 503)
      if (expirePodsPage && target.searchParams.has('cursor')) return result({ message: 'Pods session has expired' }, 410)
      if (target.searchParams.get('duration') === '40') return result({
        session_id: frozen, items: [{ ...pod(first), id: relatedStory, title: 'Visual episode', duration_sec: 2400,
          playback_url: 'http://127.0.0.1:' + port + '/preview.webm', playback_type: 'mp4', has_video: true, transcript_id: undefined }], cursor: null,
      })
      return result({ session_id: path.includes('/pods/sessions') ? frozen : undefined,
        expires_at: '2099-01-01T00:00:00Z',
        items: [pod(hideFirstPod || target.searchParams.has('cursor') ? second : first)],
        cursor: singlePagePods || target.searchParams.has('cursor') ? null : 'next' })
    }
    if (path.endsWith('/news')) {
      if (emptyNewsToday && target.searchParams.get('window') === 'today') return result({ slides: [], cursor: null })
      const id = target.searchParams.has('cursor') ? second : first
      return result({ slides: [{ slide_id: id, featured: { lead_id: id, story_id: id, title: 'News story', source_name: 'City Desk',
        excerpt: 'Public transport update.', published_at: '2026-11-11T00:00:00Z',
        members: [{ id, title: 'News story', source_name: 'City Desk' }, { id: relatedStory, title: 'Other coverage', source_name: 'Local paper' }] },
      related: [{ lead_id: relatedStory, story_id: relatedStory, title: 'Related headline', source_name: 'Local paper',
        members: [{ id: nestedArticle, title: 'Nested coverage captured', source_name: 'Local paper' }] }] }],
        cursor: target.searchParams.has('cursor') ? null : 'next' })
    }
    if (path.startsWith('/api/v1/content/')) return result({ data: { title: path.endsWith(relatedStory) ? 'Related reader' : 'News reader', body_text: 'CMS article text.' } })
    if (path === '/api/v1/transcripts/' + transcript) return result({ data: {
      content_item_id: first, full_text: 'This is a timed passage.', segments: [{ start: 0, end: 270, text: 'This is a timed passage.' }],
    } })
    if (path === '/api/v1/experience/events') {
      events.push(...body.events)
      return result({ accepted: 1, duplicate: 0, rejected: 0 })
    }
    if (path === '/admin/experience/evidence/events') return result({ data: events })
    if (path === '/api/v1/interactions') {
      const kind = body.interaction_type ?? target.searchParams.get('type')
      if (req.method === 'DELETE') {
        states.delete(kind)
        if (savedLibrary && kind === 'bookmark') removedSaved.add(target.searchParams.get('content_item_id') ?? '')
      }
      else { states.add(kind); interactions.push(body) }
      return result({ data: { id: second, interaction_type: kind, content_item_id: body.content_item_id } })
    }
    if (path === '/api/v1/interactions/likes') return result({ items: states.has('like') ? [pod(first)] : [], cursor: null })
    if (path === '/api/v1/interactions/bookmarks') {
      if (!savedLibrary) return result({ items: states.has('bookmark') ? [pod(first)] : [], cursor: null })
      const news = { id: relatedStory, type: 'NEWS', title: 'Saved headline', bookmarked_at: '2026-11-10T12:00:00Z' }
      const episode = { ...pod(first), bookmarked_at: '2026-11-11T12:00:00Z' }
      const filter = target.searchParams.get('feed')
      const visible = (items: { id: string }[]) => items.filter(item => !removedSaved.has(item.id))
      if (filter === 'pods') return result({ items: visible([episode]), cursor: null })
      if (filter === 'news' || target.searchParams.has('cursor')) return result({ items: visible([news]), cursor: null })
      return result({ items: visible([episode]), cursor: 'saved-next' })
    }
    if (path.endsWith('/trace-summary')) {
      const id = path.split('/').at(-2)!
      if (id === first && delayChapter) await pause(1400)
      if (id === missing) return result({ message: 'Item unavailable' }, 404)
      if (id === second) return result({ message: 'Permission required' }, 403)
      return result({ data: {
        version: 'delivery-summary/v1', id, title: id === parent ? 'Original parent episode' : 'CMS chapter',
        item_type: id === parent ? 'PODS_PARENT' : 'PODS_CHAPTER', as_of: new Date().toISOString(),
        source: { status: 'Source recorded', owner: 'Fixture publisher' },
        processing: { status: 'Verified', detail: 'chapters_published', owner: 'CMS' },
        eligibility: { status: id === parent ? 'Excluded by policy' : 'Eligible for Pods', detail: id === parent ? 'This parent publishes through its chapters.' : 'Ready.' },
        publication: { status: 'In active Pods generation' }, delivery: { status: 'No observation recorded' },
      } })
    }
    if (path.endsWith('/trace-evidence')) {
      if (target.searchParams.get('section') === 'ranking') return result({ data: {
        as_of: new Date().toISOString(), raw_rank: 5, final_rank: 4,
      } })
      const historical = target.searchParams.get('before') === '2'
      return result({ data: {
        items: [{ id: historical ? second : first, stage: 'pods_media_artifacts', state: 'verified', owner: 'CMS', processing_generation: historical ? 2 : 3 }],
        next: historical ? '' : '2',
      } })
    }
    if (path.endsWith('/journey/chapters')) return result({ data: {
      items: [{ id: first, child_id: first, title: 'First episode', start_ms: 120000, end_ms: 390000, state: 'published' }],
    } })
    if (path === '/admin/content') return result({ data: [{ id: relatedStory, title: 'CMS membership article' }], total_pages: 1 })
    if (path.startsWith('/admin/content/')) {
      const id = path.split('/').at(-1)!
      return id === missing ? result({ message: 'Content not found' }, 404) : result({
        id, type: id === parent || id === first || id === second ? 'PODCAST' : 'NEWS',
        title: id === parent ? 'Original parent episode' : 'Current CMS title', duration_sec: 272,
      })
    }
    if (path.endsWith('/diagnostics')) return result({ content_item: { rendition_digest: 'current rendition', rendition_set_version: 3 } })
    if (path.startsWith('/admin/')) return result({ data: { diagnosis: 'fixture evidence' } })
    return result({ message: 'Unknown fixture request' }, 404)
  })
  const port = await listen(fixture)
  const reservation = createServer()
  const appPort = await listen(reservation)
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  url = 'http://127.0.0.1:' + appPort
  app = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(appPort),
      WAHB_RUNTIME_ID: launch, WAHB_ENVIRONMENT_ID: 'fixture', WAHB_MANAGED_ENV: '1',
      LOCAL_QUICK_SIGN_IN_EMAIL: 'quick-operator@example.test', LOCAL_QUICK_SIGN_IN_PASSWORD: 'fixture-quick-password',
      CMS_BASE_URL: 'http://127.0.0.1:' + port, IAM_BASE_URL: 'http://127.0.0.1:' + port,
      FEED_LAB_PUBLIC_TENANT: 'fixture', RUX_INGEST_TOKEN: 'fixture-ingest-token',
      FEED_LAB_RUN_DIR: join(folder, 'runs'), FEED_LAB_LOG_DIR: logs },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout?.on('data', value => { output += value })
  app.stderr?.on('data', value => { output += value })
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await fetch(url + '/api/health').catch(() => null))?.ok) return
    if (app.exitCode !== null) break
    await pause(100)
  }
  throw new Error('Feed Lab did not start: ' + output)
})

test.afterAll(async () => {
  if (app && app.exitCode === null) { const stopped = once(app, 'exit'); app.kill(); await stopped }
  if (fixture) await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (folder) await rm(folder, { recursive: true, force: true })
})

test('inspect, run scenarios, verify evidence and export through the built app', async ({ page }, testInfo) => {
  await page.goto(url)
  await page.getByLabel('Email').fill('operator@example.com')
  await page.getByLabel('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'First episode' })).toBeVisible()
  const inspection = () => calls.findLast(call => call.path === '/admin/feed-inspection/pods/sessions')
  expect(inspection()).toMatchObject({ auth: 'Bearer operator-access', consumer: '' })
  expect(inspection()?.session).toBeTruthy()
  const initialSession = inspection()?.session
  expect(events).toHaveLength(0)
  await page.getByRole('button', { name: 'Test as user' }).click()
  await page.getByRole('button', { name: 'Inspect', exact: true }).click()
  await page.getByRole('button', { name: 'Pods', exact: true }).click()
  await expect.poll(() => inspection()?.session).not.toBe(initialSession)
  await page.getByText('IAM identities', { exact: true }).click()
  await page.getByLabel('Account', { exact: true }).selectOption('consumer')
  await page.getByLabel('Email').fill('consumer@example.com')
  await page.getByLabel('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Consumer', { exact: true })).toHaveValue('signed')
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'First episode' })).toBeVisible()
  expect(inspection()).toMatchObject({
    path: '/admin/feed-inspection/pods/sessions',
    auth: 'Bearer operator-access', consumer: 'Bearer consumer-access', session: null,
  })
  const cookies = (await page.context().cookies()).map(({ name, httpOnly, sameSite }) => ({ name, httpOnly, sameSite }))
  for (const slot of ['operator', 'consumer']) {
    for (const token of ['access', 'refresh']) {
      expect(cookies).toContainEqual({ name: 'feed_lab_' + slot + '_' + token, httpOnly: true, sameSite: 'Strict' })
    }
  }
  const stale = await page.request.get(url + '/api/identity', { headers: { 'x-feed-lab-runtime': first } })
  expect(stale.status()).toBe(409)
  const unsafeLog = await page.request.get(url + '/api/logs?service=..%2Fcms', { headers: { 'x-feed-lab-runtime': launch } })
  expect(unsafeLog.status()).toBe(400)
  const outside = join(folder, 'outside.log')
  await writeFile(outside, 'Outside the launch log directory', { mode: 0o600 })
  await symlink(outside, join(folder, launch, 'iam.log'))
  const linkedLog = await page.request.get(url + '/api/logs?service=iam', { headers: { 'x-feed-lab-runtime': launch } })
  expect(linkedLog.status()).toBe(404)
  const foreign = await page.request.post(url + '/api/runs', {
    headers: { 'x-feed-lab-runtime': launch, origin: 'https://foreign.example' }, data: {},
  })
  expect(foreign.status()).toBe(403)
  const foreignInterrupt = await page.request.post(url + '/api/runs?id=' + first + '&interrupt=1&launch=' + launch, {
    headers: { origin: 'https://foreign.example' },
  })
  expect(foreignInterrupt.status()).toBe(403)
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByRole('button', { name: 'Observe view' }).click()
  expect(calls.some(call => call.path === '/api/v1/interactions')).toBe(false)
  await expect(page.getByRole('button', { name: 'Save investigation' })).toBeEnabled()
  await page.getByRole('button', { name: 'Test as user' }).click()
  await expect(page.getByRole('button', { name: 'Save investigation' })).toBeDisabled()
  await page.getByRole('button', { name: 'Inspect', exact: true }).click()
  await page.getByRole('button', { name: 'Evidence', exact: true }).click()
  await page.getByText('Logs', { exact: true }).click()
  await page.getByRole('button', { name: 'Load excerpt' }).click()
  await expect(page.getByText('Observed request: example-id', { exact: false }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Save investigation' }).click()
  await page.getByRole('button', { name: 'Save capture' }).click()
  await expect(page.locator('.notice')).toContainText('Investigation saved.')
  await page.getByRole('link', { name: 'Open run' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export report' }).click()
  const file = await (await download).path()
  const archive = unzipSync(new Uint8Array(await readFile(file)))
  expect(strFromU8(archive['report.md'])).toContain('Service log excerpt')
  expect(strFromU8(archive['evidence.json'])).not.toContain('private-value')
  const run = JSON.parse(strFromU8(archive['evidence.json']))
  expect(await readdir(join(folder, 'runs', run.id))).toEqual(['evidence.json'])
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Delete report' }).click()
  await expect(page.getByText('No saved runs yet.', { exact: false })).toBeVisible()
  expect(await readdir(join(folder, 'runs'))).not.toContain(run.id)

  await page.getByRole('link', { name: 'Workspace', exact: true }).click()
  await page.getByRole('button', { name: 'Test as user' }).click()
  await page.getByRole('button', { name: 'Pods', exact: true }).click()
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'First episode' })).toBeVisible()
  expect(calls.findLast(call => call.path === '/api/v1/feed/pods/sessions')).toMatchObject({
    auth: undefined,
    consumer: '',
    session: expect.any(String),
  })
  await page.getByLabel('Consumer', { exact: true }).selectOption('signed')
  await page.getByRole('button', { name: 'Run checks', exact: true }).click()
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await expect(page.locator('.notice')).toContainText('Scenario passed', { timeout: 20000 })
  expect(calls.filter(call => call.path === '/api/v1/feed/pods')).toHaveLength(2)
  expect(calls.findLast(call => call.path === '/api/v1/feed/pods/sessions')).toMatchObject({
    auth: 'Bearer consumer-access',
    consumer: '',
    session: null,
  })
  await page.getByLabel('Scenario', { exact: true }).selectOption('news')
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await expect(page.locator('.notice')).toContainText('Scenario passed', { timeout: 20000 })
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'News reader' })).toBeVisible()
  await page.getByRole('button', { name: 'Pods', exact: true }).click()
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'First episode' })).toBeVisible()
  const audio = page.locator('audio')
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThan(1)
  await audio.evaluate(element => {
    element.dataset.loadEvents = '0'
    element.addEventListener('loadstart', () => { element.dataset.loadEvents = String(Number(element.dataset.loadEvents) + 1) })
  })
  await page.getByLabel('Scenario', { exact: true }).selectOption('like')
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await expect(page.locator('.notice')).toContainText('Scenario passed', { timeout: 20000 })
  expect(states.has('like')).toBe(false)
  await expect(audio).toHaveAttribute('data-load-events', '0')
  states.add('bookmark')
  await page.getByLabel('Scenario', { exact: true }).selectOption('bookmark')
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await expect(page.locator('.notice')).toContainText('Scenario passed', { timeout: 20000 })
  expect(states.has('bookmark')).toBe(true)
  await page.getByRole('button', { name: 'Pods', exact: true }).click()
  await expect(page.locator('audio')).toBeAttached()
  await page.locator('audio').evaluate((audio: HTMLAudioElement) => { audio.playbackRate = 4 })
  await page.getByLabel('Scenario', { exact: true }).selectOption('playback')
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await expect(page.locator('.notice')).toContainText('Scenario passed', { timeout: 20000 })
  await page.getByLabel('Scenario', { exact: true }).selectOption('consumption')
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await expect(page.locator('.notice')).toContainText('Scenario passed', { timeout: 40000 })
  expect(states.has('meaningful')).toBe(true)
  expect(interactions).toContainEqual(expect.objectContaining({ interaction_type: 'view', metadata: { feed_session_id: frozen } }))
  expect(events).toContainEqual(expect.objectContaining({ phase: 'feed', surface: 'pods', feed_session_id: frozen }))
  expect(events).toContainEqual(expect.objectContaining({ phase: 'startup', surface: 'pods', feed_session_id: frozen }))

  await page.getByLabel('Scenario', { exact: true }).selectOption('consumption')
  // Use a different item so duplicate-view protection does not block this run.
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'Next episode' })).toBeVisible()
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await page.getByRole('button', { name: 'Stop scenario' }).click()
  await expect(page.locator('.notice')).toContainText('Scenario interrupted')
  await page.getByRole('link', { name: 'Open run' }).click()
  await expect(page.getByText(/^interrupted · fixture · test/)).toBeVisible()
  await page.getByRole('link', { name: 'Workspace', exact: true }).click()
  await page.getByRole('button', { name: 'Test as user' }).click()
  await page.getByRole('button', { name: 'Pods', exact: true }).click()
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'Next episode' })).toBeVisible()
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByRole('button', { name: 'Measure playback' }).click()
  await expect(page.locator('audio')).toHaveAttribute('data-playback-fallback', 'true')
  await expect(page.locator('.notice')).toContainText('Playback advanced on the fallback source.')
  await page.getByText('Playback check', { exact: true }).click()
  await page.getByRole('button', { name: 'Verify exact event' }).click()
  await expect(page.getByText('Independent readback', { exact: true })).toBeVisible()
  await page.locator('audio').evaluate((element: HTMLAudioElement) => element.pause())
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('workspace-desktop.png') })

  await page.setViewportSize({ width: 360, height: 780 })
  await page.getByLabel('Feed card', { exact: true }).press('ArrowUp')
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'First episode' })).toBeVisible()
  await page.getByRole('button', { name: 'Details', exact: true }).click()
  await page.getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Current CMS journey' })).toBeVisible()
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360)
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true })

  operatorExpired = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('IAM could not verify')
  await expect(page.getByRole('button', { name: 'Refresh session' })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh session' }).click()
  await page.getByRole('button', { name: 'News', exact: true }).click()
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'News story' })).toBeVisible()

  await page.setViewportSize({ width: 1440, height: 1050 })
  await page.getByRole('button', { name: 'Pods', exact: true }).click()
  await expect(page.getByLabel('Feed card', { exact: true }).getByRole('heading', { name: 'First episode' })).toBeVisible()
  await page.getByRole('button', { name: 'Run checks', exact: true }).click()
  await page.getByLabel('Scenario', { exact: true }).selectOption('consumption')
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await expect(page.locator('.notice')).toContainText('Observe the media clock')
  const closingRun = (await page.getByRole('link', { name: 'Open run' }).getAttribute('href'))!
  await page.goto(url + closingRun)
  await expect.poll(async () => {
    const response = await page.request.get(url + '/api/runs?id=' + closingRun.split('/').at(-1), {
      headers: { 'x-feed-lab-runtime': launch },
    })
    return (await response.json()).verdict
  }).toBe('interrupted')
  await page.reload()
  await expect(page.getByText(/^interrupted · fixture · test/)).toBeVisible()
})

test('consumer controls preserve the media and navigate related news at phone width', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1120, height: 1220 })
  await page.goto(url)
  await page.getByLabel('Email').fill('operator@example.com')
  await page.getByLabel('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const phone = page.getByLabel('Feed card', { exact: true })
  const audio = phone.locator('audio')
  await expect(phone.getByText('This is a timed passage.')).toBeVisible()
  const transcriptReads = calls.filter(call => call.path === '/api/v1/transcripts/' + transcript).length
  await audio.evaluate(element => {
    element.dataset.retained = 'yes'
    element.addEventListener('loadstart', () => { element.dataset.retained = 'reloaded' })
  })
  await phone.getByRole('button', { name: 'Listen', exact: true }).click()
  await expect(phone.getByText('This is a timed passage.')).toBeHidden()
  await phone.getByRole('button', { name: 'Transcript', exact: true }).click()
  await expect(phone.getByText('This is a timed passage.')).toBeVisible()
  await expect(audio).toHaveAttribute('data-retained', 'yes')
  expect(calls.filter(call => call.path === '/api/v1/transcripts/' + transcript)).toHaveLength(transcriptReads)
  await phone.getByRole('button', { name: /فتح النص الكامل/ }).click()
  await expect(phone.getByRole('region', { name: 'النص الكامل' })).toBeVisible()
  await phone.getByRole('button', { name: 'Close details' }).click()
  await expect(phone.getByRole('slider', { name: 'Playback position' })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('pods-audio-workbench.png') })

  await phone.getByRole('button', { name: '40 minutes' }).click()
  const video = phone.locator('video')
  await expect(phone.getByRole('heading', { name: 'Visual episode' })).toBeVisible()
  await expect(video).toHaveCSS('object-fit', 'contain')
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(96)
  await phone.getByRole('button', { name: 'Fill', exact: true }).click()
  await expect(video).toHaveCSS('object-fit', 'cover')
  await phone.getByRole('button', { name: 'Fit', exact: true }).click()
  await expect(video).toHaveCSS('object-fit', 'contain')
  await page.screenshot({ path: testInfo.outputPath('pods-video-fit.png') })

  await phone.getByRole('button', { name: 'الأخبار', exact: true }).click()
  await expect(phone.getByRole('heading', { name: 'News story' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('news-workbench.png') })
  await page.setViewportSize({ width: 360, height: 780 })
  await phone.getByRole('button', { name: /Related headline/ }).click()
  await expect(phone.getByRole('heading', { name: 'Related reader' })).toBeVisible()
  await expect(phone.getByText('CMS article text.')).toBeVisible()
  await page.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Evidence', exact: true })).toContainText('Related reader')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('news-reader-mobile.png'), fullPage: true })
  await phone.getByRole('button', { name: 'Back to preview' }).click()
  await expect(phone.getByRole('heading', { name: 'News story' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360)
  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  const fits = await phone.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return [...element.querySelectorAll('.consumer-header button')].every(button => {
      const rect = button.getBoundingClientRect()
      return rect.left >= bounds.left && rect.right <= bounds.right
    })
  })
  expect(fits).toBe(true)
})

test('inspect exact captures, navigate lineage and compare saved investigations', async ({ page }, testInfo) => {
  const writes = interactions.length
  const emissions = events.length
  const beforeLookup = calls.length
  delayChapter = true
  await page.goto(url)
  await page.getByLabel('Email').fill('operator@example.com')
  await page.getByLabel('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const inspector = page.getByRole('region', { name: 'Evidence', exact: true })
  const phone = page.getByLabel('Feed card', { exact: true })
  await expect(inspector.getByRole('heading', { name: 'First episode' })).toBeVisible()
  await expect.poll(() => calls.slice(beforeLookup).some(call => call.path.includes(first) && call.path.endsWith('/trace-summary'))).toBe(true)
  await inspector.getByRole('button', { name: 'Inspect parent episode' }).click()
  await expect(inspector.getByRole('heading', { name: 'Original parent episode' })).toBeVisible()
  await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
  await expect(inspector.getByText('This parent publishes through its chapters.')).toBeVisible()
  await inspector.getByRole('button', { name: 'Content', exact: true }).click()
  await inspector.getByText('Chapter list', { exact: true }).click()
  await expect(inspector.getByRole('button', { name: 'First episode' })).toBeVisible()
  await inspector.getByRole('button', { name: 'Return to preview item' }).click()
  delayChapter = false

  await inspector.getByRole('button', { name: 'Content', exact: true }).click()
  await inspector.getByText('Transcript', { exact: true }).click()
  const player = phone.locator('audio')
  await player.evaluate(element => {
    element.dataset.inspectorPlayer = 'retained'
    element.currentTime = 30
    element.pause()
  })
  await inspector.getByRole('button', { name: '0:00', exact: true }).click()
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeLessThan(1)
  await expect(player).toHaveAttribute('data-inspector-player', 'retained')

  await inspector.getByRole('button', { name: 'Journey', exact: true }).click()
  await expect(inspector.getByText('In active Pods generation', { exact: true })).toBeVisible()
  await inspector.getByText('Attempts by generation', { exact: true }).click()
  await expect(inspector.getByText('Processing generation 3', { exact: true })).toBeVisible()
  await inspector.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(inspector.getByText('Processing generation 2', { exact: true })).toBeVisible()
  await inspector.getByText('Inspect current Pods ranking', { exact: true }).click()
  await expect(inspector.getByText(/Anonymous assembly.*Final rank 4/)).toBeVisible()

  await inspector.getByRole('button', { name: 'Evidence', exact: true }).click()
  await inspector.getByText('Compare item fields', { exact: true }).click()
  const fields = inspector.getByRole('table')
  await expect(fields.getByRole('row', { name: /Title/ }).getByText('Current CMS title', { exact: true })).toBeVisible()
  await expect(fields.getByRole('row', { name: /Rendition digest/ })).toContainText('captured rendition')
  await inspector.getByRole('button', { name: 'Refresh CMS fields' }).click()
  await expect(fields.getByRole('row', { name: /Rendition digest/ })).toContainText('current rendition')
  await expect(fields.getByRole('row', { name: /Rendition digest/ })).toContainText('captured rendition')
  await inspector.getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(inspector.getByText(/CMS has a different rendition/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('item-inspector-desktop.png') })

  const save = async (note: string) => {
    await inspector.getByRole('button', { name: 'Save investigation' }).click()
    await inspector.getByLabel('Investigation note').fill(note)
    await inspector.getByRole('button', { name: 'Save capture' }).click()
    const link = page.getByRole('link', { name: 'Open run' })
    await expect(link).toBeVisible()
    return (await link.getAttribute('href'))!
  }
  const older = await save('Baseline chapter evidence')
  changedCapture = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(inspector.getByRole('heading', { name: 'First episode revised' })).toBeVisible()
  const newer = await save('Revised chapter evidence')
  const saved = JSON.parse(await readFile(join(folder, 'runs', newer.split('/').at(-1)!, 'evidence.json'), 'utf8'))
  expect(saved.evidence.length).toBeGreaterThan(0)
  expect(saved.evidence.every(entry => entry.captureId === saved.inspection.capture.id &&
    (!entry.itemId || entry.itemId === saved.inspection.itemId))).toBe(true)
  expect(saved.revisions).toEqual({ lab: 'unavailable', cms: 'unavailable', iam: 'unavailable' })
  changedCapture = false
  await page.goto(url + newer)
  await expect(page.getByText('Revised chapter evidence', { exact: true })).toBeVisible()
  await expect(page.getByText('Response row items[0]', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Compare captures' }).click()
  await page.getByLabel('Other capture').selectOption(older.split('/').at(-1)!)
  const compare = page.getByRole('region', { name: 'Compare saved captures' })
  await expect(compare.getByRole('row', { name: /Title/ })).toContainText('Changed')
  await expect(compare.getByRole('row', { name: /Title/ })).toContainText('First episode revised')

  const directory = join(folder, 'runs', legacy)
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, 'evidence.json'), JSON.stringify({
    id: legacy, owner: 'fixture/' + actor, version: 1, environment: 'fixture', runtime: launch,
    title: 'Legacy investigation', mode: 'inspect', consumer: 'Anonymous', verdict: 'saved',
    sequence: 0, created: new Date().toISOString(), updated: new Date().toISOString(),
    evidence: [{ at: new Date().toISOString(), label: 'Legacy evidence entry', detail: { example: true } }],
  }), { mode: 0o600 })
  await page.goto(url + '/runs/' + legacy)
  await expect(page.getByText('Older entries have unavailable item attribution.')).toBeVisible()
  await expect(page.getByText('Legacy evidence entry', { exact: true })).toBeVisible()

  await page.goto(url)
  await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
  videoFallback = true
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(inspector.getByRole('heading', { name: 'Next episode' })).toBeVisible()
  await expect(inspector.getByText('Your operator account cannot read this evidence.')).toBeVisible()
  await inspector.getByRole('button', { name: 'Activity', exact: true }).click()
  await inspector.getByRole('button', { name: 'Measure playback' }).click()
  await expect(page.locator('.notice')).toContainText('Playback advanced on the fallback source.')
  await expect(phone.locator('audio')).toHaveAttribute('data-playback-fallback', 'true')
  videoFallback = false
  await inspector.getByRole('button', { name: 'Open by ID' }).click()
  await inspector.getByLabel('Content ID', { exact: true }).fill(missing)
  await inspector.getByRole('button', { name: 'Open item' }).click()
  await expect(inspector.getByText('CMS could not find this record.').first()).toBeVisible()
  await expect(phone.getByRole('heading', { name: 'Next episode' })).toBeVisible()
  await inspector.getByRole('button', { name: 'Return to preview item' }).click()

  await page.getByRole('button', { name: 'News', exact: true }).click()
  await inspector.getByRole('button', { name: 'Content', exact: true }).click()
  await expect(inspector.getByRole('heading', { name: 'Captured coverage' })).toBeVisible()
  await inspector.getByText('Current CMS story membership', { exact: true }).click()
  await expect(inspector.getByRole('button', { name: 'CMS membership article' })).toBeVisible()
  await inspector.getByRole('button', { name: 'Overview', exact: true }).click()
  for (const width of [800, 320]) {
    await page.setViewportSize({ width, height: 800 })
    if (width === 320) await page.getByRole('button', { name: 'Details', exact: true }).press('Enter')
    await expect(inspector.getByRole('heading', { name: 'News story' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  }
  await page.screenshot({ path: testInfo.outputPath('item-inspector-mobile.png'), fullPage: true })
  expect(interactions).toHaveLength(writes)
  expect(events).toHaveLength(emissions)
})

test('quick sign-in opens Pods and an empty News window offers older coverage', async ({ page }) => {
  const writes = interactions.length
  const emissions = events.length
  emptyNewsToday = true
  try {
    await page.goto(url)
    const login = page.waitForRequest(request => new URL(request.url()).pathname === '/api/auth')
    await page.getByRole('button', { name: 'Quick Sign In' }).click()
    expect((await login).postDataJSON()).toEqual({ slot: 'operator', action: 'quick-sign-in' })
    const phone = page.getByLabel('Feed card', { exact: true })
    await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
    await page.reload()
    await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()

    await page.getByRole('button', { name: 'News', exact: true }).click()
    await expect(phone.getByText('لا توجد أخبار في هذه الفترة.')).toBeVisible()
    const showMonth = page.waitForResponse(response => {
      const query = new URL(response.url()).searchParams
      return query.get('path') === '/feed/news' && query.get('window') === 'month' && response.ok()
    })
    await phone.getByRole('button', { name: 'عرض أخبار هذا الشهر' }).click()
    await showMonth
    await expect(phone.getByRole('heading', { name: 'News story' })).toBeVisible()
    expect(interactions).toHaveLength(writes)
    expect(events).toHaveLength(emissions)
  } finally {
    emptyNewsToday = false
  }
})

test('switching consumer opens sign-in and reloads the current feed with the selected identity', async ({ page }) => {
  const writes = interactions.length
  const emissions = events.length
  const newsRequest = () => calls.findLast(call => call.path === '/admin/feed-inspection/news')
  await page.goto(url)
  await page.getByRole('button', { name: 'Quick Sign In' }).click()
  const phone = page.getByLabel('Feed card', { exact: true })
  await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
  await page.getByRole('button', { name: 'News', exact: true }).click()
  await expect(phone.getByRole('heading', { name: 'News story' })).toBeVisible()
  const before = newsRequest()

  const selector = page.getByLabel('Consumer', { exact: true })
  await selector.selectOption('signed')
  await expect(page.getByLabel('Account', { exact: true })).toHaveValue('consumer')
  await expect(page.getByRole('button', { name: 'Quick Sign In' })).toBeFocused()
  await expect(page.getByText('Consumer sign-in required', { exact: true })).toBeVisible()
  await expect(phone.getByRole('heading', { name: 'News story' })).toHaveCount(0)
  expect(newsRequest()).toBe(before)

  await page.getByLabel('Email').fill('consumer@example.com')
  await page.getByLabel('Password').fill('invalid')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('IAM did not accept the credentials.')
  expect(newsRequest()).toBe(before)

  await page.getByLabel('Password').fill('fixture-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(phone.getByRole('heading', { name: 'News story' })).toBeVisible()
  await expect(page.locator('.consumer-status')).toHaveText('consumer@example.com')
  expect(newsRequest()).toMatchObject({ auth: 'Bearer operator-access', consumer: 'Bearer consumer-access', session: null })

  await selector.selectOption('anonymous')
  await expect.poll(() => newsRequest()?.consumer).toBe('')
  await expect(phone.getByRole('heading', { name: 'News story' })).toBeVisible()
  expect(newsRequest()?.session).not.toBe(before?.session)

  await selector.selectOption('signed')
  await expect.poll(() => newsRequest()?.consumer).toBe('Bearer consumer-access')
  await expect(phone.getByRole('heading', { name: 'News story' })).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveCount(0)
  expect(interactions).toHaveLength(writes)
  expect(events).toHaveLength(emissions)
})

test('consumer quick sign-in uses its own session and sign-out reloads Anonymous', async ({ page }, testInfo) => {
  const writes = interactions.length
  const emissions = events.length
  const request = () => calls.findLast(call => call.path === '/admin/feed-inspection/pods/sessions')
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto(url)
  await page.getByRole('button', { name: 'Quick Sign In' }).click()
  const phone = page.getByLabel('Feed card', { exact: true })
  await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
  expect(request()?.consumer).toBe('')

  const cookies = () => page.context().cookies()
  const operator = (await cookies()).filter(cookie => cookie.name.startsWith('feed_lab_operator_'))
  expect(operator).toHaveLength(2)
  const selector = page.getByLabel('Consumer', { exact: true })
  await selector.selectOption('signed')
  await expect(page.getByRole('heading', { name: 'Sign in as consumer' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Quick Sign In' })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  await page.screenshot({ path: testInfo.outputPath('consumer-quick-sign-in.png') })

  const auth = page.waitForRequest(entry => new URL(entry.url()).pathname === '/api/auth')
  await page.getByRole('button', { name: 'Quick Sign In' }).press('Enter')
  expect((await auth).postDataJSON()).toEqual({ slot: 'consumer', action: 'quick-sign-in' })
  await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
  await expect(page.locator('.consumer-status')).toHaveText('operator@example.com')
  expect(request()).toMatchObject({ auth: 'Bearer operator-access', consumer: 'Bearer operator-access', session: null })
  expect((await cookies()).filter(cookie => cookie.name.startsWith('feed_lab_operator_'))).toEqual(operator)
  expect((await cookies()).filter(cookie => cookie.name.startsWith('feed_lab_consumer_'))).toHaveLength(2)
  await expect(page.getByRole('heading', { name: 'Consumer session' })).toBeHidden()

  await page.getByText('IAM identities', { exact: true }).click()
  await page.getByRole('button', { name: 'Sign out consumer' }).click()
  await expect(selector).toHaveValue('anonymous')
  await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
  expect(request()?.consumer).toBe('')
  expect((await cookies()).filter(cookie => cookie.name.startsWith('feed_lab_operator_'))).toEqual(operator)
  expect((await cookies()).filter(cookie => cookie.name.startsWith('feed_lab_consumer_'))).toHaveLength(0)
  expect(interactions).toHaveLength(writes)
  expect(events).toHaveLength(emissions)
})

test('resolves nested News rows and matches story and article scopes independently', () => {
  const feed = { slides: [{ featured: { title: 'Featured', members: [{ title: 'Featured member' }] },
    related: [{ title: 'Related', members: [{ title: 'Related member' }] }] }] }
  expect(responseRow(feed, 'slides[0].featured').title).toBe('Featured')
  expect(responseRow(feed, 'slides[0].featured.members[0]').title).toBe('Featured member')
  expect(responseRow(feed, 'slides[0].related[0]').title).toBe('Related')
  expect(responseRow(feed, 'slides[0].related[0].members[0]').title).toBe('Related member')
  expect(responseRow(feed, 'slides[0].related[0].members[9]')).toEqual({})
  expect(responseRow(feed, 'slides[0].unknown')).toEqual({})
  const article = { itemId: first, storyId: relatedStory, capture: {
    id: launch, at: new Date().toISOString(), surface: 'news' as const, mode: 'inspect' as const, consumer: 'Anonymous', query: {},
  }, title: 'Article', captured: {}, preview: {}, current: {}, findings: [] }
  expect(canCompare(article, { ...article, itemId: second })).toBe(false)
  expect(canCompare(article, { ...article, storyView: true })).toBe(false)
  expect(canCompare({ ...article, storyView: true }, { ...article, storyView: true, itemId: second })).toBe(true)
})

test('pins across consumer changes and saves and exports captured page differences', async ({ page }, testInfo) => {
  const writes = interactions.length, emissions = events.length
  const phone = page.getByLabel('Feed card', { exact: true })
  try {
    await page.goto(url)
    await page.getByRole('button', { name: 'Quick Sign In' }).click()
    await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
    await page.getByRole('button', { name: 'Pin baseline' }).click()
    await page.getByRole('button', { name: 'Test as user', exact: true }).click()
    await expect(page.getByText(/Pinned pods/)).toBeVisible()
    await page.getByRole('button', { name: 'Inspect', exact: true }).click()
    await page.getByLabel('Consumer', { exact: true }).selectOption('signed')
    changedCapture = true
    await page.getByRole('button', { name: 'Quick Sign In' }).click()
    await expect(phone.getByRole('heading', { name: 'First episode revised' })).toBeVisible()
    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(phone.getByRole('heading', { name: 'Next episode' })).toBeVisible()
    const comparison = page.getByRole('region', { name: 'Feed comparison' })
    await expect(comparison.getByText('Title changed', { exact: true })).toBeVisible()
    await expect(comparison.getByText('Only observed in current capture', { exact: true })).toBeVisible()
    await expect(comparison.getByText(/different page ranges/)).toBeVisible()
    await page.getByText('Loaded items · 2', { exact: true }).click()
    await page.getByLabel('Search loaded items').fill('revised')
    await page.getByRole('button', { name: /#1 First episode revised/ }).click()
    await expect(phone.getByRole('heading', { name: 'First episode revised' })).toBeVisible()
    for (const width of [800, 320]) {
      await page.setViewportSize({ width, height: 780 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    }
    await page.screenshot({ path: testInfo.outputPath('feed-comparison-mobile.png'), fullPage: true })
    await page.getByLabel('Comparison note').fill('Signed-in and anonymous test')
    await page.getByRole('button', { name: 'Save comparison' }).click()
    await page.getByRole('link', { name: 'Open run' }).click()
    await expect(page.getByText('Signed-in and anonymous test', { exact: true })).toBeVisible()
    await expect(comparison.getByText('Title changed', { exact: true })).toBeVisible()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export report' }).click()
    const archive = unzipSync(new Uint8Array(await readFile(await (await download).path())))
    const run = JSON.parse(strFromU8(archive['evidence.json']))
    expect(run.comparison.baseline.pages).toHaveLength(1)
    expect(run.comparison.current.pages).toHaveLength(2)
    expect(run.evidence.filter(entry => /\/feed\/pods/.test(entry.label)).length).toBeGreaterThanOrEqual(3)
    expect(strFromU8(archive['report.md'])).toContain('Title changed')
    expect(interactions).toHaveLength(writes)
    expect(events).toHaveLength(emissions)
  } finally {
    changedCapture = false
  }
})

test('runs Inspect checks, blocks a detached target, and reruns only the saved item', async ({ page }) => {
  const writes = interactions.length, emissions = events.length
  const inspector = page.getByRole('region', { name: 'Evidence', exact: true })
  const phone = page.getByLabel('Feed card', { exact: true })
  singlePagePods = true
  try {
    await page.goto(url)
    await page.getByRole('button', { name: 'Quick Sign In' }).click()
    await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
    await inspector.getByRole('button', { name: 'Run checks' }).click()
    await inspector.getByRole('button', { name: 'Run scenario' }).click()
    await expect(page.locator('.notice')).toContainText('Partial coverage')
    const results = inspector.getByRole('list', { name: 'Check results' })
    await expect(results.getByText('Feed loaded', { exact: true })).toBeVisible()
    await expect(results.getByText('Pagination unavailable', { exact: true })).toBeVisible()

    await inspector.getByRole('button', { name: 'Open by ID' }).click()
    await inspector.getByLabel('Content ID', { exact: true }).fill(parent)
    await inspector.getByRole('button', { name: 'Open item' }).click()
    await inspector.getByRole('button', { name: 'Run checks' }).click()
    await inspector.getByLabel('Scenario').selectOption('playback')
    await expect(inspector.getByRole('button', { name: 'Run scenario' })).toBeDisabled()
    await expect(inspector.getByText('Return to preview item to run an item check.')).toBeVisible()
    await inspector.getByRole('button', { name: 'Return to preview item' }).click()
    await expect(inspector.getByRole('button', { name: 'Run scenario' })).toBeEnabled()
    await inspector.getByRole('button', { name: 'Run scenario' }).click()
    await expect(page.locator('.notice')).toContainText('Scenario passed', { timeout: 20000 })
    await page.getByRole('link', { name: 'Open run' }).click()
    await page.getByRole('link', { name: 'Run again with the same settings' }).click()
    const before = calls.length
    await page.getByRole('button', { name: 'Use saved settings' }).click()
    await expect(inspector.locator('.check-target-id')).toHaveText(first)
    expect(calls.slice(before).filter(call => call.path.includes('/feed-inspection/'))).toHaveLength(0)
    await inspector.getByRole('button', { name: 'Run scenario' }).click()
    await expect(page.locator('.notice')).toContainText('Scenario passed', { timeout: 20000 })
    await page.getByRole('link', { name: 'Open run' }).click()
    await page.getByRole('link', { name: 'Run again with the same settings' }).click()
    await page.getByRole('button', { name: 'Use saved settings' }).click()
    hideFirstPod = true
    await inspector.getByRole('button', { name: 'Run scenario' }).click()
    await expect(page.locator('.notice')).toContainText('Scenario blocked')
    await expect(page.getByRole('alert')).toContainText('The saved target was unavailable')
    await expect(phone.getByRole('heading', { name: 'Next episode' })).toHaveCount(0)
    expect(interactions).toHaveLength(writes)
    expect(events).toHaveLength(emissions)
  } finally {
    hideFirstPod = false
    singlePagePods = false
  }
})

test('plays and reads from Saved and preserves a Pods card when recovery fails', async ({ page }) => {
  const phone = page.getByLabel('Feed card', { exact: true })
  savedLibrary = true
  try {
    await page.goto(url)
    await page.getByRole('button', { name: 'Quick Sign In' }).click()
    await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
    await page.getByRole('button', { name: 'Check freshness' }).click()
    await expect(page.getByText('New content available', { exact: false })).toBeVisible()
    const player = phone.locator('audio')
    await expect.poll(() => player.evaluate(element => element.seekable.length > 0 && element.seekable.end(0) >= 45)).toBe(true)
    await player.evaluate(element => {
      element.pause()
      element.currentTime = 45
      element.dataset.retained = 'yes'
    })
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(45, 0)
    failPods = true
    await page.getByRole('button', { name: 'Load new content' }).click()
    await expect(page.getByRole('alert')).toContainText('Pods request failed')
    await expect(phone.getByRole('heading', { name: 'First episode' })).toBeVisible()
    await expect(player).toHaveAttribute('data-retained', 'yes')
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(45, 0)
    failPods = false
    await page.getByRole('button', { name: 'Retry feed' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expirePodsPage = true
    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(page.getByRole('button', { name: 'Load new content' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled()
    expirePodsPage = false
    await page.getByRole('button', { name: 'Load new content' }).click()
    await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled()

    await page.getByRole('button', { name: 'Saved', exact: true }).click()
    await phone.getByRole('button', { name: 'First episode', exact: false }).first().click()
    await expect(phone.locator('audio')).toHaveAttribute('src', /audio\.wav$/)
    await phone.getByRole('button', { name: 'Back to Saved' }).click()
    await phone.getByRole('button', { name: 'تحميل المزيد' }).click()
    await expect(phone.getByText('Saved headline', { exact: true })).toBeVisible()
    await phone.getByRole('group', { name: 'Saved filter' }).getByRole('button', { name: 'الأخبار' }).click()
    await expect(phone.getByText('First episode', { exact: true })).toHaveCount(0)
    await phone.getByRole('button', { name: /Saved headline/ }).first().click()
    await expect(phone.getByRole('article', { name: 'Article reader' })).toBeVisible()
    await phone.getByRole('button', { name: 'Back to preview' }).click()
    await expect(phone.getByRole('group', { name: 'Saved filter' }).getByRole('button', { name: 'الأخبار' })).toHaveAttribute('aria-pressed', 'true')
    const sorted = page.waitForRequest(request => new URL(request.url()).searchParams.get('sort') === 'saved_asc')
    await phone.getByLabel('Saved order').selectOption('saved_asc')
    await sorted
    await page.getByRole('button', { name: 'Test as user', exact: true }).click()
    await page.getByRole('button', { name: 'Saved', exact: true }).click()
    await phone.getByRole('button', { name: 'Remove bookmark: Saved headline' }).click()
    await expect(phone.getByText('Saved headline', { exact: true })).toHaveCount(0)
    expect(removedSaved.has(relatedStory)).toBe(true)
  } finally {
    savedLibrary = false
    removedSaved.clear()
    failPods = false
    expirePodsPage = false
  }
})
