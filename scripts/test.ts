/** `bun run test` — every unit test, both languages. No network, ever. */
import { bunx, repoRoot, resolveUv, runSequence, toolboxDir } from "./lib.ts";

await runSequence([
  { label: "vitest", cmd: bunx("vitest", "run"), cwd: repoRoot },
  { label: "pytest", cmd: [resolveUv(), "run", "pytest"], cwd: toolboxDir },
]);
