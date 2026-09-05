import { defineConfig } from "vitest/config";

// Unit tests run against plain modules, without the TanStack Start / Nitro plugin
// chain: they must stay fast and must never touch the network (see ../../CLAUDE.md).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
