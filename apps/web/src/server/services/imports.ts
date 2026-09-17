/**
 * `imports.service` — creating a job.
 *
 * `createImport` does one thing beyond inserting a row: it runs `resolve` **immediately**,
 * in the caller's process. That is deliberate. Whoever pasted the URL is still watching, and
 * the answer to "is this a video, an album or a playlist, and how many tracks?" is the first
 * thing they need; queueing it would turn a one-second question into a wait for a worker.
 * Everything after `resolve` is queued.
 *
 * Deduplication has three levels, matching `docs/04-pipeline-et-matching.md` § Règles:
 *  - the same URL already imported is *reported*, not refused — re-importing an album to pick
 *    up new metadata is legitimate;
 *  - **except** that a caller passing `reuse` re-enters an import that is merely parked
 *    waiting for somebody, rather than opening a second one beside it. That is the wizard, and
 *    only the wizard: see `CreateOptions.reuse` and `services/imports.reuse.ts`;
 *  - a recording already in the library is skipped at `download` time, unless `--force`.
 */
import { desc, eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  imports,
  libraryTracks,
  type Import,
  type ImportOptions,
  type NewImport,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { emit } from "./events.ts";
import { importsWithWork, isParked, lockUrl, pickReusable } from "./imports.reuse.ts";
import { runStep } from "./jobs/index.ts";
import type { StepResult } from "./jobs/machine.ts";
import { loadSettings } from "./settings.ts";
import { parseImportSource } from "./import-source.ts";
import type { SuppliedMapping } from "./jobs/steps/match.ts";

export interface CreateOptions extends ImportOptions {
  /** A release and a mapping supplied from outside — the P03 escape hatch, see `match`. */
  readonly mapping?: SuppliedMapping;
  readonly db?: Database;
  /** Resolve in-process before returning. On by default; the tests turn it off. */
  readonly resolveNow?: boolean;
  /**
   * Queue priority. Higher runs first; the default is 0, which is where a person's import
   * lands. A watched source passes a negative value, because a scan that found forty new
   * videos must not push a paste-box import to the back of the queue.
   */
  readonly priority?: number;
  /**
   * Re-enter an existing import for this source instead of opening a second one.
   *
   * **Off by default, and that is deliberate.** `POST /api/v1/imports`, `create_import` over
   * MCP, `mm import`, a batch and a watched-source scan all mean *open an import*, and
   * `docs/04` § Règles is explicit that re-importing a URL is allowed and reported rather than
   * refused. The wizard is the caller that means something else: it *parks* what it creates
   * and comes back to it, so a second visit that opens a second row is a bug — 204 of them on
   * the owner's instance, each one a yt-dlp extraction nobody asked for.
   *
   * Which imports qualify, status by status, is `services/imports.reuse.ts`.
   */
  readonly reuse?: boolean;
}

export interface CreateResult {
  readonly job: Import;
  /** Imports of the same URL that already exist, newest first. */
  readonly duplicates: readonly Import[];
  /** How many of the mapped recordings are already in the library. */
  readonly alreadyPresent: number;
  /**
   * `job` is an import that already existed and was re-entered, not a new row.
   *
   * The wizard shows this: switching somebody's import out from under them silently would be
   * worse than the duplicate it replaces.
   */
  readonly reused: boolean;
}

/**
 * Opening the confirmation gate obliges you to sign it.
 *
 * `autoConfirm` says only *that* the gate is open; `confirm` writes a `decisions` row and has
 * to name a decider. It used to infer `"cli --yes"` from `autoConfirm` alone, so the second
 * test report found MCP's own confirmations attributed to the CLI — and the third found the
 * *other* MCP path, `create_import` with `autoConfirm`, still doing it after the first had
 * been fixed. One forgotten call site is all it takes, so the rule is checked rather than
 * documented: every caller that opens the gate names itself, here and in `setImportOptions`,
 * the only two functions that can open it.
 */
export function assertSigned(options: { autoConfirm?: unknown; confirmedBy?: unknown }): void {
  if (options.autoConfirm !== true) return;
  const by = options.confirmedBy;
  if (typeof by === "string" && by.trim() !== "") return;
  throw new MMError(
    "INVALID_INPUT",
    "`autoConfirm` opens the confirmation gate, so it needs `confirmedBy`.",
    {
      hint: 'The caller names itself: "mcp", "api", "console", "cli --yes", "fixtures".',
      action: "Pass confirmedBy",
    },
  );
}

/**
 * A `fixture://` URL outside fixtures mode is refused here, in one second, rather than
 * discovered by the worker forty minutes later.
 *
 * The trap is that these URLs *half* work: the toolbox answers `/extract` from its recorded
 * data whatever mode it is in, so `resolve` and `match` succeed convincingly — and then
 * `download` hands `fixture://…` to yt-dlp, which answers
 * `Unsupported url scheme: "fixture"`, three times per track, holding the single download slot
 * and blocking every import queued behind it. The third test report reproduced exactly that:
 * fourteen tracks, forty-two failures, several minutes of a worker.
 *
 * The check is one `/health` call, and only on a `fixture://` URL — an ordinary import pays
 * nothing for it. An unreachable toolbox is **not** a refusal: `get_status` is where "the
 * toolbox is down" is diagnosed, and a create that failed for two possible reasons at once
 * would be worse than the failure it prevents.
 */
async function refuseFixtureOutsideFixtures(url: string, db: Database): Promise<void> {
  if (!url.toLowerCase().startsWith("fixture://")) return;
  const { downloaderHealth } = await import("./tools.ts");
  const health = await downloaderHealth({ db }).catch(() => null);
  if (health === null || !health.reachable || health.fixtures) return;

  throw new MMError(
    "INVALID_INPUT",
    `“${url}” is a recorded fixture and this toolbox is not in fixtures mode, so the download would fail.`,
    {
      hint:
        "`extract` would answer from the recordings and the import would look fine until " +
        "`download` handed `fixture://…` to yt-dlp, which cannot fetch it — three attempts per " +
        "track, holding the single download slot. Paste a real YouTube URL, or bring the stack " +
        "up with `MM_TOOLBOX_FIXTURES=1 bun run stack:up`. `get_status.toolbox.fixtures` says " +
        "which mode you are in.",
      action: "Use a real URL",
      details: { url, toolboxFixtures: false },
      status: 400,
    },
  );
}

/**
 * It was called `createFromUrl` and it took a URL. It now takes a **source**.
 *
 * The rename is not cosmetic: the validation it did was `/^(?:https?|fixture):\/\//`, and that
 * regular expression *was* the definition of what this application could import. A folder of
 * audio files is now a source too — because twenty of the owner's playlists have vanished from
 * YouTube, eight albums sit behind an age check, and an existing library is simply already on
 * the disk — so the check has moved into `parseImportSource`, which answers *which kind of
 * source this is* rather than *does this look like a link*.
 *
 * The column is still `imports.url`, and a folder is stored in it as a `file://` URL. One
 * string in one column keeps the duplicate report, `GET /imports?url=`, the journal and the
 * paste box working unchanged — and "this folder is already imported" is exactly the same
 * question as "this playlist is already imported", answered by the same index.
 */
export async function createImport(
  source: string,
  options: CreateOptions = {},
): Promise<CreateResult> {
  const db = options.db ?? defaultDb();
  // Whatever was typed, reduced to one canonical string: a URL as it stands, a folder as a
  // `file://` URL. Everything below this line works on `trimmed` and does not care which.
  const parsed = parseImportSource(source);
  const trimmed = parsed.url;

  assertSigned(options);
  await refuseFixtureOutsideFixtures(trimmed, db);

  const { mapping, db: _db, resolveNow, priority, reuse, ...rest } = options;
  void _db;
  const stored: Record<string, unknown> = { ...rest };
  if (mapping !== undefined) stored["mapping"] = mapping;
  if (mapping !== undefined && rest.releaseMbid === undefined) {
    stored["releaseMbid"] = mapping.releaseMbid;
  }

  const values: NewImport = {
    id: newId("import"),
    url: trimmed,
    // `resolve` corrects this the moment it has seen the entries. A folder starts as a
    // `playlist` like any other listing: it becomes `album` when the files agree on one.
    kind: trimmed.startsWith("fixture://") ? "album" : "playlist",
    status: "pending",
    step: "resolve",
    options: stored as ImportOptions,
    ...(priority === undefined ? {} : { priority }),
    ...(rest.releaseMbid === undefined ? {} : { releaseMbid: rest.releaseMbid }),
    ...(mapping?.releaseMbid === undefined ? {} : { releaseMbid: mapping.releaseMbid }),
  };

  const outcome =
    reuse === true
      ? await reuseOrInsert(db, trimmed, values)
      : await insertAlways(db, trimmed, values);

  if (outcome.reused) {
    // `resolveNow: false` says "do not resolve", and therefore also "do not wait for anyone
    // else's resolve": the tests that turn it off must not sit on the settle poll.
    const settled = resolveNow === false ? outcome.job : await settleResolve(outcome.job, db);
    const job = await applyPin(settled, rest.releaseMbid, db);
    await emit(
      {
        importId: job.id,
        type: "import.reused",
        message:
          `Re-entered the import opened ${job.createdAt.toISOString()} for ${trimmed} ` +
          `rather than opening another one.`,
        data: {
          url: trimmed,
          reusedCreatedAt: job.createdAt.toISOString(),
          reusedStatus: job.status,
          duplicates: outcome.duplicates.length,
        },
      },
      db,
    );
    /*
     * The one case where a re-entered import still has to resolve: a previous attempt died
     * between the insert and `resolve`, so the row exists, is `pending` at `resolve`, and has
     * no videos. `settleResolve` has already waited for anyone who might still be working on
     * it, so reaching here means nobody is.
     */
    if (job.status === "pending" && job.step === "resolve" && resolveNow !== false) {
      refuseOnAdmissionRule(
        await runStep(job.id, "resolve", { db, settings: await loadSettings(db) }),
      );
    }
    return {
      job: await reread(job, db),
      duplicates: outcome.duplicates,
      alreadyPresent: 0,
      reused: true,
    };
  }

  const created = outcome.job;
  await emit(
    {
      importId: created.id,
      type: "import.created",
      message: `Import created for ${trimmed}`,
      data: {
        url: trimmed,
        duplicates: outcome.duplicates.length,
        ...(outcome.duplicates.length === 0 ? {} : { previous: outcome.duplicates[0]?.id }),
      },
    },
    db,
  );

  if (resolveNow !== false) {
    const resolved = await runStep(created.id, "resolve", { db, settings: await loadSettings(db) });
    refuseOnAdmissionRule(resolved);
  }

  return {
    job: await reread(created, db),
    duplicates: outcome.duplicates,
    alreadyPresent: 0,
    reused: false,
  };
}

/** What the select-or-insert decided: the row to work on, its siblings, and which it is. */
interface CreateOutcome {
  readonly job: Import;
  readonly duplicates: readonly Import[];
  readonly reused: boolean;
}

/** Read the row back after the steps that may have moved it. */
async function reread(job: Import, db: Database): Promise<Import> {
  return (await db.select().from(imports).where(eq(imports.id, job.id)).limit(1))[0] ?? job;
}

/** The behaviour every non-wizard caller has always had: report the duplicates, insert anyway. */
async function insertAlways(db: Database, url: string, values: NewImport): Promise<CreateOutcome> {
  const duplicates = await db
    .select()
    .from(imports)
    .where(eq(imports.url, url))
    .orderBy(desc(imports.createdAt));
  const [created] = await db.insert(imports).values(values).returning();
  if (created === undefined) throw new MMError("UNKNOWN", "Could not create the import.");
  return { job: created, duplicates, reused: false };
}

/**
 * Look for an import to re-enter, and insert one only if there is none — **atomically**.
 *
 * The look and the insert are one transaction behind `pg_advisory_xact_lock` on the URL, so
 * two tabs, a double click or a retry cannot both decide "there is nothing here" and both
 * insert. The lock is held over two indexed reads and one insert; `resolve` is deliberately
 * outside it, because a transaction open across a yt-dlp extraction would hold a connection of
 * the shared pool for a minute.
 */
async function reuseOrInsert(db: Database, url: string, values: NewImport): Promise<CreateOutcome> {
  return await db.transaction(async (tx) => {
    await lockUrl(tx, url);
    const siblings = await tx
      .select()
      .from(imports)
      .where(eq(imports.url, url))
      .orderBy(desc(imports.createdAt));
    const working = await importsWithWork(
      tx,
      siblings.filter(isParked).map((row) => row.id),
    );
    const reusable = pickReusable(siblings, working);
    if (reusable !== null) {
      return {
        job: reusable,
        duplicates: siblings.filter((row) => row.id !== reusable.id),
        reused: true,
      };
    }
    const [created] = await tx.insert(imports).values(values).returning();
    if (created === undefined) throw new MMError("UNKNOWN", "Could not create the import.");
    return { job: created, duplicates: siblings, reused: false };
  });
}

/**
 * Wait for whoever created this row to finish resolving it.
 *
 * The race the lock does *not* close: the loser re-enters the winner's row a millisecond after
 * it was inserted, while the winner is still inside `resolve`. Returning then would show an
 * import with no videos and, worse, park a job in the middle of its own first step. So the
 * loser waits — on the row, not on a promise, because the winner is in another process as
 * often as not.
 *
 * Bounded: two minutes is longer than any extraction the toolbox will finish, and a row still
 * `pending` at `resolve` after it is one whose creator died, which the caller then resolves
 * itself.
 */
async function settleResolve(job: Import, db: Database, timeoutMs = 120_000): Promise<Import> {
  if (job.status !== "pending" || job.step !== "resolve") return job;
  const deadline = Date.now() + timeoutMs;
  let current = job;
  while (current.status === "pending" && current.step === "resolve" && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 250));
    current = await reread(current, db);
  }
  return current;
}

