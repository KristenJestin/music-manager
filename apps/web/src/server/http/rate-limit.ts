/**
 * Rate limiting on `/login` and `/api` (`docs/phases/P10-production.md` § Sécurité).
 *
 * Two buckets, because they defend against two different things:
 *
 *  - **`login`** — the credential endpoints of Better Auth (`/api/auth/sign-in/*`,
 *    `/api/auth/sign-up/*`, and the `/login` page's own form post). This installation has
 *    exactly one account and no lock-out; without a limit, a box on the open internet is one
 *    long password list away from being someone else's. Ten attempts per five minutes is
 *    generous for a human with a password manager and useless for a dictionary.
 *  - **`api`** — `/api/v1/**`, `/mcp` and the OpenAPI document. Better Auth's API-key plugin
 *    already caps a *key* at `KEY_RATE_LIMIT` (600/min), but that check happens after the key
 *    is looked up in the database, so an unauthenticated flood still costs a query each. This
 *    bucket is in front of it and needs nothing but a counter.
 *
 * `GET /api/auth/get-session` is deliberately **not** in the login bucket: the Console calls it
 * on every navigation, and counting it would sign the owner out for browsing.
 *
 * **What this is not.** It is an in-process counter, so it resets when the container restarts
 * and it is per-instance. `docs/06-stack.md` fixes the deployment at one web process, and the
 * thing being defended against is a script, not a botnet — a Redis-backed limiter would be a
 * second stateful service for a single-user application. `docs/deploy.md` says to put the
 * real limit in the reverse proxy for anything exposed to the internet, which is where a limit
 * that survives a restart belongs.
 *
 * This module has **no imports** and holds its state in a module-level `Map`, so it is
 * unit-testable with a fake clock and nothing else (`rate-limit.test.ts`).
 */

/** The two buckets. `null` means "not rate limited". */
export type Bucket = "login" | "api";

export interface BucketConfig {
  /** Requests allowed per window. `0` disables the bucket entirely. */
  readonly max: number;
  /** The window, in milliseconds. */
  readonly windowMs: number;
}

export interface RateLimitConfig {
  readonly login: BucketConfig;
  readonly api: BucketConfig;
}

/**
 * The defaults, and the shape `MM_RATE_LIMIT_LOGIN` / `MM_RATE_LIMIT_API` override.
 *
 * Both are read as "requests per window"; the windows themselves are not configurable, because
 * a limit expressed as one number is a limit an operator will actually set correctly.
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  login: { max: 10, windowMs: 5 * 60_000 },
  api: { max: 600, windowMs: 60_000 },
};

/** Read the two numbers off the environment, falling back to the defaults. */
export function rateLimitConfig(source: Record<string, string | undefined>): RateLimitConfig {
  const read = (name: string, fallback: number): number => {
    const raw = source[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    login: {
      max: read("MM_RATE_LIMIT_LOGIN", DEFAULT_RATE_LIMITS.login.max),
      windowMs: DEFAULT_RATE_LIMITS.login.windowMs,
    },
    api: {
      max: read("MM_RATE_LIMIT_API", DEFAULT_RATE_LIMITS.api.max),
      windowMs: DEFAULT_RATE_LIMITS.api.windowMs,
    },
  };
}

/**
 * Which bucket a request falls in, if any.
 *
 * Matching is on the path, not on the route table, because this runs before the router: the
 * point of a rate limit is to answer without doing any of the work.
 */
export function bucketFor(method: string, pathname: string): Bucket | null {
  const path = pathname.toLowerCase();
  if (path.startsWith("/api/auth/")) {
    // Session reads are what a logged-in Console does all day. Only the credential endpoints
    // — and anything that mints a token — belong in the strict bucket.
    if (path.startsWith("/api/auth/get-session")) return null;
    if (method === "GET" || method === "HEAD") return null;
    return "login";
  }
  if (path === "/login" && method === "POST") return "login";
  if (path.startsWith("/api/")) return "api";
  if (path === "/mcp" || path.startsWith("/mcp/")) return "api";
  return null;
}

/**
 * Who is asking.
 *
 * Behind a reverse proxy the peer address is the proxy, so the first entry of
 * `X-Forwarded-For` is the only thing that identifies a client — and it is trustworthy exactly
 * when `MM_BEHIND_PROXY=1` says something we control sets it. Directly exposed, this process
 * cannot see a peer address at all from a `Request`, so every caller shares one bucket. That
 * is a deliberate, documented weakness of the direct-exposure mode: it makes the limit a
 * global throttle rather than a per-client one, which still stops a password list and is why
 * `docs/deploy.md` tells you to put a proxy in front.
 */
export function clientKey(headers: Headers, behindProxy: boolean): string {
  if (!behindProxy) return "direct";
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.trim() !== "") {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (first !== "") return first;
  }
  const real = headers.get("x-real-ip");
  if (real !== null && real.trim() !== "") return real.trim();
  return "direct";
}

interface Window {
  count: number;
  /** When this window ends, in epoch milliseconds. */
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Stop the map growing without bound on a box that is being scanned. */
function prune(now: number): void {
  if (windows.size < 4096) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** The bucket's ceiling, for `RateLimit-Limit`. */
  readonly limit: number;
  /** What is left in this window, for `RateLimit-Remaining`. */
  readonly remaining: number;
  /** Seconds until the window rolls over, for `Retry-After`. */
  readonly resetSeconds: number;
}

/**
 * Count one request against a bucket and say whether it may proceed.
 *
 * A fixed window rather than a sliding one: a sliding window costs a timestamp list per client
 * to smooth a boundary effect that, at ten attempts per five minutes, means a determined
 * attacker gets twenty attempts across one boundary instead of ten. That is not the difference
 * between safe and unsafe here, and the memory is.
 */
export function consume(
  bucket: Bucket,
  key: string,
  config: RateLimitConfig,
  now: number = Date.now(),
): RateLimitVerdict {
  const { max, windowMs } = config[bucket];
  if (max === 0) {
    return { allowed: true, limit: 0, remaining: 0, resetSeconds: 0 };
  }
  prune(now);
  const id = `${bucket}:${key}`;
  const existing = windows.get(id);
  const window: Window =
    existing === undefined || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : existing;
  window.count += 1;
  windows.set(id, window);
  const resetSeconds = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  return {
    allowed: window.count <= max,
    limit: max,
    remaining: Math.max(0, max - window.count),
    resetSeconds,
  };
}

/** Test helper: forget every window. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * The 429.
 *
 * Same envelope as every other failure in this app — `{error: {code, message, hint, action}}`
 * with `RATE_LIMITED`, which the Console's error decoder and the CLI both already understand —
 * built by hand rather than through `MMError` so that this module keeps its "no imports"
 * property and can be reasoned about without loading the contracts package.
 */
export function tooManyRequests(bucket: Bucket, verdict: RateLimitVerdict): Response {
  const message =
    bucket === "login"
      ? "Too many sign-in attempts."
      : "Too many requests. Slow down and try again.";
  return Response.json(
    {
      error: {
        code: "RATE_LIMITED",
        message,
        hint: `Wait ${String(verdict.resetSeconds)} seconds. The limit is ${String(verdict.limit)} requests per window; MM_RATE_LIMIT_LOGIN and MM_RATE_LIMIT_API change it.`,
        action: "Wait and retry",
      },
    },
    {
      status: 429,
      headers: {
        "retry-after": String(verdict.resetSeconds),
        "ratelimit-limit": String(verdict.limit),
        "ratelimit-remaining": "0",
        "ratelimit-reset": String(verdict.resetSeconds),
        "cache-control": "no-store",
      },
    },
  );
}
