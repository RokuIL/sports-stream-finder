import { defineConfig } from 'playwright';

export default defineConfig({
  timeout: 30000,
  use: {
    headless: process.env.HEADLESS !== 'false',
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
});