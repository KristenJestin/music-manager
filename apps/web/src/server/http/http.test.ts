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
