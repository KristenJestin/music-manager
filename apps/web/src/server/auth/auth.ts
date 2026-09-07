/**
 * Authentication (`docs/06-stack.md`, `docs/phases/P06-web-coeur.md`).
 *
 * Better Auth over the Drizzle adapter, email + password, **one account**. This is a
 * self-hosted, single-user application: there is no registration page, no password reset by
 * email, no social login. The administrator is created once from the environment (or from
 * `/setup` when the environment says nothing), and `disableSignUp` closes the public sign-up
 * endpoint behind it — otherwise anyone who can reach the port could add themselves an
 * account, which would make every other protection here decorative.
 *
 * Three deliberate choices:
 *
 *  - **`tanstackStartCookies()` is last in `plugins`.** It is what turns the `Set-Cookie`
 *    headers of a server-side `auth.api.*` call into real cookies on the outgoing response.
 *    The plugin itself warns when it is not last, because a plugin registered after it never
 *    gets its cookies flushed.
 *  - **The instance is lazy.** Building it opens a database handle and reads settings; a unit
 *    test or `tsc` that merely imports a module that mentions `auth` must not need Postgres.
 *  - **`trustedOrigins` comes from `settings`.** A reverse proxy in front of this app changes
 *    the origin the browser sends, and that is an operational fact, not a build-time one —
 *    so it lives where the rest of the operational facts live and is read at boot.
 */
import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db as defaultDb, schema, type Database } from "#/server/db/client.ts";
import { serverEnv } from "#/server/env.ts";
import { KEY_RATE_LIMIT } from "#/server/auth/key-rate-limit.ts";

/** The cookie prefix. Named so two Music Managers on one host do not fight over a cookie. */
export const COOKIE_PREFIX = "mm";

/**
 * The signing secret.
 *
 * In production an empty secret is fatal: sessions would be signed with a value published in
 * the library's own source. In development we would rather not force everyone to invent one,
 * so the database URL — which is already a local secret and is stable across restarts — is
 * hashed into a usable key, and the fact is announced once.
 *
 * **The hash comes from `node:crypto`, not `Bun.CryptoHasher`.** This module is server code,
 * but "server" here is not always the Bun runtime: `vite dev` ships a `#!/usr/bin/env node`
 * bin, so `bun run dev` hands the dev server — and therefore SSR — to Node. Under Node the
 * `Bun` global does not exist, and the fallback below is the only branch that ever touched it.
 * Reaching it threw `Bun is not defined` *during SSR*, which the router serialised into the
 * HTML and the browser rehydrated as "Something went wrong!" in `MatchInnerImpl` — an error
 * that looked like a client bundle leak and was not one. It only ever fired with an empty
 * `MM_AUTH_SECRET`, which is why the fixtures E2E (`scripts/e2e-web.ts`, which sets one)
 * never caught it. `server/auth/auth.test.ts` pins the runtime-independence.
 */
export function authSecret(env = serverEnv()): string {
  if (env.MM_AUTH_SECRET !== "") return env.MM_AUTH_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "MM_AUTH_SECRET is empty. Set it (`openssl rand -base64 32`) before running in production.",
    );
  }
  return createHash("sha256").update(`music-manager-dev:${env.DATABASE_URL}`).digest("base64");
}

export interface AuthOptions {
  readonly db?: Database;
  /** Extra origins the browser may present. Read from `settings` by `getAuth()`. */
  readonly trustedOrigins?: readonly string[];
  /**
   * Build the **bootstrap** instance: sign-up open, auto sign-in off, no cookie plugin.
   *
   * Only `bootstrap.ts` uses it, and it is never mounted on a route. The three go together on
   * purpose — an instance that may create users must not also be able to sign one in or write
   * a cookie, or creating the administrator hands a session to whoever happened to make the
   * request that triggered it.
   */
  readonly allowSignUp?: boolean;
}

