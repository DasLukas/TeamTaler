import { defineConfig } from '@playwright/test';

/** Isolated frontend-only camera acceptance tests; never accesses a live backend. */
export default defineConfig({
  testDir: './scan-e2e',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5184',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {},
  },
  webServer: { command: 'npx vite --host 127.0.0.1 --port 5184 --strictPort', url: 'http://127.0.0.1:5184', reuseExistingServer: false },
  projects: [
    { name: 'phone', use: { viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
  ],
});
