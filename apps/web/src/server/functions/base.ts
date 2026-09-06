/**
 * What every server function in this app is built from.
 *
 * `docs/phases/P06-web-coeur.md`: *toutes les routes et server functions sont protégées*. The
 * gate is `sessionMiddleware`, and `server/functions/functions.test.ts` is what stops it from
 * being forgotten — it walks every exported server function and asserts that calling it
 * without a session is refused.
 *
 * **`createServerFn` has to be called literally, at the top level of the module that exports
 * the function.** A helper that returned a pre-configured builder would read better and would
 * be silently catastrophic: the Vite plugin recognises `createServerFn(...).handler(...)`
 * *syntactically* in order to replace the handler with an RPC stub on the client, and a
 * wrapper it cannot see means the whole server module — Drizzle, `postgres`, Better Auth —
 * gets bundled into the browser. That failure looks like `Buffer is not defined`, three
 * layers away from its cause. So each function repeats the two lines, on purpose.
 */
import { createMiddleware } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { MMError } from "@mm/contracts";
import { isUnauthorized, requireSession, type AppSession } from "#/server/auth/session.ts";

/**
 * Output serialisation is not type-checked; input still is.
 *
 * Half of what the Console reads is a `jsonb` column — `imports.options`, `job_events.data`,
 * `inbox_items.payload` — whose TypeScript type is `Record<string, unknown>`. Those values are
 * JSON at runtime by construction (they came out of Postgres as JSON), but `unknown` cannot be
 * *proved* serialisable, so the strict output check rejects every payload that carries one.
 * Turning it off for outputs buys back the whole `jsonb` surface; turning it off for inputs
 * would buy nothing, because every input here is a zod schema, so inputs stay strict.
 */
export const STRICT = { output: false } as const;

/**
 * The session gate.
 *
 * Function middleware, so it runs on the server before any handler body, for every call —
 * including the ones a route loader makes during SSR.
 */
export const sessionMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    const session = await requireSession();
    return await next({ context: { session } });
  } catch (error) {
    /*
     * A missing session is a *navigation* problem, not a server error.
     *
     * The router understands a thrown `redirect` from a server function and follows it, so a
     * session that expires while a tab is open sends the next click to `/login` instead of
     * painting an error over a page that used to work. A raw `fetch` without a cookie gets the
     * redirect as a non-2xx response and still learns nothing — which is the property
     * `docs/phases/P06-web-coeur.md` asks for and `e2e/auth.spec.ts` checks.
     */
    if (isUnauthorized(error)) throw redirect({ to: "/login", search: { redirect: "/" } });
    throw error;
  }
});

export type { AppSession };

/**
 * Turn anything thrown inside a server function into the wire shape.
 *
 * A server function serialises a thrown `Error` as its message alone, which would lose the
 * code, the hint and the action — exactly the three things the Console's error decoder needs
 * in order to offer a button rather than a stack trace.
 */
export function toFailure(error: unknown): never {
  const failure = MMError.from(error);
  const wire = new Error(failure.message);
  Object.assign(wire, { mm: failure.toBody(), status: failure.status ?? 500 });
  throw wire;
}

/** The client side of `toFailure`: read the code back off a rejected server function. */
export function failureCode(error: unknown): string | null {
  if (error instanceof MMError) return error.code;
  const body = (error as { mm?: { code?: string } } | null)?.mm;
  return typeof body?.code === "string" ? body.code : null;
}
