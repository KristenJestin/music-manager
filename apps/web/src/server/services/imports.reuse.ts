/**
 * `imports.reuse` — re-entering an import instead of opening a second one.
 *
 * The defect this file answers, measured on the owner's instance: **204 imports parked at
 * "Waiting for the import wizard" for 7 URLs**, 80 of them for one album. `createImport`
 * selected the imports with the same URL, *counted* them, journalled `duplicates` — and then
 * inserted a new row regardless. Every round trip through the wizard and every press of
 * "Re-fetch" therefore cost a full yt-dlp extraction and left a row somebody has to clean up.
 *
 * Two things live here, and they share one predicate:
 *
 *  - **reuse**: which import a wizard entrance may re-enter for a URL (`pickReusable`);
 *  - **cleanup**: which of the rows already there may be collapsed (`findParkedDuplicates`).
 *
 * Sharing the predicate is the point. "Safe to hand back to the wizard" and "safe to cancel as
 * a redundant sibling" are the same statement about a row — *nobody is working on it and
 * nothing has been done to it* — and two definitions of it would drift apart on the first
 * status somebody added.
 *
 * ## The status-by-status decision
 *
 * | status             | re-entered? | why                                                     |
 * | ------------------ | ----------- | ------------------------------------------------------- |
 * | `paused` (wizard)  | **yes**     | the row the wizard itself left behind — the whole defect |
 * | `pending`          | **yes**     | created and not yet resolved: the double-click window    |
 * | `running`, nothing | **yes**     | **the creation that is happening right now.** `runStep`  |
 * | past `resolve`     |             | marks the row `running` for the whole of the extraction, |
 * |                    |             | and a *successful* `resolve` leaves it `running` at      |
 * |                    |             | `match`. On the owner's playlist that is a minute, and   |
 * |                    |             | every re-entry inside it — the match poll, a second tab, |
 * |                    |             | an impatient Enter — must join it rather than open a     |
 * |                    |             | fifth. `resolve` downloads nothing and holds no slot     |
 * | `running`, and a   | no          | somebody else's work: the worker is in `match`, or it    |
 * | step past `resolve`| no          | holds the download slot and reuse would park it mid-file |
 * | `paused` by worker | no          | a shutdown parked it; the resume sweep owns those rows   |
 * | `waiting_upstream` | no          | running slowly, not stopped. The same argument           |
 * | `awaiting_confirm` | no          | it has matched and raised a question; the answer lives   |
 * | `awaiting_review`  | no          | in Review, and the wizard would ask it again from zero   |
 * | `done`             | no          | resuming a finished import would change its identity     |
 * |                    |             | underneath the person. A new import with the duplicate   |
 * |                    |             | announced is the honest answer, and re-importing to pick |
 * |                    |             | up better metadata is legitimate (`docs/04` § Règles)    |
 * | `failed`           | no          | the row *is* the record of the failure, and `mm retry`   |
 * |                    |             | is its door; reusing it would erase the evidence         |
 * | `cancelled`        | no          | somebody said no to that one                             |
 *
 * Two further narrowings, both in `importsThatHaveWorked` and both checked rather than assumed:
 * **no `job_steps` row past `resolve`**, which is the only thing that separates "just created"
 * from "the worker is matching it" — `status` cannot, they are both `running` at `match` — and
 * **no track that has downloaded, tagged or placed anything**. `step` narrows it once more:
 * only `resolve` and `match` qualify at all.
 */
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { imports, importTracks, jobSteps, type Import } from "#/server/db/schema/index.ts";

/**
 * A Drizzle transaction, named from `Database` itself rather than from a `drizzle-orm`
 * internal, so a version bump that reshapes the type is a compile error here and not a cast.
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The first half of the advisory-lock key, so this lock cannot collide with another one.
 *
 * `pg_advisory_xact_lock(int4, int4)` takes two integers: a class and a key. The class is this
 * constant — `0x6D6D0001`, "mm" and a counter — and the key is `hashtext(url)`.
 */
export const IMPORT_URL_LOCK_CLASS = 0x6d6d0001;

/** The two steps before anything has been downloaded. Everything after has a file. */
const EARLY_STEPS = ["resolve", "match"] as const;

