/**
 * The three cross-cutting concerns of the server entry, tested where they are pure.
 *
 * `src/server-entry.ts` itself is deliberately not exercised here: it is the module the server
 * bundle is *built from*, importing it would boot the router, and everything it does that could
 * be wrong is one of the functions below. What the entry contributes is the order — limit,
 * handle, log, headers — and that is three lines of glue.
 */
import { afterEach, describe, expect, it } from "vitest";
import { securityHeaders, withSecurityHeaders } from "#/server/http/security.ts";
import {
  bucketFor,
  clientKey,
  consume,
  DEFAULT_RATE_LIMITS,
  rateLimitConfig,
  resetRateLimits,
  tooManyRequests,
} from "#/server/http/rate-limit.ts";
import { accessLine, enabled, levelFor, logLevel } from "#/server/http/log.ts";
import {
  CLIENT_CLOSED,
  DEFAULT_REQUEST_TIMEOUT_S,
  extendRequestTimeout,
  isClientAbort,
  requestTimeoutSeconds,
} from "#/server/http/abort.ts";

afterEach(() => {
  resetRateLimits();
});

describe("securityHeaders", () => {
  it("forbids framing, sniffing and eval, in both directions", () => {
    const headers = securityHeaders({ behindProxy: false });
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
  });

  it("lets the player reach Deezer's preview CDN, and nothing wider", () => {
    // The Discover preview is a signed MP3 on `cdnt-preview.dzcdn.net`, streamed straight by
    // the `<audio>` element. Without the host in `media-src`, Chromium refuses the load before
    // opening a socket — `MediaError.code = 4`, "Media load rejected by URL safety check" —
    // which the Console could only report as "the clip link expired". It had not.
    const csp = securityHeaders({ behindProxy: false })["content-security-policy"] ?? "";
    const mediaSrc = csp.split("; ").find((directive) => directive.startsWith("media-src "));
    expect(mediaSrc).toBe("media-src 'self' data: blob: https://*.dzcdn.net");
    // Narrower than `img-src`: a bare `https:` here would let any host supply audio.
    expect(mediaSrc).not.toContain(" https:;");
    expect(mediaSrc?.endsWith(" https:")).toBe(false);
  });

  it("keeps HSTS for the one case where it is not a foot-gun", () => {
    // On plain HTTP a browser ignores it; on `http://localhost` a browser that did *not*
    // ignore it would pin the developer's machine to a scheme it does not speak.
    expect(securityHeaders({ behindProxy: false })["strict-transport-security"]).toBeUndefined();
    expect(securityHeaders({ behindProxy: true })["strict-transport-security"]).toContain(
      "max-age=31536000",
    );
  });

  it("never overwrites a header the handler chose itself", () => {
    const response = new Response("x", { headers: { "referrer-policy": "no-referrer" } });
    expect(
      withSecurityHeaders(response, { behindProxy: false }).headers.get("referrer-policy"),
    ).toBe("no-referrer");
  });

  it("still decorates a redirect, whose headers are immutable", () => {
    // `Response.redirect()` returns an immutable-headers response, and `headers.set()` on one
    // throws. That is exactly how the Console answers an unauthenticated browser, so it is the
    // one response that must not lose its headers.
    const redirected = withSecurityHeaders(Response.redirect("https://example.test/login", 302), {
      behindProxy: true,
    });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe("https://example.test/login");
    expect(redirected.headers.get("x-frame-options")).toBe("DENY");
    expect(redirected.headers.get("strict-transport-security")).not.toBeNull();
  });
});

describe("bucketFor", () => {
  it("puts the credential endpoints in the strict bucket", () => {
    expect(bucketFor("POST", "/api/auth/sign-in/email")).toBe("login");
    expect(bucketFor("POST", "/api/auth/sign-up/email")).toBe("login");
    expect(bucketFor("POST", "/login")).toBe("login");
  });

  it("leaves session reads alone, because the Console makes one per navigation", () => {
    expect(bucketFor("GET", "/api/auth/get-session")).toBeNull();
    expect(bucketFor("GET", "/api/auth/anything")).toBeNull();
  });

  it("throttles the agent surface and nothing else", () => {
    expect(bucketFor("GET", "/api/v1/imports")).toBe("api");
    expect(bucketFor("POST", "/mcp")).toBe("api");
    expect(bucketFor("GET", "/api/openapi.json")).toBe("api");
    expect(bucketFor("GET", "/health")).toBeNull();
    expect(bucketFor("GET", "/library")).toBeNull();
    expect(bucketFor("GET", "/_build/assets/app.js")).toBeNull();
  });
});