/**
 * Carry a release pinned in the palette onto the import being re-entered.
 *
 * ⌘K's order of events is "choose the release, then paste the URL", and the pin arrives on
 * `createImport`. Re-entering an import that was opened without one would drop it silently —
 * the one thing the pin's own callout promises will not happen — so it is written onto the row
 * instead. An import that already carries the same pin is left alone.
 */
async function applyPin(
  job: Import,
  releaseMbid: string | undefined,
  db: Database,
): Promise<Import> {
  if (releaseMbid === undefined || job.options.releaseMbid === releaseMbid) return job;
  await db
    .update(imports)
    .set({
      options: { ...job.options, releaseMbid },
      releaseMbid,
      updatedAt: new Date(),
    })
    .where(eq(imports.id, job.id));
  return await reread(job, db);
}

/**
 * The refusals that are answers rather than failures — raised at the caller, not filed away.
 *
 * Two families, one property: **nothing about them will be different in ten minutes.**
 *
 *  - the two `source-rules.ts` codes, i.e. "a rule you switched on said no";
 *  - the two a **folder source** produces: a folder outside `adoptSourceRoots`, and a folder
 *    with nothing the tagger can read. Both are a path somebody typed or a setting somebody
 *    has not written yet, and both are exactly as true on the tenth retry as on the first.
 */
