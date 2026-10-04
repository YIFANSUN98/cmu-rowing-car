import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 90000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173/cmu-rowing-car/',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
    timezoneId: 'America/Los_Angeles',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      'VITE_TOMTOM_API_KEY=fictitious-test-key npm run build -- --outDir node_modules/.cache/rowing-browser-test && node tests/fixtures/webServer.ts',
    url: 'http://127.0.0.1:4173/cmu-rowing-car/',
    reuseExistingServer: false,
  },
});
