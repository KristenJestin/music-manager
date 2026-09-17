/**
 * The Inbox (`docs/04-pipeline-et-matching.md` § Inbox).
 *
 * An item is a question the pipeline could not answer alone. Two properties make it useful
 * rather than annoying:
 *
 *  - it always carries a **preselected answer** and its alternatives (decision 002: the
 *    algorithm proposes and explains, you decide);
 *  - it is **idempotent per subject** — re-running the step that raised it re-opens the same
 *    item rather than piling up duplicates, which matters a great deal when a job is retried.
 *
 * Resolving an item writes a `decisions` row. That log is what P05 learns country, format and
 * explicit preferences from — visibly, in Settings, never opaquely.
 */
import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  decisions,
  inboxItems,
  INBOX_STATUSES,
  INBOX_TYPES,
  STEPS,
  type InboxItem,
  type InboxStatus,
  type InboxType,
  type StepName,
} from "#/server/db/schema/index.ts";
import { INBOX_SORTS, type InboxSort } from "#/lib/inbox-filters.ts";
import { newId } from "#/server/ids.ts";
import { emit } from "./events.ts";

export interface OpenInboxOptions {
  readonly type: InboxType;
  readonly importId?: string | null;
  readonly trackId?: string | null;
  readonly title: string;
  readonly summary?: string;
  readonly payload?: Record<string, unknown>;
  /** The answer the algorithm would take if you pressed Enter. */
  readonly preselected?: Record<string, unknown>;
}

/**
 * Raise an item, or refresh the one already open for the same (type, import, track).
 *
 * Returning the existing row rather than inserting a second one is what makes the step that
 * calls it idempotent: `fingerprint` can be re-run ten times and the Inbox still shows one
 * question.
 */
