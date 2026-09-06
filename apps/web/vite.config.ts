import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

/**
 * The dev port. `PORT` wins; 3000 is the default the docs quote.
 *
 * Several agents share this machine and `:3000` is routinely taken by an unrelated project
 * (`CLAUDE.md`'s process-safety note), so the port had to stop being a constant compiled into
 * the config. When `PORT` is set explicitly, `strictPort` makes a busy port an error instead of
 * a silent slide to 3001 — being told you are on the wrong port beats discovering it later.
 */
const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);
const strictPort = process.env["PORT"] !== undefined;

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { port, strictPort },
  plugins: [
    /*
     * Production runs the Bun Nitro preset — `bun .output/server/index.mjs`.
     *
     * **Dev does not.** `vite dev` is a `#!/usr/bin/env node` bin, so `bun run dev` hands the
     * dev server, and with it SSR, to Node. Server code therefore cannot assume the `Bun`
     * global exists; `server/auth/auth.ts` says what happens when it does, and
     * `src/client-boundary.guard.test.ts` fails the build over a new `Bun.` call.
     */
    nitro({ preset: "bun" }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
