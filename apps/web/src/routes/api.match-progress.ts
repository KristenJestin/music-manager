import { createFileRoute } from "@tanstack/react-router";
import { getSession } from "#/server/auth/session.ts";
import { progressStream } from "#/server/services/match-progress.ts";

/**
 * `GET /api/match-progress?import=<id>` — what step 2 of the wizard is doing, live.
 *
 * Separate from `/api/events` on purpose: that one streams the **journal**, which is rows in
 * `job_events` kept for ever, and the ten seconds a wizard screen spends asking MusicBrainz is
 * not a thing an import did. See `server/services/match-progress.ts`.
 *
 * No component: a route with only `server.handlers` is an API endpoint.
 */
export const Route = createFileRoute("/api/match-progress")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await getSession(request.headers);
        if (session === null) return new Response("unauthorized", { status: 401 });
        const importId = new URL(request.url).searchParams.get("import") ?? "";
        if (importId === "") return new Response("import id required", { status: 400 });
        return progressStream(importId);
      },
    },
  },
});
