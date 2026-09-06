/**
 * The browser half of Better Auth.
 *
 * Same origin as the app, so no `baseURL` is needed: the client posts to `/api/auth/*`, the
 * route in `routes/api.auth.$.ts` answers, and the cookie is set by the response itself. That
 * is why the login form calls this rather than a server function — one round trip, and the
 * cookie is written by the library's own `Set-Cookie` rather than forwarded by hand.
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
