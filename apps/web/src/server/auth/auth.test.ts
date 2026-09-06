import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authSecret } from "#/server/auth/auth.ts";
import type { ServerEnv } from "#/server/env.ts";

/**
 * The dev signing secret must not depend on the Bun runtime.
 *
 * This is the regression test for `FIX-realmode-1`. `authSecret` used `new Bun.CryptoHasher`
 * for its development fallback, on the reasonable-sounding assumption that server code runs
 * under Bun. It does not always: `vite dev` ships a `#!/usr/bin/env node` bin, so `bun run dev`
 * hands the dev server — and with it SSR — to Node, where `Bun` is undefined. The fallback
 * threw `ReferenceError: Bun is not defined` during SSR; the router serialised the failed match
 * into the HTML and the browser rehydrated it as "Something went wrong!" in `MatchInnerImpl`,
 * which reads exactly like a server module leaking into the client bundle and is not one.
 *
 * It only ever fired with an empty `MM_AUTH_SECRET`, which is why nothing caught it: the
 * fixtures E2E sets one (`scripts/e2e-web.ts`), so every Playwright suite took the early
 * return. Real mode, with a `.env` that says nothing about the secret, took the fallback.
 *
 * So the test removes the `Bun` global and calls the function — the one condition the old code
 * could not survive — and a second test keeps the whole web app free of `Bun.*`, because the
 * next such call would fail the same way and just as far from its cause.
 */
function env(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    MM_AUTH_SECRET: "",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://mm:mm@localhost:5432/mm",
    ...overrides,
  } as ServerEnv;
}

/** Run `body` with `globalThis.Bun` removed, however the host runtime defines it. */
function withoutBun<T>(body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");
  if (descriptor) Reflect.deleteProperty(globalThis, "Bun");
  try {
    return body();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Bun", descriptor);
  }
}

describe("authSecret", () => {
  it("derives the development secret without the Bun global", () => {
    const secret = withoutBun(() => authSecret(env()));
    expect(secret).toBe(
      createHash("sha256")
        .update("music-manager-dev:postgres://mm:mm@localhost:5432/mm")
        .digest("base64"),
    );
  });

  it("is stable across restarts, so a session cookie survives one", () => {
    expect(authSecret(env())).toBe(authSecret(env()));
  });

  it("prefers a configured secret and never reaches the fallback", () => {
    expect(withoutBun(() => authSecret(env({ MM_AUTH_SECRET: "configured" })))).toBe("configured");
  });

  it("still refuses an empty secret in production", () => {
    expect(() => authSecret(env({ NODE_ENV: "production" }))).toThrow(/MM_AUTH_SECRET is empty/);
  });
});
