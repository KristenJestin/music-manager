/** `bun run typecheck` — TypeScript only, for a fast inner loop. */
import { bunx, runSequence, webDir } from "./lib.ts";

await runSequence([
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
]);
