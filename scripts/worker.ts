#!/usr/bin/env bun
/**
 * `bun run worker` — the job orchestrator, with this checkout's environment.
 *
 * The worker has no HTTP server of its own, so portless has nothing to proxy; what it does need
 * is the *same* `DATABASE_URL`, `MM_TOOLBOX_URL` and `MM_LIBRARY_ROOT` as the web app it shares
 * a checkout with. Launching it as `bun run apps/web/src/worker/index.ts` gets that right in
 * `v2/` by accident — Bun loads `.env` from the cwd — and wrong in a worktree, where there is no
 * `.env` at all and the process comes up either unconfigured or, worse, pointed at the shared
 * database. `scripts/checkout.ts` resolves both cases the same way `bun run dev` does.
 *
 * `MM_WEB_URL` is derived from the portless app name so that links the worker emits
 * (notifications, webhooks) point at the URL the owner actually browses.
 */
import { join } from "node:path";
import { bun, run, webDir } from "./lib.ts";
import { describeCheckout, devEnv } from "./checkout.ts";

const resolved = devEnv({ preferPortless: true });

console.log("=== worker ===");
console.log(describeCheckout(resolved));

if (resolved.databaseUrl === "") {
  console.error(
    "\nNo DATABASE_URL. In a worktree it is read from the primary checkout's .env " +
      `(${join(resolved.checkout.mainRoot, ".env")}), which is gitignored — make sure it exists.`,
  );
  process.exit(1);
}

process.exit(
  await run({
    label: "worker",
    cmd: [bun, "run", join(webDir, "src", "worker", "index.ts")],
    env: resolved.env,
  }),
);
