import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // dist を配信する。scripts/ui-check.sh が先に npm run build を済ませている前提。
  webServer: {
    // --host を省略すると vite preview は Node の `localhost` 解決に従う。
    // この環境では `localhost` が ::1（IPv6）にしか解決されず、上の BASE_URL
    // （127.0.0.1固定）への疎通確認が永遠に失敗して 120 秒でタイムアウトした
    // （実測）。IPv4 を明示して揃える。
    command: `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
