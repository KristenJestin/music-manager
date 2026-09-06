/**
 * The one place this application talks to the outside world.
 *
 * Every source client of `docs/03-metadonnees.md` §4 goes through `getJson`, and that buys
 * four things no client has to re-implement:
 *
 *  - **a global limiter per source.** MusicBrainz allows one request per second *per client*,
 *    not per call site (§4). The limiter is therefore module-level and shared: ten concurrent
 *    lookups take ten seconds, whoever asked for them.
 *  - **retries with backoff** on 429 and 5xx, and on a transport failure. A 503 from
 *    MusicBrainz means "you were too fast", which is a wait, not a failure.
 *  - **structured errors**: an `MMError` with a source-specific code, so the Console's decoder
 *    renders a dead LRCLIB the same way it renders a dead toolbox.
 *  - **a request counter.** `mm doc rebuild --offline` must make zero outgoing calls, and the
 *    only honest way to assert that is to count them here, at the single door.
 *
 * `setFetch` swaps the transport for the recorded cassettes of `apps/web/test/cassettes/`,
 * which is what lets the integration tests exercise the real clients with no network at all.
 */
import { MMError } from "@mm/contracts";

/* ------------------------------------------------------------------ */
/* the door: one fetch, counted                                        */
/* ------------------------------------------------------------------ */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let transport: FetchLike = (url, init) => fetch(url, init);
let requests = 0;

/** Replace the transport (cassette player, recorder). Returns the previous one. */
export function setFetch(next: FetchLike): FetchLike {
  const previous = transport;
  transport = next;
  return previous;
}

/** Restore the real `fetch`. */
export function resetFetch(): void {
  transport = (url, init) => fetch(url, init);
}

/** How many outgoing requests this process has made since the last reset. */
export function requestCount(): number {
  return requests;
}

export function resetRequestCount(): void {
  requests = 0;
}

/** Run `body` and report how many outgoing requests it caused. */
export async function countingRequests<T>(
  body: () => Promise<T>,
): Promise<{ result: T; requests: number }> {
  const before = requests;
  const result = await body();
  return { result, requests: requests - before };
}

/* ------------------------------------------------------------------ */
/* the limiter                                                         */
/* ------------------------------------------------------------------ */

/**
 * A minimum interval between two departures, shared by every caller of one source.
 *
 * Reserving the slot *before* awaiting is what makes it correct under concurrency: ten calls
 * fired at once each take the next free instant, so they leave 0 s, 1 s, 2 s… apart instead
 * of all measuring "idle" and leaving together.
 */
export class RateLimiter {
  private nextFreeAt = 0;

  constructor(readonly minIntervalMs: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const departure = Math.max(now, this.nextFreeAt);
    this.nextFreeAt = departure + this.minIntervalMs;
    const wait = departure - now;
    if (wait > 0) await sleep(wait, signal);
  }

  /** Test helper: forget the reservations. */
  reset(): void {
    this.nextFreeAt = 0;
  }
}

const limiters = new Map<string, RateLimiter>();

/** The process-wide limiter for a source, created on first use. */
export function limiterFor(source: string, minIntervalMs: number): RateLimiter {
  const held = limiters.get(source);
  if (held !== undefined) return held;
  const made = new RateLimiter(minIntervalMs);
  limiters.set(source, made);
  return made;
}

/**
 * Test seam: pin a source's interval before anything uses it.
 *
 * `limiterFor` keeps the first limiter it made for a source, so pre-creating one with a
 * shorter interval is how the cassette suite replays eight MusicBrainz answers without
 * spending eight real seconds proving a rule the limiter's own test already proves.
 */
export function setLimiter(source: string, minIntervalMs: number): void {
  limiters.set(source, new RateLimiter(minIntervalMs));
}

