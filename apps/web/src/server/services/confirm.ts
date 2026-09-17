/**
 * The confirmation gate, as one service.
 *
 * `docs/04-pipeline-et-matching.md` § `confirm` is the one deliberately blocking step: the
 * algorithm proposes, you decide. There are exactly two ways to answer it, and until now there
 * were three *transcriptions* of the first and none of the second.
 *
 *  - **Supplied** — "here is the release and the video → track mapping I want". That is the
 *    wizard's Start button, `POST /api/v1/imports/{id}/confirm-mapping` and MCP's
 *    `confirm_mapping`. Its logic was written out in the wizard's server function and again in
 *    the REST route, which the route's own header already apologised for; `confirmSupplied`
 *    below is that code, once.
 *  - **Proposed** — "what `match` already worked out is right, start it". That had *no* door
 *    from the Console at all. An import parked at `awaiting_confirm` outside the wizard — which
 *    is what a batch import and a watched source produce — could only be confirmed from
 *    `/api/v1`, MCP or `mm`, so the job page offered Retry and Cancel and no way to say yes.
 *    `confirmProposed` is that door, and it is deliberately *not* a variant of the first: it
 *    supplies nothing, re-runs nothing, and simply opens the gate, signed, so `confirmStep`
 *    writes the same `decisions` row it writes for every other caller.
 *
 * Neither function decides anything itself. `confirm.ts` in `jobs/steps/` is still the only
 * place a release is confirmed, the only place `decisions` gains a `kind: "release"` row, and
 * the only place preferences are learned from one. What lives here is who is allowed to open
 * the gate and what they have to sign it with.
 */
