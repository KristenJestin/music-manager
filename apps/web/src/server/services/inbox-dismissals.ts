/**
 * "Stop asking about this" — remembered on the **subject**, not on the item.
 *
 * This is `services/discover.ts`'s `notInterested` said a second time, for the review queue,
 * and the sentence that justified it there justifies it here word for word: the memory has to
 * survive a run that no longer proposes the thing at all, and it has to be consultable
 * *before* an item is written. A status on the item is exactly as durable as the item — which
 * is to say, not at all, because every scan builds new ones.
 *
 * What went wrong without it: eleven legitimate duplicates (one recording on *Ceremonials* and
 * on a compilation) were answered one at a time, and the next scan raised eleven new
 * `inbox_items` rows, under new ids, asking the same eleven questions. A review queue that
 * asks again is a review queue nobody reads.
 *
 * ## The subject key, per type
 *
 * There is no single clever scheme here, because the four families are asked about different
 * things. Each key holds **exactly the facts that were answered**, so a dismissal expires by
 * ceasing to match the moment those facts move. That is the whole expiry mechanism: no
 * timestamp, no sweep, and no permanent gag on a subject whose facts changed.
 *
 *  - `orphan_files` — **one key per path** (`orphan:<library-relative path>`). The card
 *    aggregates (two hundred stray files are one question) but the decision is about the
 *    files, so the memory is per file and a *new* orphan raises the card again with only
 *    itself on it. It expires when the file is adopted, moved or deleted: the path is the
 *    subject, and a path the walk no longer reports is a subject nothing consults.
 *
 *  - `duplicate_recording` — `duplicate:<recording mbid>|<album ids of every copy, sorted>`.
 *    A duplicate is a *pair*, and the key has to name that pair without depending on the order
 *    the scan happened to list it in, hence the sort. Two candidates were rejected. **Paths**,
 *    because a relocate rewrites every one of them and would resurrect an answered question
 *    about a file that merely moved. And the **recording MBID alone**, because "one recording
 *    on two albums" is precisely the case being dismissed, so the MBID is what the pair has in
 *    common rather than what tells it apart. Album ids are rows, not filesystem facts: they
 *    survive a relocate, a re-tag and a re-rip. The list is a *multiset* — `A,A,B` when two of
 *    three copies sit on one album — so a copy appearing or going away changes the key and the
 *    question comes back, which is the point.
 *
 *  - a `duplicate_recording` raised from a **merge conflict** is keyed on the conflict
 *    instead: `merge:<album>:<on>:<group key>|<track ids, sorted>`. The `position` flavour has
 *    no recording MBID at all, and there the rows *are* the question.
 *
 *  - `verify_mismatch` — `verify:<album id>|<field=written→read, sorted>`. The values are in
 *    the key on purpose. "Navidrome does not index this field" is an answer about *these*
 *    values; re-tag the album, or let the server start reporting something else, and it is a
 *    different question that must come back.
 *
 *  - `album_incomplete` — `album:<album id>|<total>`. "Accept it as it is" is an answer about
 *    an album measured against a known total; when the release it was matched to changes its
 *    denominator, the gap being accepted is not the gap that was accepted.
 *
 * Both halves of the round trip are built from the helpers below: the raiser asks for the key
 * it is about to write, and `dismissalSubjectsOf` re-derives the same key from the item's
 * payload when the answer comes in. `inbox-dismissals.test.ts` asserts the two agree, because
 * a memory keyed differently from the question is a memory that never matches.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { inboxDismissals, type InboxDismissal, type InboxType } from "#/server/db/schema/index.ts";

/** One thing to remember: the key, and what it was, so the Console can list it. */
export interface DismissalKey {
  readonly subject: string;
  readonly label: string;
}

/**
 * The families a scan rebuilds, and therefore the ones a dismissal has to outlive.
 *
 * An import-scoped question (`ambiguous_release`, `job_failed`…) is already keyed on its
 * import, so answering it once answers it for good and nothing rebuilds it. These four are
 * the ones raised from a walk of the library, again, every night.
 */
export const DISMISSIBLE_TYPES: ReadonlySet<InboxType> = new Set<InboxType>([
  "orphan_files",
  "duplicate_recording",
  "verify_mismatch",
  "album_incomplete",
]);

