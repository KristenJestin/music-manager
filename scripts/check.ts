/**
 * `bun run check` — the single gate every phase must leave green.
 *
 * TypeScript first (fastest feedback), then lint and format, then the test suites of both
 * languages. Python tools run through `uv`, which is resolved even when it is not on PATH.
 */
import { bunx, repoRoot, resolveUv, runSequence, toolboxDir, webDir } from "./lib.ts";

const uv = resolveUv();

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
  { label: "vitest", cmd: bunx("vitest", "run"), cwd: repoRoot },

  { label: "ruff", cmd: [uv, "run", "ruff", "check", "."], cwd: toolboxDir },
  { label: "ruff format", cmd: [uv, "run", "ruff", "format", "--check", "."], cwd: toolboxDir },
  { label: "pyright", cmd: [uv, "run", "pyright"], cwd: toolboxDir },
  { label: "pytest", cmd: [uv, "run", "pytest"], cwd: toolboxDir },
]);
