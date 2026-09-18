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
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  decisions,
  importTracks,
  inboxItems,
  INBOX_STATUSES,
  INBOX_TYPES,
  STEPS,
  type InboxItem,
  type InboxStatus,
  type InboxType,
  type StepName,
} from "#/server/db/schema/index.ts";
import {
  offersUntaggedImport,
  planResolution,
  silencesSubject,
  UNTAGGED_RESOLUTION,
  type ResolutionPlan,
} from "./inbox.resolution.ts";
import { dismissalSubjectsOf, rememberDismissals } from "./inbox-dismissals.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
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

/** What answering an item did. `resumed` is the half the Console's toast is allowed to claim. */
export interface ResolveResult {
  readonly item: InboxItem;
  /**
   * True when answering it actually put the job back to work.
   *
   * The Console said "Decision saved; the job resumes" on every answer it managed to write,
   * which was a promise nothing kept for a chosen candidate. It is now reported by whatever
   * carried the answer out, so the sentence and the job agree.
   */
  readonly resumed: boolean;
}

/**
 * Answer an item and log the decision.
 *
 * The plan is read **before** the row is closed. An answer no branch handles therefore throws
 * with the item still `open`, which is the difference between "I could not do that" and a
 * decision silently dropped on the floor.
 */
export async function resolveInboxItem(
  id: string,
  options: ResolveOptions,
  db: Database = defaultDb(),
): Promise<ResolveResult> {
  const item = await getInboxItem(id, db);
  if (item === null) {
    throw new MMError("NOT_FOUND", `No Inbox item with id ${id}.`, {
      hint: "Run `mm inbox list`.",
      action: "List the Inbox",
    });
  }

  const plan = planResolution(item, options.resolution);

  /*
   * The memory is written before the row is closed, and on the *subject* rather than the row.
   *
   * That ordering is not cosmetic: the item is about to become history, and the thing that
   * has to survive it is the answer. Nothing happens here for a "Later" (`snooze`) or for a
   * type a scan does not rebuild — `dismissalSubjectsOf` returns nothing for those — so this
   * is a no-op on every import-scoped question.
   */
  if (silencesSubject(options.resolution)) {
    await rememberDismissals(item.type, dismissalSubjectsOf(item), db);
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

  const { resumed } = await applyResolution(item, plan, options.decidedBy ?? "user", db);

  return { item: updated ?? item, resumed };
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
    /**
     * Answer every item with "import it from the source's own tags" instead of its preselection.
     *
     * This is the batch half of the offer the review card carries, and it is the half the
     * owner's eight albums need: they are parked on a candidateless `ambiguous_release`, whose
     * preselection is *cancel* — so `accept: true` over the lot would refuse each one
     * (`{accepted: true}` names no release, and `planResolution` says so). An item this cannot
     * apply to comes back in `failed` rather than quietly having the flag set on its import:
     * turning `untaggedFallback` on from a `fingerprint_mismatch` that happened to be open on
     * the same import would be the silent wrong answer this module exists to prevent.
     */
    readonly untaggedFallback?: boolean;
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
      const { item: updated } = await resolveInboxItem(
        item.id,
        {
          resolution: answerFor(item, options),
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
 * What one item of a batch is answered with.
 *
 * Three answers in order of precedence: an explicit `resolution`, the untagged import, the
 * item's own preselection. It throws rather than returning a fallback, because the throw lands
 * in the batch's `failed` list with the reason attached — which is the difference between "I
 * could not do that to this one" and forty imports quietly given a flag one of them asked for.
 */
function answerFor(
  item: InboxItem,
  options: {
    readonly accept: boolean;
    readonly resolution?: Record<string, unknown>;
    readonly untaggedFallback?: boolean;
  },
): Record<string, unknown> {
  if (options.resolution !== undefined) return options.resolution;

  if (options.untaggedFallback === true) {
    if (!offersUntaggedImport(item)) {
      throw new MMError(
        "INVALID_INPUT",
        `Importing from the source's own tags is not an answer to a ${item.type} item.`,
        {
          hint: "It is offered on an `ambiguous_release` the search found no candidate for — the card that says MusicBrainz has nothing for this title.",
          action: "Answer this one with its own options",
          status: 400,
        },
      );
    }
    return { ...UNTAGGED_RESOLUTION };
  }

  return options.accept
    ? { accepted: true, ...(item.preselected ?? {}) }
    : { accepted: false, action: "dismiss" };
}

/**
 * Carry out what an answer *means*, and say whether the job moved.
 *
 * Two answers are things that have to happen to the job — `retry` and `cancel` — and two more
 * are a **choice**: a release MBID on an `ambiguous_release` card, a recording MBID on an
 * `ambiguous_recording` one. Those last two used to fall out of the first line of this
 * function, because they carry no `action`: the item closed, the decision was logged, the
 * Console promised a resume, and the import stayed `Blocked` at `match` for ever.
 *
 * They are now pinned through the door the pipeline already has — `imports.options.releaseMbid`
 * for a release (what `mm import --release <mbid>` and the card's "paste a release id" button
 * write) and `imports.options.mapping` for a recording (what `confirm-mapping`, MCP's
 * `confirm_mapping` and the wizard's Start button write) — and then re-matched from `match`.
 * No second door was invented.
 *
 * It lives here rather than in the four callers (Console, `/api/v1`, MCP, CLI) precisely
 * because `docs/04` says an item "se résout par l'API comme par l'interface" — one
 * implementation is the only way that sentence stays true. `jobs/index.ts` imports this module
 * for `openInboxItem`, so the import back is dynamic; it is also the reason a caller that
 * never resolves an action never loads the step machine.
 */
async function applyResolution(
  item: InboxItem,
  plan: ResolutionPlan,
  decidedBy: string,
  db: Database,
): Promise<{ resumed: boolean }> {
  /* ---- the library-scoped answers, which have no import behind them ---- */

  if (plan.kind === "trash") {
    await trash(plan.what === "orphans" ? orphanPaths(item) : duplicatePaths(item), db);
    return { resumed: false };
  }
  if (plan.kind === "update-ytdlp") {
    const { updateYtdlp } = await import("#/server/services/tools.ts");
    await updateYtdlp({ db });
    return { resumed: false };
  }
  if (plan.kind === "reverify") {
    const albumId = item.payload["subject"];
    if (typeof albumId === "string" && albumId !== "") {
      const { verifyAlbum } = await import("#/server/services/verify.ts");
      await verifyAlbum(albumId, { db });
    }
    return { resumed: false };
  }

  if (item.importId === null) return { resumed: false };
  const importId = item.importId;

  if (plan.kind === "cancel") {
    const { cancelImport } = await import("#/server/services/jobs/index.ts");
    await cancelImport(importId, db);
    return { resumed: false };
  }

  /*
   * "Yes, the mapping as shown."
   *
   * The gate is opened and **signed with whoever answered** — `console` from the review card,
   * `api` from `/api/v1/inbox/{id}/resolve`, `mcp`, `cli`. `confirm` then writes the same
   * `decisions` row it writes for the wizard and for `--yes`, so the audit trail can still
   * answer "which of my albums did nobody look at?" with one query.
   *
   * It deliberately does **not** re-queue the job: every caller of `resolveInboxItem` already
   * does that once — the Console after checking nothing else is open, `/api/v1` unconditionally,
   * the batch once per import — and a second `enqueue` here would race the first.
   */
  if (plan.kind === "confirm") {
    const { setImportOptions } = await import("#/server/services/console.queries.ts");
    await setImportOptions(importId, { autoConfirm: true, confirmedBy: decidedBy }, {}, db);
    return { resumed: false };
  }

  if (plan.kind === "use-acoustid" || plan.kind === "skip-track") {
    await rebindTrack(item, plan.kind, db);
    return { resumed: false };
  }

  /* ---- the answers that are a chosen MusicBrainz entity ---- */

  if (plan.kind === "pin-release" || plan.kind === "pin-recording") {
    return { resumed: await pinAndRematch(item, plan, db) };
  }

  if (plan.kind !== "retry") return { resumed: false };

  /*
   * "Build it from the source's own tags instead."
   *
   * The same door `mm import --untagged` and the API's `options.untaggedFallback` already open,
   * written before the rewind so that the `match` about to be re-queued reads it:
   * `wantsUntaggedFallback` returns a stated flag ahead of everything it would otherwise infer,
   * so the step stops blocking and ends in `applySupplied` with `releaseMbid: null` — the album
   * filed `untagged`, findable and identifiable later.
   *
   * **The default it overrides is not changed by this and must not be.** Off for a URL is the
   * right default; filing an album under a title nobody chose is worse than parking it. What
   * this carries out is somebody reading the card and choosing the lesser outcome on purpose.
   */
  if (plan.untaggedFallback) {
    const { setImportOptions } = await import("#/server/services/console.queries.ts");
    await setImportOptions(importId, { untaggedFallback: true }, {}, db);
  }

  /*
   * Rewind, then hand the job back to the worker. A retry from an HTTP request that ran the
   * whole pipeline inline would die with the request, and `download` is not even allowed to
   * run outside the single global queue — hence `only`, which runs the rewound step and leaves
   * everything after it to the queue.
   */
  const { retryStep, resumeStepOf } = await import("#/server/services/jobs/index.ts");
  const { enqueue } = await import("#/server/services/queue.ts");
  const asked = plan.step ?? item.preselected?.["step"];
  const from =
    typeof asked === "string" && (STEPS as readonly string[]).includes(asked)
      ? (asked as StepName)
      : await resumeStepOf(importId, db);
  await retryStep(importId, from, { db, only: true });
  await enqueue(importId, "inbox retry", from);
  return { resumed: true };
}

/**
 * The statuses from which a re-match is the answer rather than a surprise.
 *
 * An import that is `done`, `failed` or `cancelled` is not waiting for this question — the v1
 * migration raises `ambiguous_recording` items on imports that have already finished, and
 * rewinding one of those to `match` would re-run a pipeline over a library row. The choice is
 * still recorded on the import and in `decisions`; nothing is restarted.
 */
const REMATCHABLE: readonly string[] = ["pending", "awaiting_review", "awaiting_confirm", "paused"];

/**
 * Apply a chosen release or recording, then match again against it.
 *
 * The **same** two fields the rest of the pipeline already accepts a pinned answer through:
 * `options.releaseMbid`, read by `matchOneAlbum`'s pin branch — which looks the release up by
 * MBID when the search never returned it — and `options.mapping`, read by `applySupplied`.
 * Answering the card is then indistinguishable from having pinned it on the command line,
 * which is the property that makes this fixable in one place.
 */
async function pinAndRematch(
  item: InboxItem,
  plan: Extract<ResolutionPlan, { kind: "pin-release" } | { kind: "pin-recording" }>,
  db: Database,
): Promise<boolean> {
  const importId = item.importId;
  if (importId === null) return false;

  const { setImportOptions } = await import("#/server/services/console.queries.ts");
  const { getImport } = await import("#/server/services/imports.ts");
  const job = await getImport(importId, db);
  if (job === null) return false;

  /*
   * **The answer is an assertion, so `releaseMbidFromTags` goes.**
   *
   * `resolve` writes that flag when a folder's files agree on a `MUSICBRAINZ_ALBUMID`, and
   * `match` reads it as "nobody asserted this" — which is what lets a folder import fall back
   * to the files' own tags when MusicBrainz cannot produce the release
   * (`wantsUntaggedFallback`). A person answering this card *has* asserted it. Leaving the flag
   * behind would let the re-match give up on the very release they just chose and file the
   * album untagged instead, which is the same shape of bug as dropping the answer outright.
   */
  if (plan.kind === "pin-release") {
    await setImportOptions(
      importId,
      { releaseMbid: plan.releaseMbid, releaseMbidFromTags: false },
      { releaseMbid: plan.releaseMbid },
      db,
    );
  } else {
    const mapping = await recordingMapping(item, plan, db);
    if (mapping === null) return false;
    await setImportOptions(
      importId,
      {
        mapping,
        releaseMbidFromTags: false,
        ...(mapping.releaseMbid === null ? {} : { releaseMbid: mapping.releaseMbid }),
      },
      { ...(mapping.releaseMbid === null ? {} : { releaseMbid: mapping.releaseMbid }) },
      db,
    );
  }

  if (!REMATCHABLE.includes(job.status)) return false;

  const { retryStep } = await import("#/server/services/jobs/index.ts");
  const { enqueue } = await import("#/server/services/queue.ts");
  await retryStep(importId, "match", { db, only: true });
  await enqueue(importId, "inbox decision", "match");
  return true;
}

/**
 * The supplied mapping a chosen recording amounts to.
 *
 * Exactly the shape the wizard's single path sends (`routes/_app.import.new.tsx`): one line,
 * the recording, the release it is borrowed from, and `trackTotal: 0` — a single covers no
 * tracklist, so `applySupplied` must not raise an `uncovered_tracks` notice for the ten other
 * tracks of the album it happens to be filed under.
 *
 * The borrow release comes from the candidate in the item's own payload, because the card's
 * options carry a recording id and nothing else: an answer that is not the preselection would
 * otherwise have no album to be filed under at all.
 */
async function recordingMapping(
  item: InboxItem,
  plan: Extract<ResolutionPlan, { kind: "pin-recording" }>,
  db: Database,
): Promise<SuppliedMapping | null> {
  if (item.trackId === null) return null;

  const candidates = item.payload["candidates"];
  const candidate = (Array.isArray(candidates) ? candidates : [])
    .map((entry) => entry as Record<string, unknown>)
    .find((entry) => entry["id"] === plan.recordingMbid);
  const borrow = (candidate?.["borrow"] ?? null) as Record<string, unknown> | null;

  const borrowId = typeof borrow?.["id"] === "string" ? borrow["id"] : null;
  const releaseMbid = borrowId ?? plan.releaseMbid;
  if (releaseMbid === null) return null;

  const [row] = await db
    .select()
    .from(importTracks)
    .where(eq(importTracks.id, item.trackId))
    .limit(1);
  if (row === undefined) return null;

  const date = typeof borrow?.["date"] === "string" ? borrow["date"] : null;
  const parsed = date === null || date.length < 4 ? null : Number(date.slice(0, 4));
  const title = typeof borrow?.["title"] === "string" ? borrow["title"] : null;
  const artist = typeof candidate?.["artist"] === "string" ? candidate["artist"] : null;
  const trackTitle =
    typeof candidate?.["title"] === "string" ? candidate["title"] : row.sourceTitle;

  return {
    releaseMbid,
    ...(title === null ? {} : { album: title }),
    ...(artist === null ? {} : { albumArtist: artist }),
    year: parsed === null || Number.isNaN(parsed) ? null : parsed,
    trackTotal: 0,
    tracks: [
      {
        position: row.position,
        trackPosition: typeof borrow?.["trackPosition"] === "number" ? borrow["trackPosition"] : 1,
        mediumPosition: 1,
        recordingMbid: plan.recordingMbid,
        trackTitle,
        confidence: typeof candidate?.["score"] === "number" ? candidate["score"] : 1,
      },
    ],
  };
}

/**
 * The two answers to a fingerprint disagreement that are not "keep what I confirmed".
 *
 * Both were offered by the card and carried out by nobody: the item closed, `fingerprint` read
 * "answered" as "accepted", and the file was tagged with the mapping the fingerprint had just
 * contradicted. Neither re-queues — `fingerprint` re-runs once the item is closed, and the
 * caller enqueues exactly as it does for every other answer.
 */
async function rebindTrack(
  item: InboxItem,
  kind: "use-acoustid" | "skip-track",
  db: Database,
): Promise<void> {
  if (item.trackId === null) return;

  if (kind === "skip-track") {
    // `extra` is the role every step reads as "not part of this album": `mappedTracks` drops
    // it, so nothing downloads, tags or files it, and the counts stop expecting it.
    await db
      .update(importTracks)
      .set({ role: "extra", updatedAt: new Date() })
      .where(eq(importTracks.id, item.trackId));
    return;
  }

  const heard = item.payload["heard"] as Record<string, unknown> | undefined;
  const recordingMbid =
    typeof heard?.["recordingMbid"] === "string" ? heard["recordingMbid"] : null;
  if (recordingMbid === null) return;
  const title = typeof heard?.["title"] === "string" ? heard["title"] : null;
  await db
    .update(importTracks)
    .set({
      recordingMbid,
      ...(title === null ? {} : { trackTitle: title }),
      fingerprintOk: true,
      updatedAt: new Date(),
    })
    .where(eq(importTracks.id, item.trackId));
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

/**
 * Close the questions a step raised last time and did **not** raise this time.
 *
 * `openInboxItem` makes a step idempotent in one direction only: re-running it refreshes the
 * item it still wants to ask rather than piling up a second. Nothing ever closed the other
 * direction, so an import re-matched onto a release that covers every track kept its
 * "6 track(s) of the release have no video" for ever. The owner re-matched fifteen albums and
 * not one flag was re-evaluated — and a review queue full of false positives stops being read,
 * which costs more than the bug that filled it.
 *
 * Two guarantees, and the second is why this is not `closeItemsOf`:
 *
 *  - **only the types the step owns.** `match` closes its own four; a `fingerprint_mismatch`
 *    or a `job_failed` is somebody else's record and is left exactly where it is;
 *  - **only `open` items.** An item a person answered is `resolved` or `dismissed`, and this
 *    `where` cannot see it. A decision is a record, not a cache.
 *
 * `raised` is the set of ids this run actually opened or refreshed — collected rather than
 * inferred from `updated_at`, because the row's timestamp comes from the database clock and
 * the run's start would come from this process's, and a step must not depend on the two
 * agreeing to the millisecond.
 */
export async function closeSupersededItems(
  importId: string,
  types: readonly InboxType[],
  raised: ReadonlySet<string>,
  db: Database = defaultDb(),
): Promise<InboxItem[]> {
  if (types.length === 0) return [];
  const stale = await db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.importId, importId),
        eq(inboxItems.status, "open"),
        inArray(inboxItems.type, [...types]),
      ),
    );
  const going = stale.filter((item) => !raised.has(item.id));
  if (going.length === 0) return [];

  const now = new Date();
  await db
    .update(inboxItems)
    .set({
      status: "dismissed",
      // No `decisions` row: nobody decided this. The question stopped being true, and the
      // resolution says so in as many words rather than claiming somebody answered it.
      resolution: { closedBy: "re-run", reason: "the step that raised it no longer does" },
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      inArray(
        inboxItems.id,
        going.map((item) => item.id),
      ),
    );

  for (const item of going) {
    await emit(
      {
        importId,
        trackId: item.trackId,
        type: "inbox.resolved",
        message: `No longer asking: ${item.title}`,
        data: { inboxItemId: item.id, inboxType: item.type, closedBy: "re-run" },
      },
      db,
    );
  }
  return going;
}
