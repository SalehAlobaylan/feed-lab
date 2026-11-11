import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  testMatch: process.env.FEED_LAB_E2E_URL ? 'managed.spec.ts' : 'browser.spec.ts',
  timeout: 90_000,
  use: { headless: true, actionTimeout: 8000, viewport: { width: 1440, height: 1050 }, screenshot: 'only-on-failure' },
})
