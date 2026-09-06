#!/usr/bin/env bun
/**
 * `bun run e2e:all` — every end-to-end run there is, in one command.
 *
 * There are four of them and they had no single entry point, which is how one of them fell
 * out of the routine: the P11 audit found `e2e-migrate` in `package.json` and in nobody's
 * habits, so the migration take-over — the one run that exercises a *v1* installation — was
 * only ever executed by the agent that wrote it. A suite nobody runs is a suite that is
 * already broken; it simply has not been told yet.
 *
 * `bun run check` stays what it is: the fast gate, types and lint and unit tests, no Docker
 * and no browser. This is the slow one, and it is the other half of the Definition of Done.
 *
 * Order is cheapest-first, so a broken pipeline is reported in three minutes rather than in
 * thirty:
 *
 *  1. `e2e-fixture` — the vertical slice: worker, CLI, toolbox, no browser;
 *  2. `e2e-migrate` — the v1 take-over, dry run and real run;
 *  3. `e2e-verify`  — the Navidrome read-back, against a real Navidrome;
 *  4. `e2e`         — the Console, in Chromium.
 *
 * Every one of them resolves its own checkout through `e2e-checkout.ts`, so this is safe to
 * run from a worktree: its own toolbox, its own databases, its own library, `-p` on every
 * compose call. Pass `--only <name>[,<name>]` to run a subset.
 */
import { bun, repoRoot, runSequence } from "./lib.ts";
import { describeStack, e2eStack } from "./e2e-checkout.ts";

const RUNS = [
  { name: "fixture", label: "e2e-fixture (the vertical slice)", script: "e2e-fixture.ts" },
  { name: "migrate", label: "e2e-migrate (the v1 take-over)", script: "e2e-migrate.ts" },
  { name: "verify", label: "e2e-verify (the Navidrome read-back)", script: "e2e-verify.ts" },
  { name: "web", label: "e2e (the Console, in Chromium)", script: "e2e-web.ts" },
] as const;

const onlyFlag = process.argv.indexOf("--only");
const only =
  onlyFlag === -1
    ? null
    : new Set((process.argv[onlyFlag + 1] ?? "").split(",").filter((name) => name !== ""));

const chosen = RUNS.filter((run) => only === null || only.has(run.name));
if (chosen.length === 0) {
  console.error(`Nothing to run. --only takes any of: ${RUNS.map((run) => run.name).join(", ")}.`);
  process.exit(1);
}

console.log("=== this checkout ===");
console.log(`  ${describeStack(e2eStack())}`);

await runSequence(
  chosen.map((run) => ({
    label: run.label,
    cmd: [bun, "run", `scripts/${run.script}`],
    cwd: repoRoot,
  })),
);
