import { defineConfig } from "vitest/config";

// Unit tests run against plain modules, without the TanStack Start / Nitro plugin
// chain: they must stay fast and must never touch the network (see ../../CLAUDE.md).
export default defineConfig({
  test: {
    environment: "node",
    // `test/` holds the recorded cassettes of P04 and the suites that replay them; the
    // recordings sit next to the tests that use them rather than inside `src/`.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