/**
 * Take the URL's lock for the rest of this transaction.
 *
 * `imports_url_idx` is a plain btree, **not** a unique index, and it has to stay that way:
 * several imports of one URL are legitimate — that is precisely what `duplicates` reports —
 * so a unique index would forbid a state the product is built on, and would refuse to be
 * created at all on an installation that already holds 204 rows for 7 URLs. The mutual
 * exclusion therefore comes from an advisory lock rather than from a constraint: it makes
 * "look, then insert" one step for a given URL, which is exactly the window two tabs or a
 * double click fall into.
 *
 * Transaction-scoped, so it is released by the commit or by the rollback and can never be
 * leaked by a throw. Held over two small queries only — never over `resolve`, which is a
 * network call and belongs outside any transaction.
 */
export async function lockUrl(tx: Tx, url: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${IMPORT_URL_LOCK_CLASS}, hashtext(${url})::int4)`,
  );
}

/**
 * The ids, among these, whose import has done something beyond being listed.
 *
 * Two questions, one answer, because a row that fails either is neither re-entered nor
 * collapsed:
 *
 *  - **has any step past `resolve` ever been begun?** `job_steps` is the record of that, and
 *    it is what `imports.status` cannot tell you: a successful `resolve` leaves the import
 *    `running` at `match` (`machine.transition`), which is *also* what a worker halfway
 *    through `match` looks like. The first is the creation this function exists to let a
 *    second tab join; the second is somebody else's work. Only `job_steps` separates them.
 *  - **has any track moved?** `state <> 'pending'` is the statement; `download_path` and
 *    `library_path` are the two columns that would still be true if a state had been rolled
 *    back by hand.
 *
 * The wizard's own step 2 does **not** run the `match` step — it computes candidates and
 * writes nothing (`functions/wizard.ts`) — so an import somebody has walked to step 3 and
 * abandoned is still re-enterable, which is the whole population of the owner's 204.
 */
export async function importsThatHaveWorked(
  reader: Tx | Database,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [stepped, moved] = await Promise.all([
    reader
      .selectDistinct({ importId: jobSteps.importId })
      .from(jobSteps)
      .where(and(inArray(jobSteps.importId, [...ids]), ne(jobSteps.step, "resolve"))),
    reader
      .selectDistinct({ importId: importTracks.importId })
      .from(importTracks)
      .where(
        and(
          inArray(importTracks.importId, [...ids]),
          or(
            ne(importTracks.state, "pending"),
            isNotNull(importTracks.downloadPath),
            isNotNull(importTracks.libraryPath),
          ),
        ),
      ),
  ]);
  return new Set([...stepped, ...moved].map((row) => row.importId));
}

/** Is this row, on its own columns alone, a candidate to re-enter or to collapse? */
export function isParked(job: Import): boolean {
  if (!(EARLY_STEPS as readonly string[]).includes(job.step)) return false;
  if (job.status === "pending") return true;
  /*
   * The creation that is in flight, and the single most important row in this function.
   *
   * `runStep` marks an import `running` for the whole of `resolve`, and a *successful*
   * `resolve` leaves it `running` at `match` — so the minute-long extraction the wizard's
   * `?url=` loader waits on, and the moment just after it, both read as `running`. A rule that
   * refused every `running` import refused the very row each re-entry inside that minute is
   * about, which is how the owner got four identical imports without refreshing anything.
   *
   * `running` is allowed **here** and then filtered by `importsThatHaveWorked`, which asks
   * `job_steps` whether anything past `resolve` has actually begun. That is the question
   * `status` cannot answer, and the two together are the whole rule: this function narrows by
   * what the row claims, that one by what was done.
   */
  if (job.status === "running") return true;
  // `paused_by = 'worker'` is a shutdown, and the boot sweep is what owns those rows.
  return job.status === "paused" && job.pausedBy !== "worker";
}

/** Is this row still being created — i.e. is somebody else inside `resolve` for it? */
export function isResolving(job: Import): boolean {
  return job.step === "resolve" && (job.status === "pending" || job.status === "running");
}

/**
 * The import a wizard entrance should re-enter for this URL, or `null` for "open a new one".
 *
 * `candidates` is every import of the URL, newest first; `working` is what `importsThatHaveWorked`
 * answered over them. Pure, so the table at the top of this file is testable without a
 * database and without a toolbox.
 */
export function pickReusable(
  candidates: readonly Import[],
  working: ReadonlySet<string>,
): Import | null {
  for (const job of candidates) {
    if (!isParked(job)) continue;
    if (working.has(job.id)) continue;
    return job;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* the cleanup                                                         */
/* ------------------------------------------------------------------ */

/** One URL's redundant siblings: the one kept, and the ones a collapse would cancel. */
export interface ParkedDuplicateGroup {
  readonly url: string;
  /** The newest parked import of this URL. Never cancelled. */
  readonly keep: string;
  readonly keepCreatedAt: string;
  /** The rest, newest first. */
  readonly cancel: readonly string[];
}

export interface CollapseResult {
  readonly groups: readonly ParkedDuplicateGroup[];
  /** How many rows were cancelled, or would be if `apply` were set. */
  readonly cancelled: number;
  readonly applied: boolean;
}

/**
 * Every URL with more than one import parked with nothing done, newest kept.
 *
 * Only `paused` rows, deliberately: a `pending` import is on the worker's queue, and cancelling
 * one is a different decision from tidying up after the wizard. The guard is the one stated at
 * the top of this file, and it is *checked* here rather than assumed — an import with a single
 * downloaded track is never in this list, however it came to be parked.
 */
export async function findParkedDuplicates(
  options: { readonly url?: string } = {},
  database: Database = defaultDb(),
): Promise<ParkedDuplicateGroup[]> {
  const rows = await database
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.status, "paused"),
        // `is distinct from`: `paused_by` is null on rows written before the column existed,
        // and null has to read as `user` — the side that is safe to tidy.
        sql`${imports.pausedBy} is distinct from 'worker'`,
        inArray(imports.step, [...EARLY_STEPS]),
        ...(options.url === undefined ? [] : [eq(imports.url, options.url)]),
      ),
    )
    .orderBy(desc(imports.createdAt));

  const working = await importsThatHaveWorked(
    database,
    rows.map((row) => row.id),
  );
  const idle = rows.filter((row) => !working.has(row.id));

  const byUrl = new Map<string, Import[]>();
  for (const row of idle) {
    const bucket = byUrl.get(row.url);
    if (bucket === undefined) byUrl.set(row.url, [row]);
    else bucket.push(row);
  }

  const groups: ParkedDuplicateGroup[] = [];
  for (const [url, bucket] of byUrl) {
    if (bucket.length < 2) continue;
    const [keep, ...rest] = bucket;
    if (keep === undefined) continue;
    groups.push({
      url,
      keep: keep.id,
      keepCreatedAt: keep.createdAt.toISOString(),
      cancel: rest.map((row) => row.id),
    });
  }
  // Worst first: "80 for The Hidden World" is the line the owner wants to read at the top.
  groups.sort((left, right) => right.cancel.length - left.cancel.length);
  return groups;
}

/** How many rows a collapse would cancel right now. The Jobs page asks this on every load. */
export async function countParkedDuplicates(database: Database = defaultDb()): Promise<number> {
  const groups = await findParkedDuplicates({}, database);
  return groups.reduce((sum, group) => sum + group.cancel.length, 0);
}

/**
 * Collapse the parked siblings of a URL — a dry run unless `apply` is set.
 *
 * Dry by default, like `mm relocate` and `mm library repair-orphans`: this cancels rows, and a
 * command that would cancel 197 imports must be able to say which ones before it does.
 *
 * `cancelImport` rather than an `update`, so a collapsed row gets its journal line and has its
 * open Inbox items closed — exactly as `mm cancel` would have left it.
 */
export async function collapseParkedDuplicates(
  options: { readonly url?: string; readonly apply?: boolean; readonly db?: Database } = {},
): Promise<CollapseResult> {
  const database = options.db ?? defaultDb();
  const groups = await findParkedDuplicates(
    options.url === undefined ? {} : { url: options.url },
    database,
  );
  const cancelled = groups.reduce((sum, group) => sum + group.cancel.length, 0);
  if (options.apply !== true) return { groups, cancelled, applied: false };

  // Imported at the call rather than at the top of the file: `jobs/index.ts` already reaches
  // into this module's neighbours, and the cycle would only exist on the write path.
  const { cancelImport } = await import("./jobs/index.ts");
  for (const group of groups) {
    for (const id of group.cancel) await cancelImport(id, database);
  }
  return { groups, cancelled, applied: true };
}
