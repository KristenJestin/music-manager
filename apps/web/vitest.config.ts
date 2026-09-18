import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests run against plain modules, without the TanStack Start / Nitro plugin
// chain: they must stay fast and must never touch the network (see ../../CLAUDE.md).
export default defineConfig({
  /**
   * `@/…`, the alias the shadcn components import each other by.
   *
   * `tsconfig.json` maps `#/*` and `@/*` to the same `./src/*`, and the app resolves both —
   * `#/` through the package's own `imports` field, which Vite honours without being told, and
   * `@/` through the tsconfig paths, which it does not read. So a component test that rendered
   * anything reaching `components/ui/*` failed at *import* time with "Failed to resolve import
   * @/components/ui/button", and the only components under test were the ones that happened
   * not to use a shadcn primitive. A dialog cannot avoid one.
   *
   * `bunx shadcn add` writes `@/` and is not to be hand-edited (`AGENTS.md`), so the alias is
   * the thing that has to move, not the generated files.
   */
  resolve: {
    alias: { "@/": `${fileURLToPath(new URL("./src", import.meta.url))}/` },
  },
  test: {
    environment: "node",
    // `test/` holds the recorded cassettes of P04 and the suites that replay them; the
    // recordings sit next to the tests that use them rather than inside `src/`.
    // `bin/` joined the list in P08: the CLI's remote mode has real logic of its own
    // (config precedence, SSE framing) that is worth testing without a server.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts", "bin/**/*.test.ts"],
  },
});
