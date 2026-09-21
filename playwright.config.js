import { defineConfig, devices } from '@playwright/test';

const PORT = 8420;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  // These tests hit the real Wikidata/World Bank/Wikipedia APIs (by design — the whole
  // point is exercising live data, not mocks). A country lookup occasionally times out
  // or hits transient rate-limiting under concurrent test load; one retry absorbs that
  // without masking a real, deterministic bug (which would keep failing anyway).
  retries: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 15_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
