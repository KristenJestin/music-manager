/**
 * What to do when the client is not there any more, and how to stop being killed for it.
 *
 * ## The bug this module exists for
 *
 * Production runs the Nitro **bun** preset — `bun .output/server/index.mjs` — which reaches
 * `Bun.serve()` through `srvx/bun` with no options of its own. `Bun.serve`'s `idleTimeout`
 * therefore stays at its default, and that default is **ten seconds**: a connection on which
 * no byte has moved for ten seconds is closed by the server itself.
 *
 * A server function that spends eleven seconds asking MusicBrainz sends nothing at all while
 * it works — the JSON body is written once, at the end — so the connection is idle for the
 * whole of it. Bun closes it at ten seconds (plus up to a second of timer granularity, which
 * is why the owner's log reads `ms: 11316`), the handler finishes into a socket that is gone,
 * and the abort escapes as an unhandled `DOMException { name: "AbortError", message: "The
 * connection was closed." }`. Nitro turns that into a 500, the access log records a 500, and
 * the browser — which never asked for any of this — gets an empty reply and renders whatever
 * its router does with an unreadable response.
 *
 * Measured, not inferred: a bare `Bun.serve` whose handler sleeps fifteen seconds answers
 * `curl` with exit 52 after 10.99 s and reports `request.signal.aborted === true`; the same
 * server with `idleTimeout: 0`, or with `server.timeout(request, 120)` called from the
 * handler, answers 200 after 15.00 s. Neither the browser, nor the router, nor a proxy is
 * involved in that reproduction.
 *
 * ## The two halves
 *
 *  - {@link requestTimeoutSeconds} / the `server.timeout` call in `src/server-entry.ts` raise
 *    the ceiling, so a request that is legitimately slow is not murdered at ten seconds. This
 *    is a floor under correctness, not a licence: `docs/…` and the wizard both moved their
 *    genuinely long work off the request, because a ceiling of four minutes is still a ceiling.
 *  - {@link isClientAbort} recognises the aborts that remain — the reload, the Escape key, the
 *    tab closed mid-load — so the entry can log them at `info` and answer nothing instead of
 *    raising a 500 nobody can read. A client that went away is not an error rate.
 *
 * No imports, like its neighbours in this directory: the entry reaches it before anything else
 * is loaded, and a pure module is a module a test can exercise in three milliseconds.
 */

/**
 * The status an aborted request is *recorded* as. Nothing is ever sent under it.
 *
 * 499 is nginx's "client closed request" and has been the conventional slot for this for
 * fifteen years. It is deliberately not 200 (which would hide the disconnection from anyone
 * reading the logs), not 500 (which is the bug being fixed), and not 408 (which means "you
 * were too slow", the opposite of what happened).
 */
export const CLIENT_CLOSED = 499;

/**
 * How long a single request may hold a connection open before Bun reclaims it.
 *
 * Two hundred and forty seconds. The reasoning, in order:
 *
 *  - Bun's own ceiling is 255 s; anything above that is silently clamped, so a number nobody
 *    can read as "disabled" is better than one that pretends to be.
 *  - Ten seconds — the default — is below the *floor* of several honest operations. Matching
 *    an album is ten MusicBrainz requests at the one per second the service allows; asking a
 *    stopped Navidrome three questions is three sixty-second connect timeouts.
 *  - It is not `0` (no timeout at all). A self-hosted Console reachable from the internet
 *    should still hang up on a socket that has gone quiet for four minutes; an unbounded idle
 *    timeout is how a handful of open connections become all of them.
 *
 * `MM_REQUEST_TIMEOUT_S` overrides it for an installation that knows better. Anything
 * unparseable, negative or above Bun's ceiling falls back to the default rather than throwing:
 * the request path must not be the place a typo in `.env` first shows up.
 */
export const DEFAULT_REQUEST_TIMEOUT_S = 240;

/** Bun clamps `idleTimeout` — and `server.timeout()` — to this. */
const BUN_MAX_TIMEOUT_S = 255;

export function requestTimeoutSeconds(source: Record<string, string | undefined>): number {
  const raw = Number.parseInt((source["MM_REQUEST_TIMEOUT_S"] ?? "").trim(), 10);
  if (!Number.isFinite(raw) || raw <= 0 || raw > BUN_MAX_TIMEOUT_S) {
    return DEFAULT_REQUEST_TIMEOUT_S;
  }
  return raw;
}