/* ------------------------------------------------------------------ */
/* the keys                                                            */
/* ------------------------------------------------------------------ */

export function orphanSubject(path: string): string {
  return `orphan:${path}`;
}

export function duplicateSubject(
  recordingMbid: string,
  albumIds: readonly (string | null)[],
): string {
  const albums = [...albumIds]
    .map((id) => id ?? "-")
    .sort((left, right) => left.localeCompare(right));
  return `duplicate:${recordingMbid}|${albums.join(",")}`;
}

export function mergeConflictSubject(
  albumId: string,
  on: string,
  key: string,
  trackIds: readonly string[],
): string {
  const rows = [...trackIds].sort((left, right) => left.localeCompare(right));
  return `merge:${albumId}:${on}:${key}|${rows.join(",")}`;
}

/** The field names **and** both values, because a mismatch whose values moved is a new one. */
export function verifyMismatchSubject(
  albumId: string,
  fields: readonly { readonly name: string; readonly written: unknown; readonly read: unknown }[],
): string {
  const parts = fields
    .map((entry) => `${entry.name}=${stringify(entry.written)}>${stringify(entry.read)}`)
    .sort((left, right) => left.localeCompare(right));
  return `verify:${albumId}|${parts.join(";")}`;
}

export function albumIncompleteSubject(albumId: string, total: number): string {
  return `album:${albumId}|${String(total)}`;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => stringify(entry)).join("/");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/* ------------------------------------------------------------------ */
/* reading a key back off an item                                      */
/* ------------------------------------------------------------------ */

/*
 * The payloads, parsed rather than cast.
 *
 * A `jsonb` column written by an earlier version of this application is a boundary like any
 * other. A payload that predates a field yields no key at all, so the item stays answerable
 * without the memory instead of throwing in the middle of a resolution.
 */
const orphanPayload = z.object({
  orphans: z.array(z.object({ path: z.string().min(1) })).default([]),
});

const duplicatePayload = z.object({
  recordingMbid: z.string().min(1),
  files: z.array(z.object({ trackId: z.string(), albumId: z.string().nullish() })).default([]),
});

const mergePayload = z.object({
  albumId: z.string().min(1),
  on: z.string().default("recording"),
  key: z.string().min(1),
  rows: z.array(z.object({ trackId: z.string() })).default([]),
});

const verifyPayload = z.object({
  libraryAlbumId: z.string().min(1),
  fields: z
    .array(z.object({ name: z.string(), written: z.unknown(), read: z.unknown() }))
    .default([]),
});

const incompletePayload = z.object({
  albumId: z.string().min(1),
  total: z.number().int(),
});

