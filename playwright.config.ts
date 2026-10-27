import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// Prebuilt Chromium in sandboxes/CI images whose revision may not match @playwright/test.
const LOCAL_CHROMIUM = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const PORT = Number(process.env.E2E_PORT ?? 3000)
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`

const { defaultBrowserType: _webkit, ...iPhone13 } = devices['iPhone 13']

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...iPhone13,
    browserName: 'chromium',
    baseURL,
    locale: 'zh-CN',
    timezoneId: 'Europe/London',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: existsSync(LOCAL_CHROMIUM) ? { executablePath: LOCAL_CHROMIUM } : {},
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'pnpm build && node .output/server/index.mjs',
    url: baseURL,
    env: { PORT: String(PORT), NITRO_PORT: String(PORT) },
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
