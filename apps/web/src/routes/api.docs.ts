import { createFileRoute } from "@tanstack/react-router";
import { errorBody, resolvePrincipal } from "#/server/api/auth.ts";

/**
 * `GET /api/docs` — the reference, rendered.
 *
 * Scalar from a CDN rather than a bundled dependency. `docs/phases/P08-api-agents.md` allows
 * either, and the trade is worth stating: bundling adds ~800 kB of vendor JavaScript to a
 * self-hosted app in order to render a page most operators open twice, and it has to be
 * upgraded by hand for ever. A CDN tag costs nothing when nobody looks at it. The price is
 * that `/api/docs` needs the internet — which is why the failure is *explained* in the page
 * rather than left as a blank screen, and why `GET /api/openapi.json` is the offline answer:
 * the document itself is generated locally and owes nothing to any CDN.
 *
 * Behind authentication for the same reason as the document it renders.
 */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Music Manager — API</title>
    <link rel="icon" href="data:," />
    <style>
      body { margin: 0; background: #0e1116; color: #e6e9ef;
             font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
      #fallback { display: none; padding: 3rem; max-width: 42rem; margin: 0 auto; }
      #fallback code { background: #171b22; padding: .15rem .35rem; border-radius: .25rem; }
      #fallback a { color: #f5b544; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <div id="fallback">
      <h1>The documentation viewer could not load.</h1>
      <p>
        <code>/api/docs</code> renders the reference with Scalar, which is fetched from a CDN,
        and this installation could not reach it. The API itself is unaffected.
      </p>
      <p>
        The generated document is served locally and needs no network:
        <a href="/api/openapi.json">/api/openapi.json</a>.
      </p>
    </div>
    <script>
      // Show the explanation only if Scalar never arrives. A blank page is the one outcome
      // worth ruling out.
      setTimeout(function () {
        if (!document.querySelector('#app').hasChildNodes()) {
          document.getElementById('fallback').style.display = 'block';
        }
      }, 4000);
    </script>
    <script
      id="api-reference"
      data-url="/api/openapi.json"
      data-configuration='{"theme":"kepler","darkMode":true,"hideDownloadButton":false}'
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1/dist/browser/standalone.min.js" crossorigin="anonymous"></script>
  </body>
</html>`;

export const Route = createFileRoute("/api/docs")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const resolution = await resolvePrincipal(request);
        if (!resolution.ok) {
          return Response.json(errorBody(resolution.error), { status: resolution.status });
        }
        return new Response(PAGE, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      },
    },
  },
});
