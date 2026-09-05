import { defineConfig } from "vitest/config";

/**
 * The domain package's own vitest project, so `bun run --cwd packages/domain test` works on
 * its own and so the root `vitest.config.ts` can reference this directory as a project.
 *
 * Tests read `fixtures/` and `golden/` from disk — that is the only I/O allowed anywhere in
 * this package, and it never reaches the network (see ../../CLAUDE.md).
 */
export default defineConfig({
  test: {
    name: "domain",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
