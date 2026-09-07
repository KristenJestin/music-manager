/**
 * The request budget an API key gets, in one place.
 *
 * It lives in a module of its own, with no imports, for two reasons. `auth/auth.ts` configures
 * the plugin with it and `services/api-keys.ts` reports it, and those two already point at each
 * other — `api-keys` calls `getAuth()` — so a constant declared in either would close the
 * cycle. And the third test report's complaint was not that the limit is wrong but that it is
 * **invisible**: an agent told to "poll `get_import` until it is done" was cut off at 600 polls
 * and read it as a broken tool. A number nobody can read is a number that will be exceeded, so
 * `get_status` now reports it, and it must report the same one the plugin enforces.
 *
 * A key may override both with its own `rateLimitMax` / `rateLimitTimeWindow` columns; these
 * are the defaults every key issued by the Console gets.
 */
export const KEY_RATE_LIMIT = {
  /** Requests per window, against the library's default of ten per *day*. */
  maxRequests: 600,
  /** The window, in milliseconds. */
  timeWindowMs: 60_000,
} as const;

/**
 * A cadence that stays comfortably inside the budget, in milliseconds.
 *
 * Two seconds is 30 requests a minute — five per cent of the budget — which leaves room for
 * the other tools an agent calls while it waits. It is a *suggestion* carried in tool
 * descriptions, not something the server enforces.
 */
export const SUGGESTED_POLL_INTERVAL_MS = 2_000;
