import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5101', trace: 'retain-on-failure' },
  webServer: { command: 'npx tsx e2e/fixture.ts', url: 'http://127.0.0.1:5101/api/health',
    reuseExistingServer: false, timeout: 120_000 },
});
