import { chromium, defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const configuredBrowser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const systemBrowser = !existsSync(chromium.executablePath()) && existsSync('/usr/bin/chromium')
  ? '/usr/bin/chromium' : undefined;
const executablePath = configuredBrowser || systemBrowser;
if (executablePath) console.log(`[media tests] Using browser: ${executablePath}`);

export default defineConfig({
  testDir: './tests/web',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 720 },
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Prefer the pinned browser; record an explicit override or system fallback above.
      executablePath,
    },
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'npm run test:serve',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    // Includes first-run media fixture preparation before Vite starts.
    timeout: 90_000,
  },
});
