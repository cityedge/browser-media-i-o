import { defineConfig } from '@playwright/test';
import baseline from './playwright.config';

export default defineConfig({
  ...baseline,
  testDir: './tests/app',
  outputDir: './test-results/app',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/app', open: 'never' }],
    ['json', { outputFile: 'test-results/app/results.json' }],
  ],
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:4174', viewport: { width: 1440, height: 1050 } },
  webServer: {
    command: 'npm run app:preview',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
