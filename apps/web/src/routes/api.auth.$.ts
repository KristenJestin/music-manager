import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "#/server/auth/auth.ts";

/**
 * `/api/auth/*` — Better Auth's own endpoints (sign-in, sign-out, get-session).
 *
 * No component: a route with only `server.handlers` is an API endpoint. The path has to match
 * `basePath` in `server/auth/auth.ts`, and the splat has to be a bare `$` so that every
 * sub-path of the library reaches the handler rather than 404-ing on the router first.
 *
 * This is the one route besides `/health` that is not behind `requireSession`, for the
 * obvious reason: it is how you get a session.
 */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => (await getAuth()).handler(request),
      POST: async ({ request }: { request: Request }) => (await getAuth()).handler(request),
    },
  },
});
