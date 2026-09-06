/**
 * `/api/v1/events` — the job journal, as a stream and as a page.
 *
 * The stream is the *same* `eventStream()` the Console's `/api/events` serves. That is the
 * point: `docs/06-stack.md` chose SSE over a websocket precisely so that `curl -N` is a
 * first-class client, and P08's job is to put a scope check in front of it rather than to
 * invent a second transport with its own bugs.
 *
 * `?since=` and `Last-Event-ID` both replay from a known point, so a reconnect is lossless —
 * events are rows, and rows do not expire. `GET /events/history` is the same data without the
 * connection, for an agent that would rather poll than hold a socket.
 *
 * The stream is declared to OpenAPI as `text/event-stream`, which Scalar renders honestly
 * rather than pretending it is JSON.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { db } from "#/server/db/client.ts";
import { eventStream, readEvents } from "#/server/services/events.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import { errorSchema, eventSchema, listEventsQuery } from "#/server/api/schemas.ts";

const TAG = "events";

const FAILURES = {
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
} as const;

export function eventRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "Live job events (Server-Sent Events)",
      description:
        "Holds the connection open and writes one `data:` frame per event. Send " +
        "`Last-Event-ID` (or `?since=`) to resume without losing anything. Without either, " +
        "the stream starts *now* rather than replaying the whole journal.",
      middleware: [requireScope("imports:read")] as const,
      request: {
        query: z.object({
          import: z.string().optional().openapi({ description: "Only this import's events." }),
          since: z.coerce.number().int().min(0).optional(),
        }),
      },
      responses: {
        200: {
          content: { "text/event-stream": { schema: z.string() } },
          description: "An endless stream of `id:`/`event:`/`data:` frames",
        },
        ...FAILURES,
      },
    }),
    (c) => {
      const { import: importId, since } = c.req.valid("query");
      const header = c.req.header("last-event-id");
      const resume = since ?? (header === undefined ? undefined : Number.parseInt(header, 10));
      return eventStream(
        {
          ...(importId === undefined ? {} : { importId }),
          ...(resume === undefined || Number.isNaN(resume) ? {} : { since: resume }),
        },
        db(),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/history",
      tags: [TAG],
      summary: "Past job events, as one JSON page",
      description: "For a client that would rather poll than hold a connection open.",
      middleware: [requireScope("imports:read")] as const,
      request: { query: listEventsQuery },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ events: z.array(eventSchema) }) } },
          description: "The events",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { importId, since, limit } = c.req.valid("query");
      const events = await readEvents(
        {
          ...(importId === undefined ? {} : { importId }),
          ...(since === undefined ? {} : { since }),
          limit,
        },
        db(),
      );
      return c.json({ events }, 200);
    },
  );

  return app;
}