/**
 * The shape `srvx` hangs on every request it hands to the application, when it is on Bun.
 *
 * `server.timeout(request, seconds)` is Bun's per-connection lever: it resets the idle timeout
 * for *this* request only, which is what we want — a global `idleTimeout` would have to be
 * passed to `Bun.serve()`, and the call site belongs to Nitro's generated entry, not to us.
 *
 * Typed structurally and read defensively because it is a runtime detail of two dependencies:
 * under `vite dev` the server is Node and there is no `runtime` at all, and a future srvx may
 * move it. Both cases mean "cannot raise the ceiling here", never "crash".
 */
interface BunRuntimeRequest {
  readonly runtime?: {
    readonly bun?: {
      readonly server?: { timeout?: (request: Request, seconds: number) => void };
    };
  };
}

/**
 * Give this request until `seconds` before the runtime reclaims its connection.
 *
 * Returns whether the lever was found, so a test can assert on it and so the entry can say
 * nothing at all on the runtimes that do not have one (Node under `vite dev`, and any preset
 * that is not Bun). Never throws: a failure to raise a ceiling must not become a 500 of its
 * own, which would be an ironic way to fix this bug.
 */
export function extendRequestTimeout(request: Request, seconds: number): boolean {
  try {
    const server = (request as BunRuntimeRequest).runtime?.bun?.server;
    if (typeof server?.timeout !== "function") return false;
    server.timeout(request, seconds);
    return true;
  } catch {
    return false;
  }
}

/** The abort names and messages every runtime in play uses for "the other end went away". */
const ABORT_NAMES = new Set(["AbortError", "ConnectionClosedError"]);
const ABORT_CODES = new Set([
  "ABORT_ERR",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
const ABORT_MESSAGES =
  /\b(?:the connection was closed|connection closed|aborted|abort(?:ed)? by the client|premature close|socket hang up|request aborted|operation was aborted|econnreset|epipe)\b/i;

/**
 * Did this request fail because the client stopped listening?
 *
 * Three independent signals, because no single one is reliable across Bun, Node and undici:
 *
 *  1. **`request.signal.aborted`**, when a request is given. This is the strongest of the
 *     three and the only one that is not string matching — Bun sets it the moment it closes
 *     the connection, which the reproduction above confirms. It is checked first and it alone
 *     is enough, because nothing else aborts these signals: the app never wires a deadline
 *     onto an inbound request.
 *  2. **The error's `name`/`code`**, which covers the `DOMException { code: 20 }` Bun throws
 *     out of a stream enqueue and Node's `ECONNRESET`/`EPIPE` family.
 *  3. **The message**, last and least, for the wrapped cases: a `cause` chain is walked so an
 *     abort re-thrown as `new Error("…", { cause })` is still recognised.
 *
 * The cost of a false positive is a genuine 500 logged as a disconnection, so the message
 * pattern is anchored on whole words rather than substrings — `"aborted"` matches, `"the
 * import was aborted by the operator"` would too and is not thrown here, and an arbitrary
 * message containing the letters is not enough on its own without one of the shapes above.
 */
export function isClientAbort(error: unknown, request?: Request): boolean {
  if (request?.signal.aborted === true) return true;
  return looksAborted(error, 0);
}

function looksAborted(error: unknown, depth: number): boolean {
  if (depth > 4 || error === null || typeof error !== "object") return false;
  const carrier = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

  if (typeof carrier.name === "string" && ABORT_NAMES.has(carrier.name)) return true;
  if (typeof carrier.code === "string" && ABORT_CODES.has(carrier.code)) return true;
  // `DOMException.ABORT_ERR`. Bun throws exactly this when a handler writes to a closed socket.
  if (carrier.code === 20 && typeof carrier.name === "string") return true;
  if (typeof carrier.message === "string" && ABORT_MESSAGES.test(carrier.message)) return true;

  return looksAborted(carrier.cause, depth + 1);
}

/**
 * The response for a client that is no longer there.
 *
 * Empty, statused 499, and never actually read by anyone — the socket it would travel on is
 * closed, which is the whole point. It exists so the entry has something to return instead of
 * rethrowing, and so the access log has a status to record.
 */
export function clientClosedResponse(): Response {
  return new Response(null, { status: CLIENT_CLOSED });
}
