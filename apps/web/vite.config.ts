import { defineConfig, type Plugin } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

/**
 * Let `/api/**` answer an `<img>`, an `<audio>` or a `<link>` in dev.
 *
 * Nitro's dev middleware decides whether a request is a static asset — and so whether the
 * application ever sees it — from `Sec-Fetch-Dest` (`nitro/dist/_build/vite.dev.mjs`):
 *
 * ```js
 * const isAsset = typeof fetchDest === "string" && fetchDest !== "empty"
 *   ? !/^(?:document|iframe|frame)$/.test(fetchDest)
 *   : isAssetByExt;
 * if (isAsset) req._nitroHandled = true;   // …and Vite's static pipeline 404s it
 * ```
 *
 * Every TanStack Start server route lives behind Nitro's catch-all `/**`, not as a route of
 * its own, so that first branch never runs for us: **any** request whose destination is not
 * `document` or `empty` is declared an asset, handed to Vite, not found on disk, and answered
 * `404 text/html`. The same URL returns `200 image/jpeg` to `fetch()` and `404` to `<img>` —
 * verified with curl on `/api/cover` and on `/health` alike, so it is not one endpoint's bug.
 *
 * That is why the owner's C10 survived a fix: `<Cover>` was pointed at `/api/cover?album=…`,
 * every tile got a 404, and the gradient he complained about is precisely the fallback for
 * "no image loaded". Production is unaffected — there is no Vite, and Nitro routes everything.
 *
 * Removing the header for `/api/**` puts those requests back on Nitro's extension heuristic,
 * and our API paths carry no extension, so they are not assets. Nothing downstream reads
 * `Sec-Fetch-Dest`: Better Auth checks `Origin`, and the API's own guards read cookies and
 * `x-api-key`. Deleting it — rather than forging `document` — keeps us out of the branch that
 * decides what to *render*.
 */
function apiRoutesAreNotAssets(): Plugin {
  return {
    name: "mm:api-routes-are-not-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith("/api/") === true) delete req.headers["sec-fetch-dest"];
        next();
      });
    },
  };
}

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
    // Before `nitro()`: middlewares run in the order their plugin registered them, and this
    // one has to see the request before `nitroDevMiddlewarePre` classifies it.
    apiRoutesAreNotAssets(),
    nitro({ preset: "bun" }),
    tailwindcss(),
    /*
     * `src/server-entry.ts` wraps the framework's request handler with the three cross-cutting
     * concerns of P10 — rate limit, security headers, JSON access log — and it is used in
     * `vite dev` and in the Nitro build alike, so the two behave the same.
     *
     * The name is given explicitly because the default is `./server`, and `src/server/` is a
     * directory of server-only modules: leaving it implicit makes the entry depend on how a
     * resolver breaks that tie.
     */
    tanstackStart({ server: { entry: "server-entry.ts" } }),
    viteReact(),
  ],
});
