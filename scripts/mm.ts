#!/usr/bin/env bun
/**
 * `bun run mm -- <command>` — the CLI, with this checkout's environment.
 *
 * Same reason as `scripts/worker.ts`: a worktree has no `.env` of its own, and the CLI must
 * talk to the worktree's database, toolbox and library rather than the shared ones. No banner
 * is printed — the CLI's own output is the output.
 */
import { join } from "node:path";
import { bun, run, webDir } from "./lib.ts";
import { devEnv } from "./checkout.ts";

const resolved = devEnv({ preferPortless: true });

process.exit(
  await run({
    label: "mm",
    cmd: [bun, "run", join(webDir, "bin", "mm.ts"), ...process.argv.slice(2)],
    env: resolved.env,
  }),
);
