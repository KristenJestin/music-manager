/**
 * `imports.service` — creating a job.
 *
 * `createImport` does one thing beyond inserting a row: it runs `resolve` **immediately**,
 * in the caller's process. That is deliberate. Whoever pasted the URL is still watching, and
 * the answer to "is this a video, an album or a playlist, and how many tracks?" is the first
 * thing they need; queueing it would turn a one-second question into a wait for a worker.
 * Everything after `resolve` is queued.
 *
 * Deduplication has two levels, matching `docs/04-pipeline-et-matching.md` § Règles:
 *  - the same URL already imported is *reported*, not refused — re-importing an album to pick
 *    up new metadata is legitimate;
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
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { emit } from "./events.ts";
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
}

export interface CreateResult {
  readonly job: Import;
  /** Imports of the same URL that already exist, newest first. */
  readonly duplicates: readonly Import[];
  /** How many of the mapped recordings are already in the library. */
  readonly alreadyPresent: number;
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

  const duplicates = await db
    .select()
    .from(imports)
    .where(eq(imports.url, trimmed))
    .orderBy(desc(imports.createdAt));

  const { mapping, db: _db, resolveNow, priority, ...rest } = options;
  void _db;
  const stored: Record<string, unknown> = { ...rest };
  if (mapping !== undefined) stored["mapping"] = mapping;
  if (mapping !== undefined && rest.releaseMbid === undefined) {
    stored["releaseMbid"] = mapping.releaseMbid;
  }

  const id = newId("import");
  const [created] = await db
    .insert(imports)
    .values({
      id,
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
    })
    .returning();

  if (created === undefined) throw new MMError("UNKNOWN", "Could not create the import.");

  await emit(
    {
      importId: id,
      type: "import.created",
      message: `Import created for ${trimmed}`,
      data: {
        url: trimmed,
        duplicates: duplicates.length,
        ...(duplicates.length === 0 ? {} : { previous: duplicates[0]?.id }),
      },
    },
    db,
  );

  if (resolveNow !== false) {
    const resolved = await runStep(id, "resolve", { db, settings: await loadSettings(db) });
    refuseOnAdmissionRule(resolved);
  }

  const job = (await db.select().from(imports).where(eq(imports.id, id)).limit(1))[0] ?? created;
  return { job, duplicates, alreadyPresent: 0 };
}

/** The two codes `source-rules.ts` raises, i.e. "a rule you switched on said no". */
const ADMISSION_CODES = new Set(["SOURCE_NOT_OFFICIAL", "SOURCE_NO_ALBUM"]);

/**
 * Re-raise an admission-rule refusal at the caller instead of leaving a failed job behind.
 *
 * Every other `resolve` failure is *reported*, not thrown: a bot check or a private video is
 * something to retry, and the job row is where a retry lives. A rule the operator switched on
 * is not that. Nothing about it will be different in ten minutes, there is nothing to retry,
 * and whoever pasted the URL is still looking at the box — so they get the sentence, the hint
 * naming the setting, and a 422, rather than a job in the list that says "failed".
 *
 * The row is still written and still carries the same typed error. It is the record of what
 * was asked for and refused, which is the one thing a thrown error on its own would lose.
 */
function refuseOnAdmissionRule(result: StepResult): void {
  if (result.status !== "failed" || result.error === undefined) return;
  if (!ADMISSION_CODES.has(result.error.code)) return;
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
