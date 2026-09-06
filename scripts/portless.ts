#!/usr/bin/env bun
/**
 * `bun run dev:portless` — the dev server behind a stable named URL instead of a port.
 *
 * [portless](https://portless.sh/) runs a local HTTPS proxy and gives the command it launches
 * an ephemeral `PORT` plus a `PORTLESS_URL` of the form `https://<app>.localhost`. Two things
 * follow, and both are why this wrapper exists rather than a raw `portless bun run dev`:
 *
 *  - **the app name must be stable and per-checkout.** `v2/` is always
 *    `https://music-manager.localhost`; a worktree is `https://music-manager-<slug>.localhost`.
 *    Same URL every time, no port to remember, and no two checkouts sharing cookies or
 *    `localStorage` — which is the other half of what portless buys us, since
 *    `http://localhost:3100` and `http://localhost:3101` are one origin for cookie purposes and
 *    two logins fight over the same session cookie.
 *  - **`MM_WEB_URL` must follow that URL, not the port.** Better Auth checks the browser's
 *    origin; under portless the origin is `https://music-manager.localhost`, and an app that
 *    still believes it is on `http://localhost:3000` answers *"Invalid origin"* at login and
 *    nothing before it. `scripts/checkout.ts` reads `PORTLESS_URL` for exactly this.
 *
 * Everything else — compose project, database, library — is decided by `scripts/dev.ts` from
 * the checkout, unchanged. `PORTLESS=0 bun run dev` remains the way to run without the proxy.
 *
 * Usage: `bun run dev:portless [-- extra args for scripts/dev.ts]`
 */
import { join } from "node:path";
import { bun, repoRoot, run } from "./lib.ts";
import { checkout, portlessUrl } from "./checkout.ts";

const info = checkout();
const exe = Bun.which("portless");

if (!exe) {
  console.error("portless is not on PATH. Install it with:  npm install -g portless");
  console.error("(it needs Node 24+; see https://portless.sh/)");
  console.error("Meanwhile, `bun run dev` works on a plain port.");
  process.exit(1);
}

console.log(`=== portless: ${portlessUrl(info.appName)} ===`);

process.exit(
  await run({
    label: "portless dev",
    cmd: [
      exe,
      info.appName,
      bun,
      "run",
      join(repoRoot, "scripts", "dev.ts"),
      ...process.argv.slice(2),
    ],
    cwd: repoRoot,
  }),
);
