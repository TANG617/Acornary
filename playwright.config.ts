import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: process.env.ACORNARY_E2E_ORIGIN ?? 'http://127.0.0.1:3210',
    ignoreHTTPSErrors: !!process.env.ACORNARY_E2E_CLOUD,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: 'output/playwright/results',
  reporter: 'list',
});
