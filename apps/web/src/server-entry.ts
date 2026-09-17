/**
 * The server entry: every HTTP request the app answers goes through this function.
 *
 * TanStack Start resolves `server.entry` from `vite.config.ts` (it would otherwise use its own
 * `default-entry/server.ts`, which is this file minus the three things below). It is aliased to
 * `#tanstack-server-entry` in **both** `vite dev` and the Nitro build, so what is enforced here
 * is enforced identically in development and in the production image — which is the reason the
 * cross-cutting concerns of P10 live here rather than in a Nitro plugin.
 *
 * It is named `server-entry.ts`, not `server.ts`, on purpose: `src/server/` is a *directory* of
 * server-only modules, and Start resolves its entries with `./server` — a name that a bundler
 * resolver is free to read as either. Two spellings that differ by an extension, one of which
 * silently turns a directory into an entry point, is not a distinction worth relying on.
 *
 * Four things happen around the framework's own handler:
 *
 *  1. **Rate limiting**, before any work: `/api/auth/sign-in/*` and `/login` get ten attempts
 *     per five minutes, `/api/**` and `/mcp` six hundred a minute. A refused request costs a
 *     `Map` lookup, no database round-trip and no router.
 *  2. **The connection's idle ceiling**, raised from Bun's ten-second default before the
 *     handler is entered, and **the client's disconnection**, caught after it. `server/http/
 *     abort.ts` is the whole story, including the reproduction; the short version is that the
 *     production runtime closes a connection on which nothing has moved for ten seconds, which
 *     is less than the floor of several honest operations, and that the abort escaping as a
 *     500 was the error the owner saw on `/import/new`.
 *  3. **Security headers** on the way out, on every response including redirects and errors.
 *  4. **One JSON access line per request**, with the server's own duration in milliseconds —
 *     which is how the SSR budget is measured in production rather than guessed at.
 *
 * This file is server-only by construction: it is the entry the server bundle is built from and
 * nothing in the client graph can reach it. That is why the modules it pulls in may read the
 * environment freely, and why the rate limiter's state can be a module-level `Map`.
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import type { RequestHandler } from "@tanstack/react-start/server";
import type { Register } from "@tanstack/react-router";
import {
  CLIENT_CLOSED,
  clientClosedResponse,
  extendRequestTimeout,
  isClientAbort,
  requestTimeoutSeconds,
} from "#/server/http/abort.ts";
import { logAccess, logLevel } from "#/server/http/log.ts";
import {
  bucketFor,
  clientKey,
  consume,
  rateLimitConfig,
  tooManyRequests,
} from "#/server/http/rate-limit.ts";
import { withSecurityHeaders } from "#/server/http/security.ts";

const handler = createStartHandler(defaultStreamHandler);

/*
 * Read once, at module load.
 *
 * `serverEnv()` is deliberately *not* used: it validates `DATABASE_URL` and would make a
 * request handler refuse to load over a configuration problem it has nothing to do with. The
 * three values wanted here are booleans and integers with safe defaults, and a request path
 * that cannot fail is worth more than one that re-reads `process.env` on every request.
 */
const behindProxy = process.env["MM_BEHIND_PROXY"] === "1";
const limits = rateLimitConfig(process.env);
const level = logLevel(process.env);
const timeoutSeconds = requestTimeoutSeconds(process.env);

export type ServerEntry = { fetch: RequestHandler<Register> };

export default {
  async fetch(request: Request, options?: Parameters<RequestHandler<Register>>[1]) {
    const started = Date.now();
    const url = new URL(request.url);
    let response: Response;

    /*
     * Before anything else, because the ten seconds start when the connection does.
     *
     * A no-op on Node (`vite dev`), which has no such lever and no such timeout — which is
     * also why this bug was invisible in development and only ever bit in production.
     */
    extendRequestTimeout(request, timeoutSeconds);

    const bucket = bucketFor(request.method, url.pathname);
    if (bucket !== null) {
      const verdict = consume(bucket, clientKey(request.headers, behindProxy), limits);
      if (!verdict.allowed) {
        response = tooManyRequests(bucket, verdict);
        logAccess(level, {
          method: request.method,
          path: url.pathname,
          status: response.status,
          ms: Date.now() - started,
        });
        return withSecurityHeaders(response, { behindProxy });
      }
    }

    try {
      response = await handler(request, options as never);
    } catch (error) {
      /*
       * The client went away. That is not a 500, and it is not this server's fault.
       *
       * Rethrowing would reach Nitro's error handler, which answers 500 into a socket that is
       * already closed — so nobody reads it — and logs it at `error`, so it is counted against
       * the installation for ever. Answering `499` and logging at `info` records the same fact
       * without either consequence. Anything that is *not* a disconnection still throws: a bug
       * swallowed here would be a bug that never appears anywhere.
       */
      if (!isClientAbort(error, request)) throw error;
      logAccess(level, {
        method: request.method,
        path: url.pathname,
        status: CLIENT_CLOSED,
        ms: Date.now() - started,
      });
      return withSecurityHeaders(clientClosedResponse(), { behindProxy });
    }

    /*
     * The same fact, arriving by the other door.
     *
     * Nitro catches what escapes a route and answers 500 itself, so an abort does not always
     * reach the `catch` above — sometimes it has already been turned into a response by the
     * time we see it. The owner's production line is exactly that shape: `status: 500,
     * ms: 11316`, with the `AbortError` printed just above it by the framework's own handler.
     * A 5xx on a request whose signal is aborted is a disconnection whichever route it took.
     */
    if (response.status >= 500 && request.signal.aborted) {
      logAccess(level, {
        method: request.method,
        path: url.pathname,
        status: CLIENT_CLOSED,
        ms: Date.now() - started,
      });
      return withSecurityHeaders(clientClosedResponse(), { behindProxy });
    }

    logAccess(level, {
      method: request.method,
      path: url.pathname,
      status: response.status,
      ms: Date.now() - started,
    });
    return withSecurityHeaders(response, { behindProxy });
  },
} satisfies ServerEntry;
