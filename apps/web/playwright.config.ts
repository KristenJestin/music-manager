import { defineConfig, devices } from "@playwright/test";
import { CHROMIUM_ARGS, chromiumExecutable } from "./e2e/chromium.ts";

/**
 * The Console's browser tests.
 *
 * Run them with `bun run e2e`, which brings the stack up, migrates a database of their own,
 * starts the web app and the worker in fixtures mode and then calls Playwright. Running
 * `playwright test` directly works too, against whatever `MM_E2E_BASE_URL` points at.
 *
 * Deliberately serial and single-worker. These are not unit tests: they drive one worker
 * process with one download slot, against one database, and the scenarios of
 * `docs/phases/P06-web-coeur.md` are about a job progressing — which is a global fact, not a
 * per-test one. Parallelism here would buy seconds and cost determinism.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../.local/playwright",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env["CI"] === "true",
  retries: 0,
  // A dev server compiles a route on its first request, and the pipeline downloads fifteen
  // files through a real container; both are slower than a typical page test.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env["MM_E2E_BASE_URL"] ?? "http://localhost:3170",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          ...(chromiumExecutable() === undefined
            ? {}
            : { executablePath: chromiumExecutable() as string }),
          args: CHROMIUM_ARGS,
        },
      },
    },
  ],
});
