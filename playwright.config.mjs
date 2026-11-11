import { defineConfig } from '@playwright/test';

const built = process.env.WUWATERM_BROWSER_BUILT === '1';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  // One retry covers a non-deterministic host stall only. It cannot hide a
  // product regression: a deterministic failure fails both attempts and the job
  // stays red, and a test that passes only on retry is reported as flaky. The
  // traces of the failed attempt are kept and uploaded by CI.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: './.wrangler/browser-results',
  // The longest single test on CI takes 5.8s; 30s is that test's budget,
  // unchanged from the default and pinned so the relation to the action budget
  // below is explicit.
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // With the default 0 an action inherits whatever is left of the test clock,
    // so a stalled click is reported as `Test timeout of 30000ms exceeded` at
    // the test declaration line instead of a click timeout at the click. A
    // bounded action clock attributes the wait to the action and fails there
    // even when the test still has budget left; 10s is far above any single
    // action in a suite whose longest whole test runs 5.8s on CI.
    actionTimeout: 10_000,
    trace: 'retain-on-failure-and-retries',
  },
  webServer: {
    ...(built ? {
      command: 'node scripts/serve-built-browser.mjs',
      // The named group is exported to WUWATERM_BROWSER_URL without the
      // trailing slash; browser specs navigate to BASE + '/...'.
      wait: { stdout: /BUILT_SITE_URL=(?<WUWATERM_BROWSER_URL>http:\/\/127\.0\.0\.1:\d+)/ },
    } : {
      command: 'npm run dev -- --hostname 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
    }),
    stdout: 'pipe',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
