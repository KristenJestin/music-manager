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
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  decisions,
  inboxItems,
  STEPS,
  type InboxItem,
  type InboxStatus,
  type InboxType,
  type StepName,
} from "#/server/db/schema/index.ts";
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

/** List items, newest first. */
export async function listInbox(
  filter: { status?: InboxStatus; importId?: string; type?: InboxType } = {},
  db: Database = defaultDb(),
): Promise<InboxItem[]> {
  const filters: SQL[] = [
    ...(filter.status === undefined ? [] : [eq(inboxItems.status, filter.status)]),
    ...(filter.importId === undefined ? [] : [eq(inboxItems.importId, filter.importId)]),
    ...(filter.type === undefined ? [] : [eq(inboxItems.type, filter.type)]),
  ];
  return await db
    .select()
    .from(inboxItems)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(inboxItems.createdAt));
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
  const open = await listInbox({ importId, status: "open" }, db);
  return open.length > 0;
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
