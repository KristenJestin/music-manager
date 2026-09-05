import { defineConfig } from "vitest/config";

// One run for the whole workspace. Unit tests must never touch the network:
// use recorded fixtures and cassettes instead (see CLAUDE.md).
export default defineConfig({
  test: {
    projects: ["apps/web", "packages/domain", "packages/contracts"],
  },
});
