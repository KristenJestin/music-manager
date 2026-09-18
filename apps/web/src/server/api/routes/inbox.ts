/**
 * `/api/v1/inbox` — the questions the pipeline is waiting on.
 *
 * The Inbox is the whole reason an agent can drive this app rather than merely watch it: a
 * blocked import is a *question with a preselected answer*, and `POST /{id}/resolve` with
 * `{"accept": true}` is "yes, the one you picked". That is the same act the Console performs
 * when you press Accept and the same one `mm inbox resolve --accept` performs, so all three
 * record an identical `decisions` row and differ only in `decidedBy`.
 *
 * Resolving an item re-queues the import it was blocking. Without that the pipeline would sit
 * still after a correct answer, which looks exactly like the answer not having been recorded.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import type { InboxItem, InboxStatus, InboxType } from "#/server/db/schema/index.ts";
import {
  getInboxItem,
  listInbox,
  resolveInboxBatch,
  resolveInboxItem,
} from "#/server/services/inbox.ts";
import { offersUntaggedImport, UNTAGGED_RESOLUTION } from "#/server/services/inbox.resolution.ts";
import { enqueue } from "#/server/services/queue.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import {
  errorSchema,
  idParam,
  inboxItemSchema,
  resolveBatchSchema,
  resolveInboxSchema,
} from "#/server/api/schemas.ts";

const TAG = "inbox";

const FAILURES = {
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "No such item" },
} as const;

function toItem(item: InboxItem): z.infer<typeof inboxItemSchema> {
  return {
    id: item.id,
    importId: item.importId,
    type: item.type,
    status: item.status,
    title: item.title,
    detail: item.summary,
    payload: item.payload,
    preselected: item.preselected,
    createdAt: item.createdAt.toISOString(),
  };
}

export function inboxRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "List Inbox items",
      middleware: [requireScope("review:read")] as const,
      request: {
        query: z.object({
          status: z.enum(["open", "resolved", "dismissed", "all"]).default("open"),
          importId: z.string().optional(),
          type: z.string().optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ items: z.array(inboxItemSchema) }) },
          },
          description: "The items",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { status, importId, type } = c.req.valid("query");
      const items = await listInbox(
        {
          ...(status === "all" ? {} : { status: status as InboxStatus }),
          ...(importId === undefined ? {} : { importId }),
          ...(type === undefined ? {} : { type: type as InboxType }),
        },
        db(),
      );
      return c.json({ items: items.map(toItem) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: [TAG],
      summary: "One Inbox item, with its payload and its preselected answer",
      middleware: [requireScope("review:read")] as const,
      request: { params: z.object({ id: idParam }) },
      responses: {
        200: {
          content: { "application/json": { schema: inboxItemSchema } },
          description: "The item",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const item = await getInboxItem(c.req.valid("param").id, db());
      if (item === null) throw notFound(c.req.valid("param").id);
      return c.json(toItem(item), 200);
    },
  );

  /* ---- the batch: several answers, one restart per import ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/resolve",
      tags: [TAG],
      summary: "Answer several Inbox items and restart each import once",
      description:
        "Say which items with exactly one of `itemIds` or `importId` (`type` narrows an " +
        "`importId` batch to one kind of question). Every item is answered first, and each " +
        "affected import is re-queued **once** at the end.\n\n" +
        "This exists because answering thirteen fingerprint mismatches through " +
        "`POST /{id}/resolve` was thirteen requests *and* thirteen restarts of the same job, " +
        "each racing the one before it. An item that cannot be answered comes back in " +
        "`failed`; it does not undo the ones that were.\n\n" +
        "**`untaggedFallback: true`** answers every item in the set with *import it from the " +
        "source's own tags* instead of its preselection — the batch form of the review card's " +
        "way out of a record MusicBrainz has never published. It is the answer to reach for " +
        "over a set of `ambiguous_release` items the search found nothing for, where " +
        "`accept: true` refuses each one: their preselection is *cancel*, and an acceptance " +
        "that names no release is not an answer. Any item it does not apply to comes back in " +
        "`failed` rather than having the flag set on its import.",
      middleware: [requireScope("review:write")] as const,
      request: {
        body: { content: { "application/json": { schema: resolveBatchSchema } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                resolved: z.array(
                  z.object({
                    id: z.string(),
                    status: z.string(),
                    importId: z.string().nullable(),
                  }),
                ),
                failed: z.array(z.object({ id: z.string(), message: z.string() })),
                resumed: z.array(z.string()),
              }),
            },
          },
          description: "Answered",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const outcome = await resolveInboxBatch(
        {
          ...(body.itemIds === undefined ? {} : { itemIds: body.itemIds }),
          ...(body.importId === undefined ? {} : { importId: body.importId }),
          ...(body.type === undefined ? {} : { type: body.type as InboxType }),
        },
        {
          accept: body.accept,
          decidedBy: "api",
          ...(body.untaggedFallback === undefined
            ? {}
            : { untaggedFallback: body.untaggedFallback }),
        },
        db(),
      );
      for (const importId of outcome.imports) await enqueue(importId, "api inbox resolved");
      return c.json(
        {
          resolved: outcome.resolved.map((row) => ({ ...row, status: String(row.status) })),
          failed: [...outcome.failed],
          resumed: [...outcome.imports],
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/resolve",
      tags: [TAG],
      summary: "Answer an Inbox item and unblock its import",
      description:
        "`accept: true` takes the item's own preselected answer, which is the same thing the " +
        "Console's Accept button does. Pass `resolution` to answer something else.\n\n" +
        "**`untaggedFallback: true`** is the one alternative with a name of its own, because it " +
        "is the way out of a record MusicBrainz has never published: the album is built from " +
        "the source's own tags, flagged `untagged` in the library, and `match` runs again with " +
        "`options.untaggedFallback` set. It is the same answer the review card offers, and it " +
        "is only valid on an `ambiguous_release` whose search returned no candidate.",
      middleware: [requireScope("review:write")] as const,
      request: {
        params: z.object({ id: idParam }),
        body: { content: { "application/json": { schema: resolveInboxSchema } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ item: inboxItemSchema, resumed: z.string().nullable() }),
            },
          },
          description: "Answered",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      const { accept, resolution, untaggedFallback } = c.req.valid("json");
      const item = await getInboxItem(id, db());
      if (item === null) throw notFound(id);

      /*
       * The one answer that is a *named* parameter rather than a hand-built `resolution`.
       *
       * An agent should not have to know that "import it from the source's own tags" is spelled
       * `{action: "retry", step: "match", untaggedFallback: true}`; the Console does not, and a
       * gesture that exists on one surface as a button and on another as folklore is a gesture
       * that exists once. The shape is `UNTAGGED_RESOLUTION`, shared with the card and the
       * batch, and the refusal for an item this cannot apply to is the batch's refusal.
       */
      if (untaggedFallback === true && !offersUntaggedImport(item)) {
        throw new MMError(
          "INVALID_INPUT",
          `Importing from the source's own tags is not an answer to a ${item.type} item.`,
          {
            hint: "It is offered on an `ambiguous_release` the search found no candidate for — the card that says MusicBrainz has nothing for this title.",
            status: 400,
          },
        );
      }

      const { item: updated } = await resolveInboxItem(
        id,
        {
          resolution:
            resolution ??
            (untaggedFallback === true
              ? { ...UNTAGGED_RESOLUTION }
              : accept
                ? { accepted: true, ...(item.preselected ?? {}) }
                : { accepted: false, action: "dismiss" }),
          decidedBy: "api",
          status: accept ? "resolved" : "dismissed",
        },
        db(),
      );

      // The job was parked waiting for exactly this.
      if (item.importId !== null) await enqueue(item.importId, "api inbox resolved");
      return c.json({ item: toItem(updated), resumed: item.importId }, 200);
    },
  );

  return app;
}

function notFound(id: string): MMError {
  return new MMError("NOT_FOUND", `No Inbox item with id ${id}.`, { status: 404 });
}