/** Build an instance. Exported so a test can build one against its own database. */
export function buildAuth(options: AuthOptions = {}) {
  const env = serverEnv();
  const database = options.db ?? defaultDb();
  const secure = env.NODE_ENV === "production" || env.MM_BEHIND_PROXY;

  return betterAuth({
    appName: "Music Manager",
    baseURL: env.MM_WEB_URL,
    basePath: "/api/auth",
    secret: authSecret(env),

    database: drizzleAdapter(database, { provider: "pg", schema }),

    emailAndPassword: {
      enabled: true,
      // The administrator is bootstrapped, never self-registered. See `bootstrap.ts`.
      disableSignUp: options.allowSignUp !== true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      /*
       * The bootstrap instance must not sign anybody in.
       *
       * `ensureAdmin()` runs inside whatever HTTP request happened to be the first one this
       * process served — a browser asking for `/`. With `autoSignIn` on and the cookie plugin
       * attached, creating the administrator issues a session and the plugin writes it onto
       * *that response*: the first visitor to a fresh installation would be silently signed in
       * as the administrator, without ever seeing the login page. The e2e suite caught exactly
       * that. So the bootstrap instance creates the row and nothing else; `/setup` signs in
       * afterwards, deliberately, through the client.
       */
      autoSignIn: options.allowSignUp !== true,
      requireEmailVerification: false,
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },

    trustedOrigins: [env.MM_WEB_URL, ...(options.trustedOrigins ?? [])],

    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // Behind a proxy this process speaks plain HTTP while the browser speaks HTTPS, so
      // "am I on https?" cannot be answered by looking at the request.
      useSecureCookies: secure,
      trustedProxyHeaders: env.MM_BEHIND_PROXY,
    },

    /*
     * Must stay last: it is what writes the cookies of a server-side call.
     *
     * And it is deliberately **absent** from the bootstrap instance. That instance exists only
     * to insert a user row from the environment; giving it the power to set cookies on the
     * ambient response is the whole of the bug described above, and removing the plugin makes
     * that impossible rather than merely unlikely.
     */
    plugins: options.allowSignUp === true ? [] : [apiKeyPlugin(), tanstackStartCookies()],
  });
}

/**
 * The `apiKey` plugin (`docs/phases/P08-api-agents.md` § Clés d'API).
 *
 * In 1.7 this left the core package: it is `@better-auth/api-key`, version-locked to
 * `better-auth` itself. `better-auth/plugins` has no `apiKey` export, and an import from
 * there does not merely fail at runtime — it fails to compile, which is the good outcome.
 *
 * The four settings that are not defaults, and why:
 *
 *  - **`defaultPrefix: "mm_"`.** A leaked key should be greppable and self-identifying, and
 *    `start` (the first six characters, prefix included) is what the Settings table shows in
 *    place of a secret it cannot show.
 *  - **`rateLimit.maxRequests: 600` per minute**, against a default of *ten per day*. That
 *    default is sized for a public SaaS handing keys to strangers; here the caller is the
 *    owner's own agent walking their own library, and ten requests a day would make the CLI
 *    unusable before it finished one import. It is still a ceiling: a runaway loop is capped
 *    rather than allowed to hammer MusicBrainz through us.
 *  - **`keyExpiration.minExpiresIn: 1` day, `maxExpiresIn: 3650` days.** The library's own
 *    ceiling is one year, which would force a self-hosted installation to re-issue a key
 *    annually for no threat it actually faces. "Never expires" stays available (`expiresIn:
 *    null`) and is the default the Settings form offers.
 *  - **`enableMetadata: true`**, because the wildcard scope is stored there: `permissions`
 *    holds the ten expanded `resource:action` pairs the plugin needs to reason about, and
 *    the metadata remembers that the user asked for `*`, so the table can say so.
 *
 * `enableSessionForAPIKeys` stays **off**. It would let an `x-api-key` header mint an ambient
 * session for *every* endpoint in the app, including `/api/auth/*` and the server functions —
 * which would silently promote a `library:read` key to a full Console login. Scope checking
 * happens in `server/api/auth.ts` instead, where it can see which scope the route needs.
 */
function apiKeyPlugin() {
  return apiKey({
    defaultPrefix: "mm_",
    defaultKeyLength: 48,
    requireName: true,
    enableMetadata: true,
    enableSessionForAPIKeys: false,
    startingCharactersConfig: { shouldStore: true, charactersLength: 9 },
    rateLimit: {
      enabled: true,
      timeWindow: KEY_RATE_LIMIT.timeWindowMs,
      maxRequests: KEY_RATE_LIMIT.maxRequests,
    },
    keyExpiration: {
      defaultExpiresIn: null,
      disableCustomExpiresTime: false,
      minExpiresIn: 1,
      maxExpiresIn: 3650,
    },
  });
}

export type Auth = ReturnType<typeof buildAuth>;

let cached: Auth | undefined;
let cachedPromise: Promise<Auth> | undefined;

/**
 * The process-wide instance, built on first use with the trusted origins from `settings`.
 *
 * Concurrent callers share one build — the first request of a cold server is several server
 * functions at once, and building four Better Auth instances in parallel would be four
 * schema validations against the same database.
 */
export async function getAuth(): Promise<Auth> {
  if (cached !== undefined) return cached;
  cachedPromise ??= (async () => {
    const { loadTrustedOrigins } = await import("#/server/auth/origins.ts");
    const built = buildAuth({ trustedOrigins: await loadTrustedOrigins() });
    cached = built;
    return built;
  })();
  return await cachedPromise;
}

/** Test helper: forget the cached instance. */
export function resetAuth(): void {
  cached = undefined;
  cachedPromise = undefined;
}