const REFUSED_OUTRIGHT = new Set([
  "SOURCE_NOT_OFFICIAL",
  "SOURCE_NO_ALBUM",
  "ADOPT_PATH_REFUSED",
  "FOLDER_NO_AUDIO",
]);

/**
 * Re-raise such a refusal at the caller instead of leaving a failed job behind.
 *
 * Every other `resolve` failure is *reported*, not thrown: a bot check or a private video is
 * something to retry, and the job row is where a retry lives. These are not that. There is
 * nothing to retry, and whoever pasted the source is still looking at the box — so they get
 * the sentence, the hint naming the setting or the folder, and a 4xx, rather than a job in the
 * list that says "failed".
 *
 * The row is still written and still carries the same typed error. It is the record of what
 * was asked for and refused, which is the one thing a thrown error on its own would lose.
 */
function refuseOnAdmissionRule(result: StepResult): void {
  if (result.status !== "failed" || result.error === undefined) return;
  if (!REFUSED_OUTRIGHT.has(result.error.code)) return;
  throw MMError.fromBody(result.error);
}

/** Read one import. */
export async function getImport(id: string, db: Database = defaultDb()): Promise<Import | null> {
  const [row] = await db.select().from(imports).where(eq(imports.id, id)).limit(1);
  return row ?? null;
}

/**
 * How many of these recordings are already in the library.
 * Used by the CLI to say "0 downloads, already present" before anything runs.
 */
export async function countAlreadyPresent(
  recordingMbids: readonly string[],
  db: Database = defaultDb(),
): Promise<number> {
  let count = 0;
  for (const mbid of recordingMbids) {
    if (mbid === "") continue;
    const [row] = await db
      .select({ id: libraryTracks.id })
      .from(libraryTracks)
      .where(eq(libraryTracks.recordingMbid, mbid))
      .limit(1);
    if (row !== undefined) count += 1;
  }
  return count;
}
