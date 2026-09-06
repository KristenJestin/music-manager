/**
 * Inbox items that belong to the **library** rather than to an import.
 *
 * `services/inbox.ts` keys an open item on `(type, importId, trackId)`, which is exactly
 * right for the questions a running job asks: one `ambiguous_release` per import, refreshed
 * rather than duplicated on every retry. The three item types P07 raises — `verify_mismatch`,
 * `orphan_files`, `duplicate_recording` — have no import at all, so under that key every
 * album in the library would collapse into a single row.
 *
 * So they are keyed on their own subject instead: the library album id, the scan run, the
 * recording MBID. The identity is written into `payload.subject` and matched there, which
 * keeps the whole thing inside the existing table and needs no migration.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { inboxItems, type InboxItem, type InboxType } from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { emit } from "./events.ts";

export interface LibraryInboxOptions {
  readonly type: InboxType;
  /** What the item is about: a library album id, a recording MBID, `scan`. */
  readonly subject: string;
  readonly title: string;
  readonly summary?: string;
  readonly payload?: Record<string, unknown>;
  readonly preselected?: Record<string, unknown>;
}

/** The `payload.subject` of an open item, matched as JSON text. */
const subjectOf = (subject: string) => sql`${inboxItems.payload} ->> 'subject' = ${subject}`;

/**
 * Raise a library-scoped item, or refresh the one already open for the same subject.
 *
 * Idempotent by construction, which is what lets the nightly scan run every night without
 * turning the Inbox into a log.
 */
export async function openLibraryItem(
  options: LibraryInboxOptions,
  db: Database = defaultDb(),
): Promise<InboxItem> {
  const payload = { ...(options.payload ?? {}), subject: options.subject };
  const [existing] = await db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.type, options.type),
        eq(inboxItems.status, "open"),
        isNull(inboxItems.importId),
        subjectOf(options.subject),
      ),
    )
    .limit(1);

  if (existing !== undefined) {
    const [updated] = await db
      .update(inboxItems)
      .set({
        title: options.title,
        summary: options.summary ?? null,
        payload,
        preselected: options.preselected ?? null,
        updatedAt: new Date(),
      })
      .where(eq(inboxItems.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [created] = await db
    .insert(inboxItems)
    .values({
      id: newId("inboxItem"),
      type: options.type,
      title: options.title,
      summary: options.summary ?? null,
      payload,
      preselected: options.preselected ?? null,
    })
    .returning();
  if (created === undefined) throw new MMError("UNKNOWN", "Could not create the Inbox item.");

  await emit(
    {
      level: "warn",
      type: "inbox.created",
      message: options.title,
      data: { inboxItemId: created.id, inboxType: options.type, subject: options.subject },
    },
    db,
  );
  return created;
}

/**
 * Close the open item for one subject, because the problem is gone.
 *
 * An Inbox that keeps an item after the thing it complained about was fixed is an Inbox
 * nobody reads, so every raiser in P07 calls this on its clean path.
 */
export async function closeLibraryItem(
  type: InboxType,
  subject: string,
  db: Database = defaultDb(),
): Promise<number> {
  const closed = await db
    .update(inboxItems)
    .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(inboxItems.type, type), eq(inboxItems.status, "open"), subjectOf(subject)),
    )
    .returning({ id: inboxItems.id });
  return closed.length;
}

/** Every open item of one type, for the Tools page counters. */
export async function openLibraryItems(
  type: InboxType,
  db: Database = defaultDb(),
): Promise<InboxItem[]> {
  return await db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.type, type), eq(inboxItems.status, "open")));
}
