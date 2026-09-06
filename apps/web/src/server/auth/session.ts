/**
 * `requireSession` — the one gate.
 *
 * `docs/phases/P06-web-coeur.md`: *toutes les routes et server functions sont protégées ;
 * `/health` reste public*. That is enforced in exactly two places and nowhere else:
 *
 *  - `authedFn` in `server/functions/base.ts`, which every server function is built from;
 *  - the `_app` route's `beforeLoad`, which redirects a browser to `/login`.
 *
 * A guard you have to remember to add is a guard you will forget to add, so the builder is
 * the only exported way to declare a server function in this app. The unauthenticated case
 * throws a real `MMError` with code `UNAUTHORIZED`, which the client turns into a redirect —
 * a server function must not answer "here is nothing" when the truth is "you are not logged
 * in", or a session that expired mid-session looks like an empty library.
 */
import { MMError } from "@mm/contracts";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "#/server/auth/auth.ts";

/** The half of Better Auth's session the app actually uses. */
export interface AppSession {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly expiresAt: string;
}

/** The current session, or `null`. Never throws for a missing session. */
export async function getSession(headers?: Headers): Promise<AppSession | null> {
  const auth = await getAuth();
  const requestHeaders = headers ?? (getRequestHeaders() as unknown as Headers);
  const found = await auth.api.getSession({ headers: requestHeaders });
  if (found === null) return null;
  return {
    userId: found.user.id,
    email: found.user.email,
    name: found.user.name,
    expiresAt: new Date(found.session.expiresAt).toISOString(),
  };
}

/** The current session, or a typed `UNAUTHORIZED` failure. */
export async function requireSession(headers?: Headers): Promise<AppSession> {
  const session = await getSession(headers);
  if (session === null) {
    throw new MMError("UNAUTHORIZED", "You are not signed in.", {
      hint: "Sign in at /login.",
      action: "Sign in",
      status: 401,
    });
  }
  return session;
}

/** True when the error is the one `requireSession` throws. Used by the client's redirect. */
export function isUnauthorized(error: unknown): boolean {
  if (error instanceof MMError) return error.code === "UNAUTHORIZED";
  if (error instanceof Error) return /UNAUTHORIZED/.test(error.message);
  return false;
}