/** Test helper: forget every limiter, so the next call rebuilds it at its real interval. */
export function resetLimiters(): void {
  limiters.clear();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* the request                                                         */
/* ------------------------------------------------------------------ */

export interface GetJsonOptions {
  /** The source name, for the limiter, the error message and the logs. */
  readonly source: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Total attempts, including the first. */
  readonly attempts?: number;
  readonly backoffBaseMs?: number;
  readonly minIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** `true` turns a 404 into `null` instead of an error — the Cover Art Archive case (§4). */
  readonly nullOn404?: boolean;
  /**
   * Form fields. Their presence makes the call a `POST` with
   * `application/x-www-form-urlencoded`, which is how AcoustID wants a fingerprint sent: a
   * Chromaprint is a couple of kilobytes and does not belong in a query string.
   */
  readonly form?: Readonly<Record<string, string>>;
  /** Injected in tests so a backoff does not cost real seconds. */
  readonly wait?: (ms: number) => Promise<void>;
}

export interface JsonResponse<T> {
  readonly data: T;
  readonly etag: string | null;
  readonly status: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1_000;

/**
 * GET a JSON document, with the limiter, the retries and the error shape.
 *
 * Returns `null` only when `nullOn404` is set and the source answered 404 — a release with no
 * cover art is a fact, not a failure.
 */
export async function getJson<T>(options: GetJsonOptions): Promise<JsonResponse<T> | null> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_MS;
  const wait = options.wait ?? ((ms: number) => sleep(ms, options.signal));
  const limiter =
    options.minIntervalMs === undefined || options.minIntervalMs <= 0
      ? null
      : limiterFor(options.source, options.minIntervalMs);

  let lastError: MMError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (limiter !== null) await limiter.acquire(options.signal);

    let response: Response;
    requests += 1;
    try {
      const form = options.form;
      response = await transport(options.url, {
        method: form === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
          ...options.headers,
        },
        ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new MMError(
        "SOURCE_UNREACHABLE",
        `${options.source} did not answer (${describe(error)}).`,
        {
          hint: "Check the network, or run with --offline to use only what is already cached.",
          action: "Retry later",
          details: { source: options.source, url: redact(options.url) },
          retryable: true,
          cause: error,
        },
      );
      if (attempt < attempts) await wait(backoffOf(backoffBase, attempt, null));
      continue;
    }

    if (response.status === 404 && options.nullOn404 === true) return null;

    if (response.ok) {
      const text = await response.text();
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch (error) {
        throw new MMError(
          "SOURCE_BAD_RESPONSE",
          `${options.source} answered with something that is not JSON.`,
          {
            hint: text.slice(0, 200),
            details: { source: options.source, url: redact(options.url) },
            status: response.status,
            cause: error,
          },
        );
      }
      return { data, etag: response.headers.get("etag"), status: response.status };
    }

    // The body of a refusal is the only place a source says *why* it refused. AcoustID
    // answers 400 both for "that fingerprint is nonsense" and for "that API key is wrong",
    // and dropping the body is what let the second hide behind the first (decision 052,
    // owner review B8). Truncated, because it is a diagnostic and not a payload.
    const body = await response.text().catch(() => "");
    const retryable = response.status === 429 || response.status >= 500;
    lastError = httpError(options.source, options.url, response.status, retryable, body);
    if (!retryable) throw lastError;
    if (attempt < attempts) {
      await wait(backoffOf(backoffBase, attempt, response.headers.get("retry-after")));
    }
  }

  throw (
    lastError ??
    new MMError("SOURCE_UNREACHABLE", `${options.source} did not answer.`, { retryable: true })
  );
}

/** Exponential, with the source's own `Retry-After` winning when it sends one. */
export function backoffOf(baseMs: number, attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  return Math.min(baseMs * 2 ** (attempt - 1), 30_000);
}

/** How much of a refusal's body travels with the error. Enough to read, not enough to log. */
const MAX_ERROR_BODY = 400;

function httpError(
  source: string,
  url: string,
  status: number,
  retryable: boolean,
  body = "",
): MMError {
  const code =
    status === 429
      ? "SOURCE_RATE_LIMITED"
      : status >= 500
        ? "SOURCE_UNAVAILABLE"
        : status === 404
          ? "SOURCE_NOT_FOUND"
          : "SOURCE_HTTP";
  return new MMError(code, `${source} answered HTTP ${String(status)}.`, {
    hint:
      status === 429
        ? "The source is asking us to slow down; the limiter will space the next calls."
        : status === 404
          ? "The identifier may be wrong, or the source simply has nothing for it."
          : "The source is having trouble; this is usually temporary.",
    action: status >= 500 || status === 429 ? "Retry later" : undefined,
    details: {
      source,
      url: redact(url),
      status,
      ...(body === "" ? {} : { body: body.slice(0, MAX_ERROR_BODY) }),
    },
    status,
    retryable,
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === "" ? error.message : error.name;
  return String(error);
}

/**
 * Never let an API key reach a log, an event row or a report. Query parameters whose name
 * looks like a credential are replaced before the URL is stored anywhere.
 */
export function redact(url: string): string {
  return url.replace(
    /([?&](?:client|api_key|apikey|key|token|api-key)=)[^&]*/gi,
    (_match, prefix: string) => `${prefix}<redacted>`,
  );
}
