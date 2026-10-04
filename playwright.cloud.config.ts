import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/cloud-browser',
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: 'http://127.0.0.1:4176/',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
    screenshot: 'only-on-failure',
    timezoneId: 'America/Los_Angeles',
  },
  webServer: {
    command:
      'VITE_TOMTOM_API_KEY=fictitious-test-key vite build --base / --outDir node_modules/.cache/rowing-cloud-browser-test && tsx tests/fixtures/cloudServer.ts',
    url: 'http://127.0.0.1:4176/',
    reuseExistingServer: false,
  },
});
