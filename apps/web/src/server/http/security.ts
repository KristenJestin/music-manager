/**
 * The security headers every response carries (`docs/phases/P10-production.md` § Sécurité).
 *
 * They are applied in one place — `src/server-entry.ts`, the request handler the whole app is
 * served through — rather than route by route, because a header nobody remembers to add is a
 * header that is missing from exactly the route that needed it.
 *
 * This module has **no imports**. It is reached from the server entry, which is server-only by
 * construction, but keeping it pure means it can be unit-tested without a router, a database
 * or an environment, and it is the reason `security.test.ts` is three milliseconds long.
 *
 * What each header is here for, and what it deliberately is *not*:
 *
 *  - **`X-Content-Type-Options: nosniff`** — the library serves user-supplied artwork through
 *    `/api/cover`; a browser that sniffs a JPEG into `text/html` turns a cover into a script.
 *  - **`X-Frame-Options: DENY`** and **`frame-ancestors 'none'`** — nothing in this app is
 *    meant to be embedded, and clickjacking a Console that can delete a library is cheap.
 *  - **`Referrer-Policy: same-origin`** — an import URL is in the address bar; it must not
 *    leak to MusicBrainz, Deezer or YouTube in a `Referer`.
 *  - **`Permissions-Policy`** — the Console asks for no camera, no microphone, no geolocation.
 *    Saying so is free and survives a future dependency that would like one.
 *  - **`Cross-Origin-Opener-Policy: same-origin`** — isolates the browsing context group.
 *  - **`Strict-Transport-Security` only behind a proxy.** On plain HTTP the header is ignored
 *    by browsers anyway, and setting it on `http://localhost:3000` during development would
 *    pin the developer's browser to HTTPS for a host that does not speak it. `MM_BEHIND_PROXY`
 *    is exactly the flag that says "a reverse proxy terminates TLS in front of me".
 *
 * **The CSP allows `'unsafe-inline'` for scripts, on purpose.** TanStack Start serialises the
 * router's dehydrated state and the hydration bootstrap into inline `<script>` tags on every
 * SSR response; a nonce-based policy would mean threading a per-request nonce through the
 * framework's own head injection, which it does not expose. The policy still does the two
 * things worth doing here: it forbids `object-src` and `base-uri`, and it pins `connect-src`,
 * `img-src` and `frame-ancestors` — so a stored-XSS payload cannot exfiltrate to a third party
 * or reframe the page even if it manages to run. `'unsafe-eval'` is *not* granted.
 *
 * `img-src` carries `https:` because album art is displayed both from `/api/cover` (proxied)
 * and, in the candidate pickers, straight from the Cover Art Archive; `data:` and `blob:`
 * cover the inline placeholders and the artwork cropper.
 */

/** What the caller has to tell this module. Both come from the environment, once, at boot. */
export interface SecurityHeaderOptions {
  /** `MM_BEHIND_PROXY=1`: a reverse proxy terminates TLS in front of this process. */
  readonly behindProxy: boolean;
}

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

/** One year, the value the HSTS preload list requires and the one Caddy sets by default. */
const HSTS = "max-age=31536000; includeSubDomains";

/** The headers, as a plain object. Exported so a test can read them without a Response. */
export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  if (options.behindProxy) headers["strict-transport-security"] = HSTS;
  return headers;
}

/**
 * Put them on a response.
 *
 * A `Response` produced by `Response.redirect()` — which is how the Console sends an
 * unauthenticated browser to `/login` — has **immutable** headers, and `headers.set()` on one
 * throws a `TypeError`. Rebuilding the response is the only way to add anything to it, so the
 * mutation is attempted first (no copy in the common case) and the rebuild is the fallback.
 *
 * A header the handler set itself always wins: a route that chose its own `cache-control` or a
 * narrower CSP knows something this function does not.
 */
export function withSecurityHeaders(response: Response, options: SecurityHeaderOptions): Response {
  const wanted = securityHeaders(options);
  try {
    for (const [name, value] of Object.entries(wanted)) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(wanted)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
