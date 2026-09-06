/**
 * `bun run check` — the single gate every phase must leave green.
 *
 * TypeScript first (fastest feedback), then lint and format, then the test suites of both
 * languages. Python tools run through `uv`, which is resolved even when it is not on PATH.
 */
import { devEnv } from "./checkout.ts";
import { bunx, repoRoot, resolveUv, runSequence, toolboxDir, webDir } from "./lib.ts";

const uv = resolveUv();

/**
 * The checkout's own database, toolbox and library — for vitest, not just for `dev`.
 *
 * `vitest run` used to inherit whatever the shell had, which from a worktree is *nothing*:
 * `.env` is the owner's and lives in `v2/`, so `DATABASE_URL` and `MM_TOOLBOX_URL` were unset
 * and `pipeline.integration.test.ts` fell back to its own defaults — `localhost:5432/mm` and
 * `localhost:8100`, which are **the primary checkout's postgres and the owner's toolbox**. The
 * suite then created its database next to the owner's and asked his container to write files,
 * from an agent's worktree, silently. It even looked healthy, because those tests skip when
 * the stack is not up and the owner's stack usually is.
 *
 * `devEnv()` is the same resolution `bun run dev`, `stack:*` and the four end-to-end runners
 * already use: `v2/.env` for the secrets, then this checkout's database, toolbox port and
 * library on top. Giving it to vitest makes `bun run check` mean the same thing in a worktree
 * as it does in `v2/`.
 */
const CHECKOUT_ENV = devEnv().env;

await runSequence([
  // The route tree is generated, not committed: produce it before typechecking.
  { label: "routes (tsr generate)", cmd: bunx("tsr", "generate"), cwd: webDir },

  { label: "tsc scripts", cmd: bunx("tsc", "--noEmit", "-p", "tsconfig.json") },
  { label: "tsc apps/web", cmd: bunx("tsc", "--noEmit", "-p", "apps/web/tsconfig.json") },
  {
    label: "tsc packages/domain",
    cmd: bunx("tsc", "--noEmit", "-p", "packages/domain/tsconfig.json"),
  },
  {
    label: "tsc packages/contracts",
    cmd: bunx("tsc", "--noEmit", "-p", "packages/contracts/tsconfig.json"),
  },

  { label: "eslint", cmd: bunx("eslint", ".") },
  { label: "prettier", cmd: bunx("prettier", "--check", ".") },
  { label: "vitest", cmd: bunx("vitest", "run"), cwd: repoRoot, env: CHECKOUT_ENV },

  { label: "ruff", cmd: [uv, "run", "ruff", "check", "."], cwd: toolboxDir },
  { label: "ruff format", cmd: [uv, "run", "ruff", "format", "--check", "."], cwd: toolboxDir },
  { label: "pyright", cmd: [uv, "run", "pyright"], cwd: toolboxDir },
  { label: "pytest", cmd: [uv, "run", "pytest"], cwd: toolboxDir },
]);