export async function openInboxItem(
  options: OpenInboxOptions,
  db: Database = defaultDb(),
): Promise<InboxItem> {
  const filters: SQL[] = [
    eq(inboxItems.type, options.type),
    eq(inboxItems.status, "open"),
    options.importId == null
      ? isNull(inboxItems.importId)
      : eq(inboxItems.importId, options.importId),
    options.trackId == null ? isNull(inboxItems.trackId) : eq(inboxItems.trackId, options.trackId),
  ];
  const [existing] = await db
    .select()
    .from(inboxItems)
    .where(and(...filters))
    .limit(1);

  if (existing !== undefined) {
    const [updated] = await db
      .update(inboxItems)
      .set({
        title: options.title,
        summary: options.summary ?? null,
        payload: options.payload ?? {},
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
      importId: options.importId ?? null,
      trackId: options.trackId ?? null,
      title: options.title,
      summary: options.summary ?? null,
      payload: options.payload ?? {},
      preselected: options.preselected ?? null,
    })
    .returning();

  if (created === undefined) throw new MMError("UNKNOWN", "Could not create the Inbox item.");

  await emit(
    {
      importId: options.importId ?? null,
      trackId: options.trackId ?? null,
      level: "warn",
      type: "inbox.created",
      message: options.title,
      data: { inboxItemId: created.id, inboxType: options.type },
    },
    db,
  );
  return created;
}

/**
 * The sort vocabulary, re-exported so the service and the route spell it once.
 *
 * It is *defined* in `lib/inbox-filters.ts` rather than here because `/review` validates
 * `?sort=` against it, and a route that value-imports anything under `server/**` ships Drizzle
 * to the browser with it (`client-boundary.guard.test.ts`). Same split, same reason, as
 * `lib/library-filters.ts`.
 */
export { INBOX_SORTS, type InboxSort };

export interface InboxFilter {
  readonly status?: InboxStatus;
  readonly importId?: string;
  readonly type?: InboxType;
  /**
   * Free text over **what the card shows**: its title, its summary, and its type.
   *
   * The type is matched as text rather than as an enum so the words the Console prints —
   * `ambiguous release`, underscore humanised away — find the rows they name. A search box
   * over a queue whose every row is labelled by its type has to reach that label.
   */
  readonly search?: string;
  /** Cap the rows. `countInbox` ignores it — a count is a count of the whole set. */
  readonly limit?: number;
  /** Skip this many rows. `countInbox` ignores it too, for the same reason. */
  readonly offset?: number;
  readonly sort?: InboxSort;
}

/**
 * Escape the three characters `like` reads as syntax.
 *
 * Every one of the fourteen type names contains an underscore, which `like` reads as "any one
 * character" — so `job_failed` would also match `job failed`. The search box on this page is
 * pointed at that vocabulary more than at anything else, so getting it wrong is not a corner
 * case.
 */
function likeTerm(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/**
 * The one `where` the list and the count both take, so the two cannot describe two sets.
 *
 * Not a stylistic preference: "the filtered count lies" has been a bug in this codebase twice,
 * both times because a count was computed from a predicate that had drifted from the list's,
 * and the pager then promised rows no page contained. Every function below goes through here,
 * and none of them assembles a condition of its own.
 */
function inboxWhere(filter: InboxFilter): SQL | undefined {
  const term = filter.search?.trim() ?? "";
  const free =
    term === ""
      ? undefined
      : or(
          ilike(inboxItems.title, likeTerm(term)),
          ilike(inboxItems.summary, likeTerm(term)),
          ilike(sql`${inboxItems.type}::text`, likeTerm(term)),
        );

  const filters: SQL[] = [
    ...(filter.status === undefined ? [] : [eq(inboxItems.status, filter.status)]),
    ...(filter.importId === undefined ? [] : [eq(inboxItems.importId, filter.importId)]),
    ...(filter.type === undefined ? [] : [eq(inboxItems.type, filter.type)]),
    ...(free === undefined ? [] : [free]),
  ];
  return filters.length === 0 ? undefined : and(...filters);
}

/**
 * The `order by` of one sort.
 *
 * Every one of them ends on `created_at`, which is what makes paging deterministic: a sort
 * with ties and no tie-breaker shows the same row on two pages and hides another entirely,
 * which is the paging bug nobody reports because it looks like a miscount.
 */
function inboxOrder(sort: InboxSort): SQL[] {
  switch (sort) {
    case "oldest":
      return [asc(inboxItems.createdAt)];
    case "type":
      // `::text`, not the enum: a pgEnum orders by declaration order, and what was asked for is
      // the list grouped by the word on the badge.
      return [asc(sql`${inboxItems.type}::text`), desc(inboxItems.createdAt)];
    case "title":
      return [asc(sql`lower(${inboxItems.title})`), desc(inboxItems.createdAt)];
    default:
      return [desc(inboxItems.createdAt)];
  }
}

/** List items, newest first unless another sort is asked for. */
export async function listInbox(
  filter: InboxFilter = {},
  db: Database = defaultDb(),
): Promise<InboxItem[]> {
  let query = db
    .select()
    .from(inboxItems)
    .where(inboxWhere(filter))
    .orderBy(...inboxOrder(filter.sort ?? "recent"))
    .$dynamic();
  if (filter.limit !== undefined) query = query.limit(filter.limit);
  if (filter.offset !== undefined && filter.offset > 0) query = query.offset(filter.offset);
  return await query;
}

/**
 * How many items of each type match — **with the type predicate dropped**.
 *
 * The chips above the queue read "Ambiguous release 40" while one of them is selected, so
 * their numbers have to describe the set the *other* filters leave. Counting with the type
 * predicate still in place would print the page size next to the active chip and a zero next
 * to every other one. Dropping exactly one condition and keeping `inboxWhere` for the rest is
 * what stops the counts from becoming a second, hand-written filter.
 */
export async function countInboxByType(
  filter: InboxFilter = {},
  db: Database = defaultDb(),
): Promise<Record<InboxType, number>> {
  const { type: _dropped, ...rest } = filter;
  void _dropped;
  const rows = await db
    .select({ type: inboxItems.type, total: sql<number>`count(*)::int` })
    .from(inboxItems)
    .where(inboxWhere(rest))
    .groupBy(inboxItems.type);

  const counts = Object.fromEntries(INBOX_TYPES.map((name) => [name, 0])) as Record<
    InboxType,
    number
  >;
  for (const row of rows) counts[row.type] = Number(row.total);
  return counts;
}

/**
 * How many items of each status match — with the **status** predicate dropped, for exactly the
 * reason `countInboxByType` drops the type one.
 */
export async function countInboxByStatus(
  filter: InboxFilter = {},
  db: Database = defaultDb(),
): Promise<Record<InboxStatus, number>> {
  const { status: _dropped, ...rest } = filter;
  void _dropped;
  const rows = await db
    .select({ status: inboxItems.status, total: sql<number>`count(*)::int` })
    .from(inboxItems)
    .where(inboxWhere(rest))
    .groupBy(inboxItems.status);

  const counts = Object.fromEntries(INBOX_STATUSES.map((name) => [name, 0])) as Record<
    InboxStatus,
    number
  >;
  for (const row of rows) counts[row.status] = Number(row.total);
  return counts;
}

/**
 * How many items match, as a `count(*)`.
 *
 * The shell's "needs review" badge used to be `listInbox({status:"open"}).length`, which reads
 * every open item **with its `payload`** — the whole candidate set of every unresolved match —
 * to produce one integer. With `defaultPreload: "intent"` and `defaultPreloadStaleTime: 0`
 * (`src/router.tsx`) the shell loader runs again on every link hover, so that was a few
 * hundred jsonb documents per mouse movement across the sidebar.
 */
export async function countInbox(
  filter: InboxFilter = {},
  db: Database = defaultDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inboxItems)
    .where(inboxWhere(filter));
  return row?.total ?? 0;
}

export async function getInboxItem(
  id: string,
  db: Database = defaultDb(),
): Promise<InboxItem | null> {
  const [row] = await db.select().from(inboxItems).where(eq(inboxItems.id, id)).limit(1);
  return row ?? null;
}

/** True when this import still has something blocking it. */
export async function hasOpenItems(importId: string, db: Database = defaultDb()): Promise<boolean> {
  return (await countInbox({ importId, status: "open" }, db)) > 0;
}

export interface ResolveOptions {
  /** What was chosen. `{accepted: true}` for a plain "accept the preselection". */
  readonly resolution: Record<string, unknown>;
  readonly decidedBy?: string;
  readonly status?: Extract<InboxStatus, "resolved" | "dismissed">;
}

/** Answer an item and log the decision. Returns the item as it now stands. */
export async function resolveInboxItem(
  id: string,
  options: ResolveOptions,
  db: Database = defaultDb(),
): Promise<InboxItem> {
  const item = await getInboxItem(id, db);
  if (item === null) {
    throw new MMError("NOT_FOUND", `No Inbox item with id ${id}.`, {
      hint: "Run `mm inbox list`.",
      action: "List the Inbox",
    });
  }

  const [updated] = await db
    .update(inboxItems)
    .set({
      status: options.status ?? "resolved",
      resolution: options.resolution,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(inboxItems.id, id))
    .returning();

  await db.insert(decisions).values({
    id: newId("decision"),
    kind: "inbox",
    importId: item.importId,
    inboxItemId: item.id,
    subject: item.type,
    choice: options.resolution,
    decidedBy: options.decidedBy ?? "user",
  });

  await emit(
    {
      importId: item.importId,
      trackId: item.trackId,
      type: "inbox.resolved",
      message: `Resolved: ${item.title}`,
      data: { inboxItemId: item.id, inboxType: item.type, resolution: options.resolution },
    },
    db,
  );

  await applyResolution(item, options.resolution, db);

  return updated ?? item;
}

/* ------------------------------------------------------------------ */
/* answering several at once                                           */
/* ------------------------------------------------------------------ */

/** Which items a batch is about. Exactly one of the three fields carries the selection. */
export interface InboxSelection {
  readonly itemId?: string;
  readonly itemIds?: readonly string[];
  /** Every item still `open` on this import. */
  readonly importId?: string;
  /** With `importId` only: narrow to one kind of question. */
  readonly type?: InboxType;
}

export interface BatchOutcome {
  readonly resolved: readonly { id: string; status: InboxStatus; importId: string | null }[];
  /** One entry per item that could not be answered; the others were still answered. */
  readonly failed: readonly { id: string; message: string }[];
  /**
   * The imports that now need re-queuing — **deduplicated**, one entry however many of their
   * items were answered. That is the whole point of the batch: thirteen fingerprint mismatches
   * answered one at a time re-queued the same job thirteen times, and each restart raced the
   * one before it.
   */
  readonly imports: readonly string[];
}

/**
 * Answer a set of items in one pass.
 *
 * Deliberately *not* a transaction: an item that cannot be answered (it vanished, or its
 * resolution is refused) must not throw away the twelve that were, and every answer is already
 * idempotent per item. The failures come back in `failed` with their reason.
 */
export async function resolveInboxBatch(
  selection: InboxSelection,
  options: {
    readonly accept: boolean;
    readonly decidedBy: string;
    /** Override the preselected answer. Only meaningful for a single item. */
    readonly resolution?: Record<string, unknown>;
  },
  db: Database = defaultDb(),
): Promise<BatchOutcome> {
  const given = [selection.itemId, selection.itemIds, selection.importId].filter(
    (value) => value !== undefined,
  );
  if (given.length === 0) {
    throw new MMError("INVALID_INPUT", "Give one of `itemId`, `itemIds` or `importId`.", {
      status: 400,
    });
  }
  if (given.length > 1) {
    throw new MMError(
      "INVALID_INPUT",
      "`itemId`, `itemIds` and `importId` are three ways to say the same thing; give one.",
      { status: 400 },
    );
  }
  if (selection.type !== undefined && selection.importId === undefined) {
    throw new MMError("INVALID_INPUT", "`type` only narrows an `importId` batch.", { status: 400 });
  }

  let items: InboxItem[];
  if (selection.importId !== undefined) {
    items = await listInbox(
      {
        importId: selection.importId,
        status: "open",
        ...(selection.type === undefined ? {} : { type: selection.type }),
      },
      db,
    );
  } else {
    const ids = selection.itemIds ?? [selection.itemId ?? ""];
    const found = await Promise.all(ids.map(async (id) => await getInboxItem(id, db)));
    const missing = ids.filter((_, index) => found[index] === null);
    if (missing.length > 0) {
      throw new MMError("NOT_FOUND", `No Inbox item with id ${missing.join(", ")}.`, {
        status: 404,
        hint: "Run `list_inbox` — an item that was already answered is no longer open.",
      });
    }
    items = found.filter((item): item is InboxItem => item !== null);
  }

  const resolved: { id: string; status: InboxStatus; importId: string | null }[] = [];
  const failed: { id: string; message: string }[] = [];
  const imports = new Set<string>();

  for (const item of items) {
    try {
      const updated = await resolveInboxItem(
        item.id,
        {
          resolution:
            options.resolution ??
            (options.accept
              ? { accepted: true, ...(item.preselected ?? {}) }
              : { accepted: false, action: "dismiss" }),
          decidedBy: options.decidedBy,
          status: options.accept ? "resolved" : "dismissed",
        },
        db,
      );
      resolved.push({ id: updated.id, status: updated.status, importId: item.importId });
      if (item.importId !== null) imports.add(item.importId);
    } catch (error) {
      failed.push({ id: item.id, message: MMError.from(error).message });
    }
  }

  return { resolved, failed, imports: [...imports] };
}

/**
 * Carry out an answer that is an **action** rather than a value.
 *
 * Most items are answered with data — a release MBID, "accept as partial" — and the caller
 * then puts the job back on the queue. Two answers are not data at all: `retry` and `cancel`
 * are things that have to happen to the job, and until now they happened nowhere. "Cancel this
 * import" has been on the `uncovered_tracks` and `ambiguous_release` cards since P06 and only
 * ever wrote a `decisions` row; a `job_failed` item would have had the same problem.
 *
 * It lives here rather than in the four callers (Console, `/api/v1`, MCP, CLI) precisely
 * because `docs/04` says an item "se résout par l'API comme par l'interface" — one
 * implementation is the only way that sentence stays true. `jobs/index.ts` imports this module
 * for `openInboxItem`, so the import back is dynamic; it is also the reason a caller that
 * never resolves an action never loads the step machine.
 */
async function applyResolution(
  item: InboxItem,
  resolution: Record<string, unknown>,
  db: Database,
): Promise<void> {
  const action = resolution["action"];
  if (typeof action !== "string") return;

  /* ---- the library-scoped answers, which have no import behind them ---- */

  if (action === "trash_orphans" || action === "trash_duplicates") {
    await trash(action === "trash_orphans" ? orphanPaths(item) : duplicatePaths(item), db);
    return;
  }
  if (action === "update_ytdlp") {
    const { updateYtdlp } = await import("#/server/services/tools.ts");
    await updateYtdlp({ db });
    return;
  }
  if (action === "reverify") {
    const albumId = item.payload["subject"];
    if (typeof albumId === "string" && albumId !== "") {
      const { verifyAlbum } = await import("#/server/services/verify.ts");
      await verifyAlbum(albumId, { db });
    }
    return;
  }

  if (item.importId === null) return;
  const importId = item.importId;

  if (action === "cancel") {
    const { cancelImport } = await import("#/server/services/jobs/index.ts");
    await cancelImport(importId, db);
    return;
  }

  if (action !== "retry") return;

  /*
   * Rewind, then hand the job back to the worker — never run it here. A retry from an HTTP
   * request that executed the steps inline would die with the request, and `download` is not
   * even allowed to run outside the single global queue.
   */
  const { retryStep, resumeStepOf } = await import("#/server/services/jobs/index.ts");
  const { enqueue } = await import("#/server/services/queue.ts");
  const asked = resolution["step"] ?? item.preselected?.["step"];
  const from =
    typeof asked === "string" && (STEPS as readonly string[]).includes(asked)
      ? (asked as StepName)
      : await resumeStepOf(importId, db);
  await retryStep(importId, from, { db, only: true });
  await enqueue(importId, "inbox retry", from);
}

/** The paths an `orphan_files` item is about. */
function orphanPaths(item: InboxItem): string[] {
  const orphans = item.payload["orphans"];
  if (!Array.isArray(orphans)) return [];
  return orphans
    .map((entry) => (entry as { path?: unknown }).path)
    .filter((path): path is string => typeof path === "string" && path !== "");
}

/** Every copy of a `duplicate_recording` item **except the first**, which is the one kept. */
function duplicatePaths(item: InboxItem): string[] {
  const files = item.payload["files"];
  if (!Array.isArray(files)) return [];
  return files
    .slice(1)
    .map((entry) => (entry as { path?: unknown }).path)
    .filter((path): path is string => typeof path === "string" && path !== "");
}

/**
 * Move files to the trash directory — never `unlink`.
 *
 * The same rule the Tools page follows (decision 062): a scan finding is a heuristic, and a
 * heuristic must not be allowed to destroy an original. A file that has already gone is not an
 * error here — the report it came from may be an hour old.
 */
async function trash(paths: readonly string[], db: Database): Promise<void> {
  if (paths.length === 0) return;
  const { loadSettings } = await import("#/server/services/settings.ts");
  const { resolvePaths } = await import("#/server/services/jobs/context.ts");
  const { trashFile } = await import("#/server/services/scan.ts");
  const settings = await loadSettings(db);
  const map = resolvePaths(settings);
  for (const path of paths) {
    try {
      trashFile(map, path, settings.trashDir);
    } catch {
      // Already gone, or moved by somebody else. Answering the question is what matters.
    }
  }
}

/** Close every open item of an import — used when a job is cancelled. */
export async function closeItemsOf(importId: string, db: Database = defaultDb()): Promise<void> {
  await db
    .update(inboxItems)
    .set({ status: "dismissed", resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(inboxItems.importId, importId), eq(inboxItems.status, "open")));
}
