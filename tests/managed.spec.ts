import { readFile } from 'node:fs/promises'
import { expect, test, type Page, type Response } from '@playwright/test'

const url = process.env.FEED_LAB_E2E_URL
const environment = process.env.FEED_LAB_E2E_DISPOSABLE_ENV
const operator = { email: process.env.FEED_LAB_E2E_EMAIL, password: process.env.FEED_LAB_E2E_PASSWORD }
const consumer = { email: process.env.FEED_LAB_E2E_CONSUMER_EMAIL, password: process.env.FEED_LAB_E2E_CONSUMER_PASSWORD }

test.beforeEach(async ({ request }) => {
  test.skip(!environment || !operator.email || !operator.password, 'Provide the named disposable profile and its existing IAM operator.')
  const registry = JSON.parse(await readFile(new URL('../../environments/registry.json', import.meta.url), 'utf8'))
  expect(registry.environments).toContainEqual(expect.objectContaining({ id: environment, preservation: 'disposable' }))
  const health = await request.get(new URL('/api/health', url).href)
  expect(health.ok()).toBe(true)
  expect(await health.json()).toMatchObject({ environment, runtime_id: expect.any(String) })
})

async function signIn(page: Page, credentials: typeof operator) {
  await page.getByLabel('Email').fill(credentials.email!)
  await page.getByLabel('Password').fill(credentials.password!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

function responseFor(page: Page, path: string): Promise<Response> {
  return page.waitForResponse(response => new URL(response.url()).searchParams.get('path') === path)
}

async function signInOperator(page: Page) {
  await page.goto(url!)
  const pods = responseFor(page, '/feed/pods/sessions')
  await signIn(page, operator)
  expect((await pods).ok()).toBe(true)
  await expect(page.getByLabel('Feed card', { exact: true }).locator('.consumer-card[data-item-id]')).toBeVisible()
}

async function runCheck(page: Page, scenario: string, expected = 'Scenario passed') {
  const selector = page.getByLabel('Scenario', { exact: true })
  if (!(await selector.isVisible())) await page.getByRole('button', { name: 'Run checks' }).click()
  await selector.selectOption(scenario)
  await page.getByRole('button', { name: 'Run scenario' }).click()
  await expect(page.locator('.notice')).toContainText(expected, { timeout: 75_000 })
}

test('managed Inspect serves anonymous and signed-in feeds and keeps browser activity local', async ({ page }) => {
  const writes: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).searchParams.get('path')
    if (request.method() !== 'GET' && (path === '/interactions' || path === '/experience/events')) writes.push(path)
  })
  await signInOperator(page)
  await runCheck(page, 'pods')
  await runCheck(page, 'news')
  await expect(page.getByRole('article', { name: 'Article reader' })).toBeVisible()
  if (consumer.email && consumer.password) {
    await page.getByLabel('Consumer', { exact: true }).selectOption('signed')
    const news = responseFor(page, '/feed/news')
    await signIn(page, consumer)
    expect((await news).ok()).toBe(true)
    const saved = responseFor(page, '/interactions/bookmarks')
    await page.getByRole('button', { name: 'Saved', exact: true }).click()
    expect((await saved).ok()).toBe(true)
  } else {
    test.info().annotations.push({ type: 'Coverage gap', description: 'Signed-in consumer credentials unavailable.' })
  }
  expect(writes).toEqual([])
})

test('managed Inspect and Test as user return equivalent feed rows', async ({ page }) => {
  await signInOperator(page)
  async function capture() {
    await page.getByText('Feed options', { exact: true }).click()
    const pods = responseFor(page, '/feed/pods')
    await page.getByRole('button', { name: 'Ordinary Pods' }).click()
    const podsResponse = await pods
    expect(podsResponse.ok()).toBe(true)
    const podBody = await podsResponse.json()
    const news = responseFor(page, '/feed/news')
    await page.getByRole('button', { name: 'News', exact: true }).click()
    const newsResponse = await news
    expect(newsResponse.ok()).toBe(true)
    const newsBody = await newsResponse.json()
    expect(podBody.items.length).toBeGreaterThan(0)
    expect(newsBody.slides.length).toBeGreaterThan(0)
    return {
      pods: podBody.items.map((item: { id: string; playback_type: string; duration_sec: number }) =>
        [item.id, item.playback_type, item.duration_sec]),
      news: newsBody.slides.map((slide: { featured: { story_id: string; lead_id: string }; related: { story_id: string }[] | null }) =>
        [slide.featured.story_id, slide.featured.lead_id, (slide.related ?? []).map(story => story.story_id)]),
      hasNextPods: !!podBody.cursor,
      hasNextNews: !!newsBody.cursor,
    }
  }
  const inspect = await capture()
  await page.getByText('Feed options', { exact: true }).click()
  await page.getByRole('button', { name: 'Test as user', exact: true }).click()
  expect(await capture()).toEqual(inspect)
})

test('managed Test as user verifies restoration and exact qualifying consumption evidence', async ({ page }) => {
  test.skip(!consumer.email || !consumer.password, 'Provide a separate existing consumer in the disposable profile.')
  test.setTimeout(150_000)
  await signInOperator(page)
  await page.getByLabel('Consumer', { exact: true }).selectOption('signed')
  await signIn(page, consumer)
  await expect(page.locator('.consumer-status')).toHaveText(consumer.email!)
  await page.getByRole('button', { name: 'Test as user', exact: true }).click()
  await page.getByRole('button', { name: 'Pods', exact: true }).click()
  await expect(page.getByLabel('Feed card', { exact: true }).locator('.consumer-card[data-item-id]')).toBeVisible()
  await runCheck(page, 'like')
  await expect(page.getByRole('list', { name: 'Check results' }).getByText('Restoration verified', { exact: true })).toBeVisible()
  await runCheck(page, 'bookmark')
  await expect(page.getByRole('list', { name: 'Check results' }).getByText('Restoration verified', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pods', exact: true }).click()
  await runCheck(page, 'consumption')
  await expect(page.getByRole('list', { name: 'Check results' }).getByText('Read back exact RUX event', { exact: true })).toBeVisible()
})
