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
    <script
      id="api-reference"
      data-url="/api/openapi.json"
      data-configuration='{"theme":"kepler","darkMode":true,"hideDownloadButton":false}'
    ></script>
    <script
      id="scalar-bundle"
      src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1/dist/browser/standalone.min.js"
      crossorigin="anonymous"
    ></script>
    <script>
      /*
       * Show the explanation only when Scalar genuinely did not arrive.
       *
       * The first version of this checked whether an "#app" div had children, and was wrong in
       * the one direction that matters: Scalar replaces its own "#api-reference" script rather
       * than filling somebody else's container, so the banner appeared *over a working page*.
       * (No backticks in this comment on purpose — it lives inside a template literal.)
       * Telling someone a thing is broken while they are looking at it working is worse than
       * saying nothing.
       *
       * So: the script's own "onerror" is the authority — it is the only signal that actually
       * means "the CDN did not answer" — and the timer is a backstop for the case where the
       * script loads but renders nothing, which it detects by looking for what Scalar itself
       * puts in the DOM.
       */
      (function () {
        var fallback = document.getElementById('fallback');
        var show = function () { fallback.style.display = 'block'; };
        document.getElementById('scalar-bundle').addEventListener('error', show);
        setTimeout(function () {
          if (!document.querySelector('[class*="scalar"], .references-layout')) show();
        }, 8000);
      })();
    </script>
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