describe("consume", () => {
  it("allows exactly the ceiling and refuses the next one", () => {
    const config = { login: { max: 3, windowMs: 1000 }, api: DEFAULT_RATE_LIMITS.api };
    const at = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(consume("login", "1.2.3.4", config, at).allowed).toBe(true);
    }
    const refused = consume("login", "1.2.3.4", config, at);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.resetSeconds).toBe(1);
  });

  it("counts each client separately", () => {
    const config = { login: { max: 1, windowMs: 1000 }, api: DEFAULT_RATE_LIMITS.api };
    expect(consume("login", "a", config, 0).allowed).toBe(true);
    expect(consume("login", "a", config, 0).allowed).toBe(false);
    expect(consume("login", "b", config, 0).allowed).toBe(true);
  });

  it("forgets the window once it has passed", () => {
    const config = { login: { max: 1, windowMs: 1000 }, api: DEFAULT_RATE_LIMITS.api };
    expect(consume("login", "a", config, 0).allowed).toBe(true);
    expect(consume("login", "a", config, 500).allowed).toBe(false);
    expect(consume("login", "a", config, 1500).allowed).toBe(true);
  });

  it("is off entirely when the ceiling is zero", () => {
    const config = { login: { max: 0, windowMs: 1000 }, api: DEFAULT_RATE_LIMITS.api };
    for (let i = 0; i < 50; i += 1) {
      expect(consume("login", "a", config, 0).allowed).toBe(true);
    }
  });
});

describe("rateLimitConfig", () => {
  it("defaults, and takes an override only when it is a number", () => {
    expect(rateLimitConfig({})).toEqual(DEFAULT_RATE_LIMITS);
    expect(rateLimitConfig({ MM_RATE_LIMIT_LOGIN: "3" }).login.max).toBe(3);
    expect(rateLimitConfig({ MM_RATE_LIMIT_LOGIN: "0" }).login.max).toBe(0);
    expect(rateLimitConfig({ MM_RATE_LIMIT_API: "not a number" }).api.max).toBe(
      DEFAULT_RATE_LIMITS.api.max,
    );
  });
});

describe("clientKey", () => {
  it("believes X-Forwarded-For only when told a proxy sets it", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientKey(headers, true)).toBe("203.0.113.7");
    // Directly exposed, the header is attacker-controlled: believing it would let one client
    // mint a fresh bucket per request, which is worse than having no per-client bucket at all.
    expect(clientKey(headers, false)).toBe("direct");
  });

  it("falls back to X-Real-IP, then to one shared bucket", () => {
    expect(clientKey(new Headers({ "x-real-ip": "198.51.100.4" }), true)).toBe("198.51.100.4");
    expect(clientKey(new Headers(), true)).toBe("direct");
  });
});

