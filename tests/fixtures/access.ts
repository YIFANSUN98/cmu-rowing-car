import { test as base, expect } from '@playwright/test';
export { expect };
export const ADMIN_KEY = 'browser-test-admin-key-only';
export const TEAM_KEY = 'browser-test-team-key-only';
export const TEST_ORIGIN = 'http://127.0.0.1:4173';
export const TEST_API = `${TEST_ORIGIN}/cmu-rowing-car/api/`;
// Use the real server and HttpOnly session cookie in every existing planner test.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route('https://api.waterdata.usgs.gov/**', (route) =>
      route.fulfill({ status: 503, body: '' }),
    );
    const response = await context.request.post(TEST_API + 'login', {
      headers: { Origin: TEST_ORIGIN },
      data: { key: ADMIN_KEY },
    });
    expect(response.status()).toBe(200);
    await use(context);
  },
});
