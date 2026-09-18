/** Run vitest with this checkout's resolved env — `bun run check`'s vitest step, filterable. */
import { devEnv } from "../scripts/checkout.ts";
import { bunx, repoRoot, runSequence } from "../scripts/lib.ts";
await runSequence([
  {
    label: "vitest",
    cmd: bunx("vitest", "run", ...process.argv.slice(2)),
    cwd: repoRoot,
    env: devEnv().env,
  },
]);