describe("tooManyRequests", () => {
  it("answers in the app's own error envelope, with Retry-After", async () => {
    const response = tooManyRequests("login", {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetSeconds: 42,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    const body = (await response.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.hint).toContain("42");
  });
});

describe("the access log", () => {
  it("is one JSON object per line, with the server's own duration", () => {
    const line = accessLine(
      { method: "GET", path: "/imports", status: 200, ms: 87 },
      new Date("2026-09-07T12:00:00.000Z"),
    );
    expect(JSON.parse(line)).toEqual({
      at: "2026-09-07T12:00:00.000Z",
      source: "web",
      level: "info",
      msg: "request",
      method: "GET",
      path: "/imports",
      status: 200,
      ms: 87,
    });
  });

  it("raises a failure above the configured floor and drops build assets below it", () => {
    expect(levelFor({ method: "GET", path: "/x", status: 500, ms: 1 })).toBe("error");
    expect(levelFor({ method: "GET", path: "/x", status: 404, ms: 1 })).toBe("warn");
    expect(levelFor({ method: "GET", path: "/_build/a.js", status: 200, ms: 1 })).toBe("debug");
  });

  it("reads MM_LOG_LEVEL, and treats nonsense as info", () => {
    expect(logLevel({ MM_LOG_LEVEL: "debug" })).toBe("debug");
    expect(logLevel({ MM_LOG_LEVEL: "LOUD" })).toBe("info");
    expect(logLevel({})).toBe("info");
    expect(enabled("warn", "info")).toBe(false);
    expect(enabled("warn", "error")).toBe(true);
    expect(enabled("silent", "error")).toBe(false);
  });
});

/*
 * ------------------------------------------------------------------
 * the client that went away
 * ------------------------------------------------------------------
 *
 * `server/http/abort.ts` carries the reproduction; these are the decisions it encodes. The
 * entry itself is still not imported here — what it contributes is the order, and every
 * judgement it makes is one of the four functions below.
 */
describe("isClientAbort", () => {
  it("believes the request's own signal before anything else", () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/x", { signal: controller.signal });
    expect(isClientAbort(new Error("anything"), request)).toBe(false);
    controller.abort();
    // Not a string match: the signal is what Bun flips when it reclaims the connection, and it
    // is true even when the error that surfaced says nothing about aborting.
    expect(isClientAbort(new Error("anything"), request)).toBe(true);
  });

  it("recognises what Bun throws when a handler writes to a closed socket", () => {
    // The exact shape out of the owner's production log: a DOMException, code 20, with the
    // message Bun uses. Reconstructed rather than provoked, so the test costs no seconds.
    const domException = Object.assign(new Error("The connection was closed."), {
      name: "AbortError",
      code: 20,
    });
    expect(isClientAbort(domException)).toBe(true);
  });

  it("recognises Node's family of the same event", () => {
    expect(isClientAbort(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(
      true,
    );
    expect(isClientAbort(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isClientAbort(Object.assign(new Error("gone"), { code: "ABORT_ERR" }))).toBe(true);
    expect(isClientAbort(new Error("socket hang up"))).toBe(true);
  });

  it("follows a cause chain, because an abort is usually rethrown wrapped", () => {
    const wrapped = new Error("Failed to render the route", {
      cause: Object.assign(new Error("The connection was closed."), { name: "AbortError" }),
    });
    expect(isClientAbort(wrapped)).toBe(true);
  });

  it("does not mistake a real failure for a disconnection", () => {
    // The cost of a false positive is a genuine 500 filed at `info` and never noticed.
    expect(isClientAbort(new TypeError("x is not a function"))).toBe(false);
    expect(isClientAbort(new Error("Invariant failed"))).toBe(false);
    expect(isClientAbort(new Error("musicbrainz answered HTTP 503"))).toBe(false);
    expect(isClientAbort(null)).toBe(false);
    expect(isClientAbort(undefined)).toBe(false);
    expect(isClientAbort("the connection was closed")).toBe(false);
  });
});

describe("the request timeout", () => {
  it("defaults to four minutes, well above Bun's ten-second idle default", () => {
    expect(requestTimeoutSeconds({})).toBe(DEFAULT_REQUEST_TIMEOUT_S);
    expect(DEFAULT_REQUEST_TIMEOUT_S).toBeGreaterThan(10);
  });

  it("reads MM_REQUEST_TIMEOUT_S, and refuses what Bun would silently clamp", () => {
    expect(requestTimeoutSeconds({ MM_REQUEST_TIMEOUT_S: "30" })).toBe(30);
    expect(requestTimeoutSeconds({ MM_REQUEST_TIMEOUT_S: " 90 " })).toBe(90);
    // Above Bun's 255 s ceiling, zero, negative and nonsense all fall back rather than throw:
    // the request path must not be where a typo in `.env` first shows up.
    expect(requestTimeoutSeconds({ MM_REQUEST_TIMEOUT_S: "900" })).toBe(DEFAULT_REQUEST_TIMEOUT_S);
    expect(requestTimeoutSeconds({ MM_REQUEST_TIMEOUT_S: "0" })).toBe(DEFAULT_REQUEST_TIMEOUT_S);
    expect(requestTimeoutSeconds({ MM_REQUEST_TIMEOUT_S: "-1" })).toBe(DEFAULT_REQUEST_TIMEOUT_S);
    expect(requestTimeoutSeconds({ MM_REQUEST_TIMEOUT_S: "soon" })).toBe(DEFAULT_REQUEST_TIMEOUT_S);
  });

  it("raises the ceiling through srvx's handle, and says nothing on a runtime without one", () => {
    const calls: { seconds: number }[] = [];
    const onBun = Object.assign(new Request("http://localhost/x"), {
      runtime: {
        bun: {
          server: {
            timeout: (_request: Request, seconds: number) => {
              calls.push({ seconds });
            },
          },
        },
      },
    });
    expect(extendRequestTimeout(onBun, 240)).toBe(true);
    expect(calls).toEqual([{ seconds: 240 }]);

    // Node under `vite dev` has no such lever, and that is not a failure — it also has no
    // ten-second idle timeout, which is why this bug never appeared in development.
    expect(extendRequestTimeout(new Request("http://localhost/x"), 240)).toBe(false);
  });

  it("never lets a failure to raise the ceiling become an error of its own", () => {
    const hostile = Object.assign(new Request("http://localhost/x"), {
      runtime: {
        bun: {
          server: {
            timeout: () => {
              throw new Error("no");
            },
          },
        },
      },
    });
    expect(extendRequestTimeout(hostile, 240)).toBe(false);
  });
});

describe("a disconnection in the access log", () => {
  it("is info, not error — a client that hung up is not this server's error rate", () => {
    expect(
      levelFor({ method: "GET", path: "/_serverFn/abc", status: CLIENT_CLOSED, ms: 11316 }),
    ).toBe("info");
    // …and it is still a line, because it is how an operator sees that something is slow.
    const line = accessLine(
      { method: "GET", path: "/_serverFn/abc", status: CLIENT_CLOSED, ms: 11316 },
      new Date("2026-09-17T12:00:00.000Z"),
    );
    expect(JSON.parse(line)).toMatchObject({ level: "info", status: 499, ms: 11316 });
  });
});
