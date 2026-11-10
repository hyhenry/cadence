import { defineConfig } from '@playwright/test';

// E2E runs its own stack on separate ports and goes through the mock's
// ingress-like prefix, so relative asset/API paths are exercised every run.
const MOCK = 8224;
const SERVER = 8199;

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${MOCK}/api/hassio_ingress/e2e/`,
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    timezoneId: 'Europe/Berlin', // deliberately not the HA time zone
  },
  projects: [
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
    { name: 'tablet', use: { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false } },
  ],
  webServer: [
    {
      command: `node dev/mock-ha/src/main.ts`,
      env: { MOCK_PORT: String(MOCK), MOCK_INGRESS_TARGET: `http://127.0.0.1:${SERVER}` },
      url: `http://127.0.0.1:${MOCK}/mock/health`,
      reuseExistingServer: false,
    },
    {
      command: `rm -rf .data/e2e && npm --prefix cadence run build --silent && node --disable-warning=ExperimentalWarning cadence/server/dist/main.js`,
      env: { CADENCE_PORT: String(SERVER), MOCK_HA_URL: `http://127.0.0.1:${MOCK}`, CADENCE_DATA_DIR: '.data/e2e', CADENCE_ENV_FILE: '/nonexistent', LOG_LEVEL: 'warn' },
      url: `http://127.0.0.1:${SERVER}/api/info`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