/** An Inbox item, as much of one as a key needs. */
export interface DismissableItem {
  readonly type: InboxType;
  readonly title: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Every subject one answered item covers — none at all for a type nothing rebuilds.
 *
 * Plural because `orphan_files` is plural: one card, two hundred decisions. Everything else
 * returns at most one.
 */
export function dismissalSubjectsOf(item: DismissableItem): readonly DismissalKey[] {
  if (!DISMISSIBLE_TYPES.has(item.type)) return [];

  switch (item.type) {
    case "orphan_files": {
      const parsed = orphanPayload.safeParse(item.payload);
      if (!parsed.success) return [];
      return parsed.data.orphans.map((orphan) => ({
        subject: orphanSubject(orphan.path),
        label: orphan.path,
      }));
    }
    case "duplicate_recording": {
      const group = duplicatePayload.safeParse(item.payload);
      if (group.success) {
        return [
          {
            subject: duplicateSubject(
              group.data.recordingMbid,
              group.data.files.map((file) => file.albumId ?? null),
            ),
            label: item.title,
          },
        ];
      }
      const conflict = mergePayload.safeParse(item.payload);
      if (!conflict.success) return [];
      return [
        {
          subject: mergeConflictSubject(
            conflict.data.albumId,
            conflict.data.on,
            conflict.data.key,
            conflict.data.rows.map((row) => row.trackId),
          ),
          label: item.title,
        },
      ];
    }
    case "verify_mismatch": {
      const parsed = verifyPayload.safeParse(item.payload);
      if (!parsed.success) return [];
      return [
        {
          subject: verifyMismatchSubject(parsed.data.libraryAlbumId, parsed.data.fields),
          label: item.title,
        },
      ];
    }
    case "album_incomplete": {
      const parsed = incompletePayload.safeParse(item.payload);
      if (!parsed.success) return [];
      return [
        {
          subject: albumIncompleteSubject(parsed.data.albumId, parsed.data.total),
          label: item.title,
        },
      ];
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/* the memory itself                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every hidden subject, as a set the raisers test before they write a row.
 *
 * One query per run, not one per finding: the table holds one row per decision a person has
 * actually taken, which is small by construction, while a scan asks about thousands.
 */
export async function dismissedSubjects(db: Database = defaultDb()): Promise<ReadonlySet<string>> {
  const rows = await db.select({ subject: inboxDismissals.subject }).from(inboxDismissals);
  return new Set(rows.map((row) => row.subject));
}

/** The hidden subjects of one type only — what a single raiser actually consults. */
export async function dismissedSubjectsOfType(
  type: InboxType,
  db: Database = defaultDb(),
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ subject: inboxDismissals.subject })
    .from(inboxDismissals)
    .where(eq(inboxDismissals.type, type));
  return new Set(rows.map((row) => row.subject));
}

/** True when this exact question has already been answered "and stop asking". */
export async function isDismissed(subject: string, db: Database = defaultDb()): Promise<boolean> {
  const [row] = await db
    .select({ subject: inboxDismissals.subject })
    .from(inboxDismissals)
    .where(eq(inboxDismissals.subject, subject))
    .limit(1);
  return row !== undefined;
}

/**
 * Write the memory. Idempotent: answering the same question twice is not an error.
 *
 * The label is refreshed on conflict, because the title is what the Console lists and a stale
 * one would describe a library that has since moved on.
 */
export async function rememberDismissals(
  type: InboxType,
  keys: readonly DismissalKey[],
  db: Database = defaultDb(),
): Promise<number> {
  if (keys.length === 0) return 0;
  const unique = new Map(keys.map((key) => [key.subject, key]));
  const rows = await db
    .insert(inboxDismissals)
    .values([...unique.values()].map((key) => ({ subject: key.subject, type, label: key.label })))
    .onConflictDoUpdate({
      target: inboxDismissals.subject,
      set: { label: sql`excluded.label`, type: sql`excluded.type` },
    })
    .returning({ subject: inboxDismissals.subject });
  return rows.length;
}

export interface DismissalPage {
  readonly rows: readonly InboxDismissal[];
  readonly total: number;
}

/**
 * What has been hidden, newest first — the list the Console shows, so that a dismissal taken
 * by mistake is recoverable instead of permanent.
 */
export async function listInboxDismissals(
  options: { readonly type?: InboxType; readonly limit?: number } = {},
  db: Database = defaultDb(),
): Promise<DismissalPage> {
  const where = options.type === undefined ? undefined : eq(inboxDismissals.type, options.type);
  const rows = await db
    .select()
    .from(inboxDismissals)
    .where(where)
    .orderBy(desc(inboxDismissals.createdAt), desc(inboxDismissals.subject))
    .limit(options.limit ?? 200);
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inboxDismissals)
    .where(where);
  return { rows, total: counted?.count ?? rows.length };
}

/** Un-hide one subject. The next run asks about it again, and that is the whole undo. */
export async function forgetInboxDismissal(
  subject: string,
  db: Database = defaultDb(),
): Promise<boolean> {
  const removed = await db
    .delete(inboxDismissals)
    .where(eq(inboxDismissals.subject, subject))
    .returning({ subject: inboxDismissals.subject });
  return removed.length > 0;
}

/** Un-hide several at once, or — given neither filter — every one of them. */
export async function forgetInboxDismissals(
  options: { readonly subjects?: readonly string[]; readonly type?: InboxType } = {},
  db: Database = defaultDb(),
): Promise<number> {
  const clauses = [
    options.subjects === undefined
      ? undefined
      : inArray(inboxDismissals.subject, [...options.subjects]),
    options.type === undefined ? undefined : eq(inboxDismissals.type, options.type),
  ].filter((clause) => clause !== undefined);
  const removed = await db
    .delete(inboxDismissals)
    .where(clauses.length === 0 ? undefined : and(...clauses))
    .returning({ subject: inboxDismissals.subject });
  return removed.length;
}