import { and, count, eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { importTracks, type Import, type InboxType } from "#/server/db/schema/index.ts";
import { setImportOptions } from "#/server/services/console.queries.ts";
import { getImport } from "#/server/services/imports.ts";
import { listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { resumeStepOf, runStep } from "#/server/services/jobs/index.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
import { enqueue } from "#/server/services/queue.ts";
import { loadSettings } from "#/server/services/settings.ts";

/**
 * The two item types that mean "this import is waiting for your yes".
 *
 * `awaiting_confirm` is the ordinary gate; `source_new_video` is the same gate for an import a
 * watched source opened and did not feel entitled to accept. They read differently on the card
 * — one names the source, the other does not — and they are answered by the same act, so
 * confirming closes whichever of the two is open. Exported because `steps/confirm.ts` closes
 * the same pair when the gate is opened by somebody who never looked at the Inbox.
 */
export const WAITING_FOR_YES: readonly InboxType[] = ["awaiting_confirm", "source_new_video"];

/** `low | normal | next` as the priority column stores it. The wizard's three, spelled once. */
export const PRIORITY: Record<"low" | "normal" | "next", number> = {
  low: -10,
  normal: 0,
  next: 100,
};

export interface ConfirmSuppliedInput {
  readonly importId: string;
  /**
   * Who is confirming. Written to `imports.options.confirmedBy` and from there to the
   * `decisions` row — `console`, `api`, `mcp`, `cli --yes`. `setImportOptions` refuses an
   * unsigned confirmation, so this is not optional in practice however it is typed.
   */
  readonly confirmedBy: string;
  readonly mapping: SuppliedMapping;
  readonly options: {
    readonly fingerprint: boolean;
    readonly lyrics: boolean;
    readonly replaygain: boolean;
    readonly force: boolean;
  };
  readonly priority: number;
  /** How the `extra_videos` notices this closes should read in the decision log. */
  readonly acknowledgedIn: string;
  /** What the queue entry says it was queued for. */
  readonly reason: string;
}

export interface ConfirmOutcome {
  readonly job: Import;
  readonly mapped: number;
  readonly extras: number;
  readonly uncovered: number;
}

/**
 * Confirm a release and a mapping somebody chose, then hand the job to the worker.
 *
 * `match` runs **here**, synchronously, rather than on the worker: it is the step that
 * *applies* a supplied mapping, there is no MusicBrainz call left to make, and running it now
 * is what lets the caller's response say "14 mapped, 1 extra" instead of "queued".
 */
export async function confirmSupplied(
  input: ConfirmSuppliedInput,
  db: Database = defaultDb(),
): Promise<ConfirmOutcome> {
  const job = await getImport(input.importId, db);
  if (job === null) {
    throw new MMError("NOT_FOUND", `No import with id ${input.importId}.`, { status: 404 });
  }

  await setImportOptions(
    input.importId,
    {
      mapping: input.mapping,
      releaseMbid: input.mapping.releaseMbid,
      fingerprint: input.options.fingerprint,
      lyrics: input.options.lyrics,
      replaygain: input.options.replaygain,
      force: input.options.force,
      // Supplying the mapping *is* the confirmation: you have just seen the release, the
      // mapping and the options and pressed Start. Blocking on `confirm` afterwards would ask
      // the same question twice.
      autoConfirm: true,
      confirmedBy: input.confirmedBy,
    },
    { priority: input.priority, releaseMbid: input.mapping.releaseMbid },
    db,
  );

  const settings = await loadSettings(db);
  const result = await runStep(input.importId, "match", { db, settings });

  // Videos outside the tracklist were shown before Start and accepted by pressing it.
  await acknowledgeExtras(input.importId, input.confirmedBy, input.acknowledgedIn, db);

  const open = await listInbox({ importId: input.importId, status: "open" }, db);
  await enqueue(input.importId, input.reason);

  const info = (result.data ?? {}) as { mapped?: number; extras?: number };
  return {
    job: (await getImport(input.importId, db)) ?? job,
    mapped: info.mapped ?? input.mapping.tracks.length,
    extras: info.extras ?? 0,
    uncovered: open.filter((item) => item.type === "uncovered_tracks").length,
  };
}

/**
 * Accept the mapping `match` already wrote, and let the job carry on.
 *
 * Nothing is supplied and nothing is re-run: the rows already carry their release, their track
 * positions and their recording MBIDs, and the job page is showing them. All that is missing is
 * the answer to the question `confirm` asked, so the gate is opened — signed — and the worker
 * takes the job from where it stopped.
 *
 * When an `awaiting_confirm` Inbox item exists for this import it is *answered* rather than
 * side-stepped, so the review queue empties, the decision is logged where every other decision
 * is logged, and the same act works identically from the Console, `/api/v1`, MCP and the CLI.
 */
export async function confirmProposed(
  importId: string,
  confirmedBy: string,
  db: Database = defaultDb(),
): Promise<{ job: Import; mapped: number }> {
  const job = await getImport(importId, db);
  if (job === null) {
    throw new MMError("NOT_FOUND", `No import with id ${importId}.`, { status: 404 });
  }
  if (job.status !== "awaiting_confirm") {
    throw new MMError(
      "INVALID_INPUT",
      `Import ${importId} is ${job.status}, not waiting for a confirmation.`,
      {
        hint: "Only an import parked on the `confirm` step can be confirmed. Retry it first if it failed.",
        status: 409,
      },
    );
  }

  const item = (await listInbox({ importId, status: "open" }, db)).find((row) =>
    WAITING_FOR_YES.includes(row.type),
  );
  if (item === undefined) {
    // No item — an import parked before this type existed, or one whose item was dismissed.
    // Opening the gate is the whole of the answer either way.
    await setImportOptions(importId, { autoConfirm: true, confirmedBy }, {}, db);
  } else {
    // `applyResolution` opens the gate for `action: "confirm"`, so the Console, the API, MCP
    // and the CLI all confirm through one line of code rather than four.
    await resolveInboxItem(
      item.id,
      { resolution: { action: "confirm" }, decidedBy: confirmedBy },
      db,
    );
  }

  const step = await resumeStepOf(importId, db);
  await enqueue(importId, `${confirmedBy} confirm`, step);

  const [tally] = await db
    .select({ total: count() })
    .from(importTracks)
    .where(and(eq(importTracks.importId, importId), eq(importTracks.role, "mapped")));

  return { job: (await getImport(importId, db)) ?? job, mapped: Number(tally?.total ?? 0) };
}

/** Close the `extra_videos` notices of an import, recording who answered and how. */
async function acknowledgeExtras(
  importId: string,
  decidedBy: string,
  acknowledgedIn: string,
  db: Database,
): Promise<void> {
  for (const item of await listInbox({ importId, status: "open" }, db)) {
    if (item.type !== "extra_videos") continue;
    await resolveInboxItem(
      item.id,
      { resolution: { action: "ignore", acknowledgedIn }, decidedBy },
      db,
    );
  }
}
