import { createFileRoute } from "@tanstack/react-router";
import { eventStream } from "#/server/services/events.ts";

/**
 * `GET /api/events?import=<id>` — the live job journal, as Server-Sent Events.
 *
 * SSE rather than a websocket (`docs/06-stack.md`): the traffic is one-way and a plain HTTP
 * response survives every proxy in the way. `curl -N` is a first-class client.
 *
 * `?since=<id>` and the standard `Last-Event-ID` header both replay from a known point, which
 * is what makes a reconnect lossless — the events are rows, and rows do not expire.
 *
 * No component: a route with only `server.handlers` is an API endpoint.
 */
export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        const importId = url.searchParams.get("import") ?? undefined;
        const header = request.headers.get("last-event-id");
        const since = Number.parseInt(url.searchParams.get("since") ?? header ?? "", 10);
        return eventStream({
          ...(importId === undefined ? {} : { importId }),
          ...(Number.isNaN(since) ? {} : { since }),
        });
      },
    },
  },
});
