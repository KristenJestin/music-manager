/**
 * `imports.service` — creating a job.
 *
 * `createFromUrl` does one thing beyond inserting a row: it runs `resolve` **immediately**,
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
import { loadSettings } from "./settings.ts";
import type { SuppliedMapping } from "./jobs/steps/match.ts";

export interface CreateOptions extends ImportOptions {
  /** A release and a mapping supplied from outside — the P03 escape hatch, see `match`. */
  readonly mapping?: SuppliedMapping;
  readonly db?: Database;
  /** Resolve in-process before returning. On by default; the tests turn it off. */
  readonly resolveNow?: boolean;
}

export interface CreateResult {
  readonly job: Import;
  /** Imports of the same URL that already exist, newest first. */
  readonly duplicates: readonly Import[];
  /** How many of the mapped recordings are already in the library. */
  readonly alreadyPresent: number;
}

const URL_SHAPE = /^(?:https?:\/\/|fixture:\/\/)/i;

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
export function assertSigned(options: {
  autoConfirm?: unknown;
  confirmedBy?: unknown;
}): void {
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

export async function createFromUrl(
  url: string,
  options: CreateOptions = {},
): Promise<CreateResult> {
  const db = options.db ?? defaultDb();
  const trimmed = url.trim();
  if (!URL_SHAPE.test(trimmed)) {
    throw new MMError("INVALID_INPUT", `“${trimmed}” is not a URL this app can import.`, {
      hint: "Paste a YouTube link, or use `fixture://discovery` to run offline.",
      action: "Check the URL",
    });
  }

  assertSigned(options);

  const duplicates = await db
    .select()
    .from(imports)
    .where(eq(imports.url, trimmed))
    .orderBy(desc(imports.createdAt));

  const { mapping, db: _db, resolveNow, ...rest } = options;
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
      // `resolve` corrects this the moment it has seen the entries.
      kind: trimmed.startsWith("fixture://") ? "album" : "playlist",
      status: "pending",
      step: "resolve",
      options: stored as ImportOptions,
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
    await runStep(id, "resolve", { db, settings: await loadSettings(db) });
  }

  const job = (await db.select().from(imports).where(eq(imports.id, id)).limit(1))[0] ?? created;
  return { job, duplicates, alreadyPresent: 0 };
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
