import { createFileRoute } from "@tanstack/react-router";
import { api } from "#/server/api/app.ts";

/**
 * `/api/v1/*` — the Hono application, mounted on one server route.
 *
 * No component: a route with only `server.handlers` is an API endpoint. The splat has to be a
 * bare `$` so that every sub-path reaches Hono rather than 404-ing on the router first, which
 * is the same reason `api.auth.$.ts` is spelled that way.
 *
 * Every verb is listed explicitly because TanStack Start dispatches on the method: an omitted
 * `PATCH` would 405 before Hono ever saw it, and `PATCH /api/v1/settings` is a real route.
 *
 * Authentication is **not** done here. It is per-route inside Hono, because the scope a route
 * needs is a property of that route — a blanket middleware could only ask "are you anyone?",
 * which is exactly the check that makes a `library:read` key able to change settings.
 */
const handle = async ({ request }: { request: Request }): Promise<Response> =>
  await api().fetch(request);

export const Route = createFileRoute("/api/v1/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PATCH: handle,
      PUT: handle,
      DELETE: handle,
      OPTIONS: handle,
    },
  },
});
