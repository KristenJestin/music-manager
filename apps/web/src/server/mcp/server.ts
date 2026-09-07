/**
 * The MCP server (`docs/phases/P08-api-agents.md` § MCP).
 *
 * Twenty tools and two resource families over the *same service layer* the REST API and the
 * Console use. No tool touches the database directly, which is the rule the spec states and
 * the reason an agent's view of a candidate list is the same view a human gets.
 *
 * `toolTable()` is the count. `docs/06-stack.md` lists the same twenty, and `server.test.ts`
 * asserts the length, because a table that quietly gained four tools while the documentation
 * still said fourteen is exactly the drift an agent reads and believes.
 *
 * ## Why there is no OAuth here
 *
 * The spec allows Better Auth's MCP plugin "only if simple". It is not. In 1.7 `@better-auth/mcp`
 * *is* the OAuth 2.1 authorization server: it requires the `jwt` plugin, a login page, a consent
 * page, a canonical HTTPS resource URL, and five more tables (`oauthClient`, `oauthAccessToken`,
 * `oauthRefreshToken`, `oauthConsent`, `oauthClientAssertion`). All of that exists to solve a
 * problem this app does not have — letting *strangers* delegate access through a browser
 * consent screen. Here there is one account and the operator can paste a key.
 *
 * So `/mcp` authenticates with the same API key as everything else, `Authorization: Bearer mm_…`,
 * and the package is not installed. If interactive OAuth is ever wanted, this is the decision to
 * revisit; it is recorded in `docs/decisions.md`.
 *
 * ## Scopes
 *
 * Each tool declares the scope it needs, and the server built for a request only **registers**
 * the tools that request's key may call. A `library:read` key therefore sees the handful it may
 * call in `tools/list` rather than twenty of which most fail — which is the difference between
 * an agent that plans correctly and one that discovers its limits by hitting them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { grants, type ApiPrincipal, type ApiScope } from "@mm/contracts";
import { TAGS } from "@mm/domain";
import { db } from "#/server/db/client.ts";
import { APP_VERSION } from "#/server/version.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import { jobDetail, setImportOptions } from "#/server/services/console.queries.ts";
import { listImports, runStep } from "#/server/services/jobs/index.ts";
import { hintsFor, rankFor, videosOf } from "#/server/services/matching.queries.ts";
import { listInbox, resolveInboxBatch } from "#/server/services/inbox.ts";
import { albumDetail, albumGrid, artistList, trackList } from "#/server/services/library.ts";
import { discoverList, explainDiscover, syncDiscover } from "#/server/services/discover.ts";
import {
  abbreviateChange,
  createRun,
  DIFF_VALUE_LIMIT,
  runToCompletion,
  runView,
} from "#/server/services/retag.ts";
import { relocate } from "#/server/services/relocate.ts";
import { systemStatus } from "#/server/services/status.ts";
import { getScan, recentScans, summariseScan } from "#/server/services/scan.ts";
import { verifyAlbum, verifyLibrary } from "#/server/services/verify.ts";
import { updateYtdlp } from "#/server/services/tools.ts";
import {
  loadSettings,
  maskedSettings,
  setSettings,
} from "#/server/services/settings.ts";
import { enqueue, enqueueLibraryScan, enqueueRetagRun } from "#/server/services/queue.ts";
import {
  IMPORT_STATUSES,
  INBOX_TYPES,
  type ImportStatus,
  type InboxType,
} from "#/server/db/schema/enums.vocab.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";

/** MCP answers with content blocks; every tool here returns one block of JSON. */
function json(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** A tool that failed. `isError` is how MCP distinguishes "no" from a transport fault. */
function failed(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

/* ------------------------------------------------------------------ */
/* the documents served as resources                                   */
/* ------------------------------------------------------------------ */

/**
 * Where the specification lives: one level above this repository.
 *
 * `CLAUDE.md` is explicit that `v2/` holds code only and the docs are the parent folder's. The
 * path is derived from this module's own URL rather than from `process.cwd()`, because the
 * worker, the CLI and the web server are all started from different directories.
 */
function docsDirectory(): string {
  return fileURLToPath(new URL("../../../../../../docs/", import.meta.url));
}

interface DocEntry {
  readonly name: string;
  readonly uri: string;
  readonly path: string;
}

/**
 * Every `.md` under `docs/`, one level deep plus `phases/`.
 *
 * **Absent is not an error.** A production container ships the code without the specification
 * beside it, and an MCP server that refused to start there would be broken by a design choice
 * made in `CLAUDE.md`. The spec says as much: "if absent, empty list".
 */
export function listDocs(): DocEntry[] {
  const root = docsDirectory();
  const out: DocEntry[] = [];
  const walk = (prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, prefix), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && prefix === "") walk(entry.name);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        out.push({
          name: relative,
          uri: `mm://docs/${relative}`,
          path: join(root, relative),
        });
      }
    }
  };
  walk("");
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* helpers the tools share                                             */
/* ------------------------------------------------------------------ */

/**
 * Statuses in which a confirmation is a confirmation.
 *
 * `awaiting_confirm` is the wizard gate; `awaiting_review` is an Inbox question. Anything else
 * — `done`, `failed`, `running`, `cancelled` — is an import whose mapping already exists, and
 * replacing it is a rollback, not an answer.
 */
const CONFIRMABLE: readonly ImportStatus[] = ["awaiting_confirm", "awaiting_review", "pending"];

/**
 * A candidate with its reasoning removed.
 *
 * `fitLines` is one entry per video, repeated identically on every candidate: thirteen videos
 * across twelve candidates is a hundred and fifty-six lines saying the same thing, and it made
 * `get_candidates` the single most expensive call on the server (~11 000 tokens for one
 * import). What survives is what a reader needs to decide whether to look closer.
 */
function summariseCandidate(candidate: object): Record<string, unknown> {
  const source = candidate as Record<string, unknown>;
  const pick = (key: string): unknown => source[key];
  return {
    id: pick("id"),
    title: pick("title"),
    artist: pick("artist"),
    year: pick("year"),
    country: pick("country"),
    format: pick("format"),
    tracks: pick("tracks"),
    score: pick("score"),
    fit: pick("fit"),
    fitOf: pick("fitOf"),
    detailed: pick("detailed"),
    why: pick("why"),
    /** How much was elided, so nobody has to wonder whether the field is gone or empty. */
    omitted: ["fitLines", "signals", "penalties"],
  };
}

/*
 * There is no `truncateErrors` helper here any more, on purpose.
 *
 * It computed `more` as `rows.length - limit` over rows the caller had *already* cut to
 * `limit`, so it could only ever answer 0 — `moreErrors: 0` on a run hiding eleven errors,
 * `moreDiffs: 0` on one hiding twenty-six. A list that has been truncated cannot count what it
 * no longer contains, so every "more" below is computed against a total obtained separately:
 * `runView().totals` (counted in SQL) and `summariseScan` (which cuts the full arrays itself).
 */

/* ------------------------------------------------------------------ */
/* the tools                                                           */
/* ------------------------------------------------------------------ */

interface ToolSpec {
  readonly name: string;
  readonly scope: ApiScope;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodType>;
  /**
   * Declared with **method syntax**, deliberately.
   *
   * Each tool below writes its own parameter type — `{ importId: string }`, `{ query: string;
   * limit: number }` — and this is one array holding all fourteen. A function *property*
   * (`run: (args: X) => …`) is checked contravariantly under `strictFunctionTypes`, so none of
   * them would be assignable to a common signature and the table would need an `any`. A
   * *method* is checked bivariantly, which is exactly the trade this table wants: the argument
   * is validated against `inputSchema` by the SDK before `run` is ever called, so the narrow
   * type is a description of what the schema already guarantees rather than an unchecked claim.
   */
  run(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * The tools of the spec, as data — P08's fourteen, P09's `list_discover`, and the four the
 * external MCP test report asked for: `get_status`, `discover_sync`, `scan` and `relocate`.
 *
 * A table rather than twenty `server.registerTool(...)` calls, so that "which tools does this
 * key get?" is one `filter` and the scope of each tool is visible next to its name rather than
 * buried in its body.
 */
export function toolTable(): ToolSpec[] {
  return [
    {
      name: "list_discover",
      scope: "library:read",
      title: "List recommendations",
      description:
        "What Discover currently proposes: discography gaps (release-groups missing from the " +
        "library for artists you actually play), ListenBrainz recommendations, and similar " +
        "artists. Every item carries a score, a plain-English reason and its MusicBrainz ids — " +
        "so a suggestion can be checked against the library with `search_library` before " +
        "anything is queued. Read-only; it never recomputes.",
      inputSchema: {
        kind: z
          .enum(["discography", "recommendation", "similar_artist"])
          .optional()
          .describe("Only one of the three blocks."),
        limit: z.number().int().min(1).max(200).default(25),
      },
      run: async (args: {
        kind?: "discography" | "recommendation" | "similar_artist";
        limit: number;
      }) => {
        const payload = await discoverList({
          db: db(),
          limit: args.limit,
          ...(args.kind === undefined ? {} : { kind: args.kind }),
        });
        const trim = (
          items: readonly {
            id: string;
            title: string;
            artist: string;
            score: number;
            reason: string;
            source: string;
            inLibrary: boolean;
            releaseGroupMbid: string | null;
            recordingMbid: string | null;
          }[],
        ) =>
          items.map((item) => ({
            id: item.id,
            title: item.title,
            artist: item.artist,
            score: Math.round(item.score * 100) / 100,
            reason: item.reason,
            source: item.source,
            inLibrary: item.inLibrary,
            releaseGroupMbid: item.releaseGroupMbid,
            recordingMbid: item.recordingMbid,
          }));
        const found =
          payload.discography.length +
          payload.recommendations.length +
          payload.similarArtists.length;
        return {
          lastSync: payload.lastSync,
          windowDays: payload.signals.windowDays,
          topArtists: payload.signals.topArtists,
          topGenres: payload.signals.topGenres,
          discography: trim(payload.discography),
          recommendations: trim(payload.recommendations),
          similarArtists: trim(payload.similarArtists),
          /*
           * Three empty blocks next to a successful `lastSync` read as "Discover is broken",
           * and the second MCP test report drew exactly that conclusion. The reason is always
           * knowable — no ListenBrainz user, no Navidrome, nothing played in the window — so
           * it is said here, in the same words `discover_sync` uses.
           */
          notes:
            found > 0
              ? []
              : explainDiscover({
                  settings: await loadSettings(db()),
                  totalPlays: payload.signals.totalPlays,
                  topArtists: payload.signals.topArtists.length,
                  signalsError: payload.signals.error,
                  found,
                }),
        };
      },
    },
    {
      name: "list_imports",
      scope: "imports:read",
      title: "List imports",
      description:
        "Recent import jobs, newest first, with their status and current step. Start here to " +
        "find the id of something already in flight.",
      inputSchema: {
        status: z
          .enum(IMPORT_STATUSES)
          .optional()
          .describe("Filter on one status, e.g. `awaiting_review`, `running`, `done`."),
        limit: z.number().int().min(1).max(100).default(20),
      },
      // `z.string()` here, cast to `never` on the way into the query, sent an unknown status
      // straight to Postgres — which answered with the failed statement, so the *schema of the
      // `imports` table* travelled back to the caller inside an error message. The enum is the
      // same one the column is, so a bad value is refused by the SDK before any query exists.
      run: async (args: { status?: ImportStatus; limit: number }) => {
        const rows = await listImports(
          {
            limit: args.limit,
            ...(args.status === undefined ? {} : { status: args.status }),
          },
          db(),
        );
        return rows.map((row) => ({
          id: row.id,
          url: row.url,
          status: row.status,
          step: row.step,
          title: row.title,
          releaseMbid: row.releaseMbid,
          createdAt: row.createdAt.toISOString(),
        }));
      },
    },
    {
      name: "get_import",
      scope: "imports:read",
      title: "Get one import",
      description:
        "One import in full: every step and its outcome, the source videos, and any open Inbox " +
        "items blocking it. If `inbox` is non-empty the job is waiting for a decision.\n\n" +
        "Each entry of `tracks` carries the mapping the matcher settled on — `trackPosition`, " +
        "`mediumPosition`, `recordingMbid`, `trackMbid`, `trackTitle` — which is exactly the " +
        "shape `confirm_mapping.bindings[]` expects. Re-confirming an import without losing " +
        "its identifiers is therefore a copy, not a guess.",
      inputSchema: { importId: z.string().min(1) },
      run: async (args: { importId: string }) => {
        const detail = await jobDetail(args.importId, db());
        if (detail === null) throw new Error(`No import with id ${args.importId}.`);
        return {
          id: detail.job.id,
          url: detail.job.url,
          status: detail.job.status,
          step: detail.job.step,
          title: detail.job.title,
          releaseMbid: detail.job.releaseMbid,
          error: detail.job.error,
          // `failedCount` at the job level, because a job can sit at `running` with
          // `error: null` while five of its tracks fail in a loop — which is what it did.
          failedCount: detail.tracks.filter((track) => track.state === "failed").length,
          steps: detail.steps.map(({ step, row }) => ({
            step,
            status: row?.status ?? "pending",
            message: row?.message ?? null,
            error: row?.error ?? null,
          })),
          tracks: detail.tracks.map((track) => ({
            position: track.position,
            title: track.sourceTitle,
            durationSeconds: track.sourceDuration,
            state: track.state,
            attempts: track.attempts,
            /*
             * The mapping, in `confirm_mapping.bindings[]`'s own vocabulary.
             *
             * These four columns have always been on the row; nothing exposed them, so an
             * agent re-confirming an import had to send `recordingMbid: null` on every track.
             * The `fingerprint` step then compared the audio against a mapping with no
             * identifiers and disagreed thirteen times out of thirteen — a self-inflicted
             * pile of Inbox items whose payload contained the value that was withheld here.
             */
            trackPosition: track.trackPosition,
            mediumPosition: track.mediumPosition,
            recordingMbid: track.recordingMbid,
            trackMbid: track.trackMbid,
            trackTitle: track.trackTitle,
            // The reason lived in `import_tracks.error` all along and was simply not read
            // here, so `state: "failed"` was the whole of what an agent could learn.
            error: track.error ?? null,
          })),
          inbox: detail.inbox.map((item) => ({
            id: item.id,
            type: item.type,
            title: item.title,
          })),
        };
      },
    },
    {
      name: "create_import",
      scope: "imports:write",
      title: "Create an import",
      description:
        "Queue a YouTube URL. Resolves the source immediately, then hands the job to the " +
        "worker. Poll `get_import`, or set `autoConfirm` to let it run past the confirmation " +
        "gate without asking.\n\n" +
        "`fixture://…` URLs (`fixture://discovery`, `fixture://skinny-love`, " +
        "`fixture://currents`) are for **fixtures mode only**, and the trap is that they half " +
        "work outside it: the toolbox answers `extract` from its recordings whatever mode it " +
        "is in, so the import resolves and matches convincingly — and then `download` hands " +
        "`fixture://…` to yt-dlp, which cannot fetch it, and the job dies there. `get_status` " +
        "reports `toolbox.fixtures`; check it before reaching for one.",
      inputSchema: {
        url: z.string().min(1).describe("A YouTube URL, or `fixture://…` in fixtures mode."),
        releaseMbid: z
          .uuid()
          .optional()
          .describe("Pin this MusicBrainz release instead of letting the matcher choose."),
        autoConfirm: z.boolean().default(false),
        force: z.boolean().default(false).describe("Re-import even if the tracks are present."),
      },
      run: async (args: {
        url: string;
        releaseMbid?: string;
        autoConfirm: boolean;
        force: boolean;
      }) => {
        const created = await createFromUrl(args.url, {
          db: db(),
          ...(args.releaseMbid === undefined ? {} : { releaseMbid: args.releaseMbid }),
          autoConfirm: args.autoConfirm,
          // The provenance fix reached `confirm_mapping` and stopped there, so an import
          // created *here* with `autoConfirm` was still logged as `cli --yes` in `decisions`.
          // `createFromUrl` now refuses an unsigned `autoConfirm`, which is what stops the
          // next caller inheriting the same silence.
          ...(args.autoConfirm ? { confirmedBy: "mcp" } : {}),
          force: args.force,
        });
        await enqueue(created.job.id, "mcp");
        /*
         * `resolve` runs inside `createFromUrl`, so a URL that cannot be resolved comes back
         * as a *created* import in `failed` — and this tool used to answer `{status:"failed",
         * duplicates:[…]}`, which reads as "the duplicate is the problem" and needed a second
         * call to learn it was a 422 from the toolbox. The reason travels with the verdict.
         */
        const failure = created.job.error ?? null;
        return {
          importId: created.job.id,
          status: created.job.status,
          step: created.job.step,
          title: created.job.title,
          duplicates: created.duplicates.map((row) => row.id),
          error: failure,
          ...(created.job.status === "failed" && failure === null
            ? { note: "The import failed but recorded no error; `get_import` has the steps." }
            : {}),
        };
      },
    },
    {
      name: "get_candidates",
      scope: "imports:read",
      title: "Get the MusicBrainz candidates",
      description:
        "The ranked releases (or recordings, for a single) this import could be, with the " +
        "preselection, its margin over the runner-up, and why each scored what it did. " +
        "Computed on demand — asking decides nothing.\n\n" +
        '`detail: "summary"` (the default) carries the full reasoning — `fitLines`, ' +
        "`signals`, `penalties` — for the preselected candidate and the runner-up only, and " +
        "reduces the rest to `{id, title, artist, year, score, fit, why}`. That is the pair a " +
        "decision is actually made between; the other ten repeat the same thirteen `fitLines` " +
        'verbatim and cost about ten times more to read than they inform. `detail: "full"` ' +
        "returns everything, for when a candidate further down needs inspecting.\n\n" +
        "**Each `fitLines` entry is a ready-made binding.** It carries `videoIndex` (which is " +
        "`confirm_mapping`'s `position`), `trackPosition`, `mediumPosition`, `recordingMbid`, " +
        "`trackMbid` and `trackTitle`, so confirming the preselection is a copy of the lines " +
        "whose `status` is not `unbound` — no identifier has to be invented, and none has to " +
        "be sent as `null`. Sending `recordingMbid: null` is what makes the `fingerprint` " +
        "step disagree with your own mapping on every track.",
      inputSchema: {
        importId: z.string().min(1),
        detail: z.enum(["summary", "full"]).default("summary"),
        limit: z.number().int().min(1).max(25).default(12),
      },
      run: async (args: { importId: string; detail: "summary" | "full"; limit: number }) => {
        const job = await getImport(args.importId, db());
        if (job === null) throw new Error(`No import with id ${args.importId}.`);
        const settings = await loadSettings(db());
        const result = await rankFor({ job, settings, db: db() });
        const { videos } = await videosOf(job.id, db());
        const hints = hintsFor(job, videos);
        const candidates = result.ranking.candidates.slice(0, args.limit);

        /*
         * The two that matter are the preselected one and the one closest behind it — the
         * `margin` field is the distance between exactly those two, so they are what a caller
         * has to compare. Everything else keeps its identity, its score and its `why`, which
         * is enough to ask for `detail: "full"` if one of them looks wrong.
         */
        const detailed = new Set<string>();
        const preselected = candidates.find((entry) => entry.preselected) ?? candidates[0];
        if (preselected !== undefined) detailed.add(preselected.id);
        const runnerUp = candidates.find((entry) => entry.id !== preselected?.id);
        if (runnerUp !== undefined) detailed.add(runnerUp.id);

        return {
          kind: result.kind,
          detail: args.detail,
          preselectedId: result.ranking.preselected?.id ?? null,
          safe: result.ranking.preselected?.safe ?? false,
          ambiguous: result.ranking.ambiguous,
          margin: result.ranking.margin,
          hints: { album: hints.album ?? null, artist: hints.artist ?? null },
          candidates:
            args.detail === "full"
              ? candidates
              : candidates.map((entry) =>
                  detailed.has(entry.id) ? entry : summariseCandidate(entry),
                ),
        };
      },
    },
    {
      name: "confirm_mapping",
      scope: "imports:write",
      title: "Confirm the release and the mapping, and start",
      description:
        "Choose which release this import is and which video becomes which track, then start " +
        "it. `releaseMbid: null` means *import without MusicBrainz*: the tags come from the " +
        "source alone and the album is flagged `untagged`. A video absent from `bindings` " +
        "becomes an 'extra' and is not downloaded.\n\n" +
        "**This is destructive on an import that is already finished.** It only accepts an " +
        "import waiting for you (`awaiting_review` or `awaiting_confirm`); confirming a `done` " +
        "import would throw its mapping away and re-run the job, so that needs `force: true` " +
        "and is worth being sure about. `position` is the video's index *in this source* and is " +
        "checked against it — an index that matches no video is refused, not silently ignored. " +
        "The decision is logged with `decidedBy: mcp`.\n\n" +
        "The return value describes **this call**: `applied` is what the `match` step really " +
        "did, `jobStatus` is where the job stands afterwards. They answer different questions.",
      inputSchema: {
        importId: z.string().min(1),
        releaseMbid: z
          .uuid()
          .nullable()
          .describe("A MusicBrainz release id (a UUID), or `null` to import without MusicBrainz."),
        album: z.string().default(""),
        albumArtist: z.string().default(""),
        year: z.number().int().nullable().default(null),
        trackTotal: z.number().int().min(0).default(0),
        force: z
          .boolean()
          .default(false)
          .describe("Confirm even when the import is not waiting for a decision. Destructive."),
        bindings: z
          .array(
            z.object({
              position: z.number().int().min(0).describe("The video's index in the source."),
              trackPosition: z.number().int().min(1),
              mediumPosition: z.number().int().min(1).default(1),
              recordingMbid: z.uuid().nullable(),
              trackTitle: z.string().default(""),
            }),
          )
          .min(1),
      },
      run: async (args: {
        importId: string;
        releaseMbid: string | null;
        album: string;
        albumArtist: string;
        year: number | null;
        trackTotal: number;
        force: boolean;
        bindings: {
          position: number;
          trackPosition: number;
          mediumPosition: number;
          recordingMbid: string | null;
          trackTitle: string;
        }[];
      }) => {
        const job = await getImport(args.importId, db());
        if (job === null) throw new Error(`No import with id ${args.importId}.`);

        /*
         * The state guard. One call with a nonsense `position` took a `done` album from 13
         * mapped tracks to 0 and 13 "extras", skipped every step, and reported success —
         * because nothing here asked whether the import was in a state where a confirmation
         * means anything. It only does while the job is waiting for one.
         */
        if (!CONFIRMABLE.includes(job.status) && !args.force) {
          throw new Error(
            `This import is \`${job.status}\`, not waiting for a decision. Confirming it would ` +
              `discard its current mapping and re-run the job. Pass \`force: true\` if that is ` +
              `what you want. (Confirmable statuses: ${CONFIRMABLE.join(", ")}.)`,
          );
        }

        /*
         * `position` is an index into *this import's* videos. An index that matches none of
         * them used to become "no binding at all", quietly — which is how thirteen bound
         * tracks became thirteen extras without a single warning.
         */
        const { rows: videos } = await videosOf(job.id, db());
        if (videos.length === 0) {
          throw new Error(
            "This import has no videos yet, so there is nothing to bind. Run `get_import` — " +
              "the `resolve` step has not produced any source video.",
          );
        }
        const known = new Set(videos.map((video) => video.position));
        const strays = [...new Set(args.bindings.map((b) => b.position))].filter(
          (position) => !known.has(position),
        );
        if (strays.length > 0) {
          const range = [...known].sort((a, b) => a - b);
          throw new Error(
            `UNKNOWN_VIDEO_POSITION: no video at position ${strays.join(", ")} in this import. ` +
              `The source has ${String(videos.length)} video(s), at position(s) ${range.join(", ")}.`,
          );
        }

        const mapping: SuppliedMapping = {
          releaseMbid: args.releaseMbid,
          ...(args.album === "" ? {} : { album: args.album }),
          ...(args.albumArtist === "" ? {} : { albumArtist: args.albumArtist }),
          year: args.year,
          trackTotal: args.trackTotal,
          tracks: args.bindings.map((binding) => ({
            position: binding.position,
            trackPosition: binding.trackPosition,
            mediumPosition: binding.mediumPosition,
            recordingMbid: binding.recordingMbid,
            trackTitle: binding.trackTitle,
            confidence: 1,
          })),
        };
        await setImportOptions(
          args.importId,
          {
            mapping,
            releaseMbid: args.releaseMbid,
            autoConfirm: true,
            // Provenance, so `confirm` does not log an agent's decision as the CLI's.
            confirmedBy: "mcp",
          },
          { releaseMbid: args.releaseMbid },
          db(),
        );
        const settings = await loadSettings(db());
        const result = await runStep(args.importId, "match", { db: db(), settings });
        const info = (result.data ?? {}) as { mapped?: number; extras?: number };

        /*
         * `mapped: info.mapped ?? args.bindings.length` was a lie with a fallback: when the
         * step returned no data the tool reported the number of bindings *sent* as if they had
         * been applied — `mapped: 1` on an import with no videos at all. The step's own count
         * or nothing; `null` is an honest answer and "1" was not.
         */
        const applied = {
          step: "match" as const,
          outcome: result.status,
          message: result.message ?? null,
          mapped: info.mapped ?? null,
          extras: info.extras ?? null,
          ...(result.error === undefined ? {} : { error: result.error }),
        };

        // Only queue the job when the confirmation actually took. Queuing after a failed
        // `match` asks the worker to carry on from a mapping that was refused.
        const queued = result.status === "done" || result.status === "skipped";
        if (queued) await enqueue(args.importId, "mcp confirm_mapping");

        const after = await getImport(args.importId, db());
        return {
          importId: args.importId,
          confirmed: queued,
          bindingsSent: args.bindings.length,
          applied,
          queued,
          // Deliberately *not* called `status`: "failed" used to mean either "this call failed"
          // or "the job was already failing", and nothing said which.
          jobStatus: after?.status ?? job.status,
          jobStep: after?.step ?? job.step,
        };
      },
    },
    {
      name: "list_inbox",
      scope: "review:read",
      title: "List Inbox items",
      description:
        "The questions the pipeline could not answer alone. Each carries a preselected answer; " +
        "`resolve_inbox` with `accept: true` takes it.",
      inputSchema: {
        status: z.enum(["open", "resolved", "dismissed", "all"]).default("open"),
        importId: z.string().optional(),
      },
      run: async (args: { status: string; importId?: string }) => {
        const items = await listInbox(
          {
            ...(args.status === "all" ? {} : { status: args.status as never }),
            ...(args.importId === undefined ? {} : { importId: args.importId }),
          },
          db(),
        );
        return items.map((item) => ({
          id: item.id,
          importId: item.importId,
          type: item.type,
          status: item.status,
          title: item.title,
          summary: item.summary,
          preselected: item.preselected,
          payload: item.payload,
        }));
      },
    },
    {
      name: "resolve_inbox",
      scope: "review:write",
      title: "Answer one or many Inbox items",
      description:
        "Answer blocked questions and let the imports continue. `accept: true` takes each " +
        "item's preselected answer; `false` dismisses them. Every decision is logged with " +
        "`decidedBy: mcp`.\n\n" +
        "**Three ways to say which items**, and exactly one must be given: `itemId` for one, " +
        "`itemIds` for a list, or `importId` to take every item still open on that import. A " +
        "batch is not a convenience: thirteen fingerprint mismatches answered one at a time " +
        "were thirteen round trips *and* thirteen restarts of the same job, each racing the " +
        "last. Here every item is resolved first and each affected import is re-queued **once** " +
        "at the end. `type` narrows an `importId` batch to one kind of question.",
      inputSchema: {
        itemId: z
          .string()
          .min(1)
          .optional()
          .describe("One item. Mutually exclusive with the two below."),
        itemIds: z
          .array(z.string().min(1))
          .min(1)
          .max(200)
          .optional()
          .describe("Several items, answered the same way."),
        importId: z
          .string()
          .min(1)
          .optional()
          .describe("Every item still open on this import. `list_inbox` shows them first."),
        type: z
          .enum(INBOX_TYPES)
          .optional()
          .describe("With `importId`: only items of this kind, e.g. `fingerprint_mismatch`."),
        accept: z.boolean().default(true),
      },
      run: async (args: {
        itemId?: string;
        itemIds?: string[];
        importId?: string;
        type?: InboxType;
        accept: boolean;
      }) => {
        const outcome = await resolveInboxBatch(
          {
            ...(args.itemId === undefined ? {} : { itemId: args.itemId }),
            ...(args.itemIds === undefined ? {} : { itemIds: args.itemIds }),
            ...(args.importId === undefined ? {} : { importId: args.importId }),
            ...(args.type === undefined ? {} : { type: args.type }),
          },
          { accept: args.accept, decidedBy: "mcp" },
          db(),
        );

        // One restart per import, after every answer is written — not one per answer.
        for (const importId of outcome.imports) {
          await enqueue(importId, "mcp inbox resolved");
        }

        return {
          resolved: outcome.resolved,
          failed: outcome.failed,
          /** One entry per import, however many of its items were answered. */
          resumed: outcome.imports,
          note:
            outcome.resolved.length === 0 && outcome.failed.length === 0
              ? "Nothing was open to answer."
              : `${String(outcome.resolved.length)} item(s) ${args.accept ? "resolved" : "dismissed"}, ${String(outcome.imports.length)} import(s) re-queued once.`,
        };
      },
    },
    {
      name: "search_library",
      scope: "library:read",
      title: "Search the library",
      description:
        "Search albums, tracks and artists at once. Use it to answer 'do I already have this?' " +
        "before creating an import.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
      },
      run: async (args: { query: string; limit: number }) => {
        const [grid, tracks, artists] = await Promise.all([
          albumGrid({ search: args.query }, db()),
          trackList({ search: args.query, limit: args.limit }, db()),
          artistList({ search: args.query }, db()),
        ]);
        return {
          albums: grid.albums.slice(0, args.limit).map((album) => ({
            id: album.id,
            title: album.title,
            albumArtist: album.albumArtist,
            year: album.year,
            trackCount: album.trackCount,
            presentCount: album.presentCount,
            score: album.quality.score,
          })),
          tracks: tracks.tracks.slice(0, args.limit).map((track) => ({
            id: track.id,
            title: track.title,
            artist: track.artist,
            albumTitle: track.albumTitle,
            path: track.path,
            score: track.score,
          })),
          artists: artists.slice(0, args.limit).map((artist) => ({
            name: artist.name,
            albums: artist.albums,
            tracks: artist.tracks,
          })),
        };
      },
    },
    {
      name: "get_album",
      scope: "library:read",
      title: "Get one album",
      description:
        "One album in full: its identifiers, its tracks, its completeness score and — most " +
        "usefully — exactly which tags are missing and what would fix each one.",
      inputSchema: { albumId: z.string().min(1) },
      run: async (args: { albumId: string }) => {
        const detail = await albumDetail(args.albumId, db());
        if (detail === null) throw new Error(`No album with id ${args.albumId}.`);
        return {
          album: {
            id: detail.album.id,
            title: detail.album.title,
            albumArtist: detail.album.albumArtist,
            folder: detail.album.folder,
            releaseMbid: detail.album.releaseMbid,
          },
          identifiers: detail.identifiers,
          quality: {
            score: detail.quality.score,
            trackCount: detail.quality.trackCount,
            presentCount: detail.quality.presentCount,
            schemaVersion: detail.quality.schemaVersion,
            missing: detail.quality.missing,
          },
          tracks: detail.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            trackNumber: track.trackNumber,
            path: track.path,
            present: track.present,
            score: track.score,
          })),
        };
      },
    },
    {
      name: "retag",
      scope: "library:write",
      title: "Re-tag files from the stored documents",
      description:
        "Re-project the database's metadata onto the files. Offline — it downloads nothing and " +
        "re-reads nothing from the network. Use `dryRun` first to see the diff.",
      inputSchema: {
        albumId: z.string().optional().describe("Omit with `trackId` to re-tag the library."),
        trackId: z.string().optional(),
        dryRun: z.boolean().default(true),
        onlyBehind: z
          .boolean()
          .default(true)
          .describe("Only files whose projection is behind the current tag schema."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("How many diffs and how many errors to return. The counts are always full."),
      },
      run: async (args: {
        albumId?: string;
        trackId?: string;
        dryRun: boolean;
        onlyBehind: boolean;
        limit: number;
      }) => {
        const scope =
          args.trackId !== undefined ? "track" : args.albumId !== undefined ? "album" : "library";
        const run = await createRun({
          db: db(),
          scope,
          targetId: args.trackId ?? args.albumId ?? null,
          dryRun: args.dryRun,
          onlyBehind: args.onlyBehind,
          trigger: "manual",
        });
        if (run.total === 0) {
          return { runId: run.id, total: 0, note: "Nothing in scope is behind the projection." };
        }
        // A dry run is cheap and its whole point is the answer, so it is run here. A real
        // re-tag of a library writes thousands of files and goes to the worker.
        if (args.dryRun || scope !== "library") {
          const finished = await runToCompletion(run.id, { db: db() });
          /*
           * `{total: 13, changed: 0, failed: 13}` and nothing else was the whole answer, while
           * the reasons — one `retag_diffs.error` per file, plus a `job_event` each — sat in
           * Postgres. A tool whose description promises "use `dryRun` first to see the diff"
           * has to actually carry the diff and the failures.
           */
          /*
           * `limit` is asked for twice as many rows as it will show, because a run's errors
           * and its diffs are two disjoint subsets of the same rows: a slice of `limit` rows
           * that happened to be all failures would show `limit` errors and no diff at all.
           * The *counts* below never come from this slice — `view.totals` is counted in SQL
           * over the whole run, which is the fix for `moreErrors`/`moreDiffs` always being 0.
           */
          const view = await runView(finished.id, { limit: args.limit * 2 }, db());
          const rows = view?.diffs ?? [];
          const totals = view?.totals ?? { rows: 0, failed: 0, changed: 0 };
          const broken = rows.filter((row) => row.error !== null);
          const errors = broken.slice(0, args.limit).map((row) => ({
            path: row.path,
            code: row.error?.code ?? "UNKNOWN",
            message: row.error?.message ?? "No reason recorded.",
          }));
          const changedRows = rows.filter(
            (row) =>
              row.error === null &&
              (row.added.length > 0 || row.removed.length > 0 || row.changed.length > 0),
          );
          const shownDiffs = changedRows.slice(0, args.limit);
          return {
            runId: finished.id,
            total: finished.total,
            changed: finished.changed,
            failed: finished.failed,
            status: finished.status,
            dryRun: args.dryRun,
            errors,
            moreErrors: Math.max(0, totals.failed - errors.length),
            // The diff is what a dry run is *for*, so it travels on a dry run and is left out
            // of a real one, where it would only describe what has already been written.
            ...(args.dryRun
              ? {
                  diff: shownDiffs.map((row) => ({
                    path: row.path,
                    // A tag value is abbreviated on the way *out*, never on the way into a
                    // file: `ACOUSTID_FINGERPRINT` is two kilobytes of base64 per track and
                    // `LYRICS` has no upper bound at all.
                    added: row.added.map((change) => abbreviateChange(change)),
                    removed: row.removed.map((change) => abbreviateChange(change)),
                    changed: row.changed.map((change) => abbreviateChange(change)),
                    unchanged: row.unchanged,
                  })),
                  moreDiffs: Math.max(0, totals.changed - shownDiffs.length),
                  valuesAbbreviatedOver: DIFF_VALUE_LIMIT,
                }
              : {}),
          };
        }
        await enqueueRetagRun(run.id);
        return { runId: run.id, total: run.total, queued: true };
      },
    },
    {
      name: "verify",
      scope: "library:write",
      title: "Verify what was written, through Navidrome",
      description:
        "Read the files back through Navidrome and compare field by field with what the " +
        "database says was written. This is the proof that a tag survived the round trip.",
      inputSchema: {
        albumId: z.string().optional().describe("Omit to verify the whole library."),
        rescan: z.boolean().default(false),
      },
      run: async (args: { albumId?: string; rescan: boolean }) =>
        args.albumId === undefined
          ? await verifyLibrary({ db: db(), rescan: args.rescan })
          : await verifyAlbum(args.albumId, { db: db(), rescan: args.rescan }),
    },
    {
      name: "get_settings",
      scope: "settings:read",
      title: "Read the settings",
      description: "Every knob of the pipeline. Credentials are masked and cannot be unmasked.",
      inputSchema: {},
      run: async () => maskedSettings(await loadSettings(db())),
    },
    {
      name: "update_settings",
      scope: "settings:write",
      title: "Change settings",
      description:
        "Set one or more keys. **The patch is atomic**: every key and every value is checked " +
        "first, and a single bad value refuses the whole call without writing any of it — " +
        "whatever order the keys are in. `get_settings` lists what exists.\n\n" +
        "The answer carries `previous` and `effective` beside `saved`, so a caller can see " +
        "what it changed and what the store now holds without a second `get_settings`. " +
        "Credentials read `set` in both, never their value.",
      inputSchema: {
        patch: z.record(z.string(), z.unknown()).describe('`{ "key": value }` pairs.'),
      },
      run: async (args: { patch: Record<string, unknown> }) => {
        // Read before writing, so `previous` is what was there and not what we just put there.
        const before = maskedSettings(await loadSettings(db()));
        // One call, two phases: `setSettings` parses every value before it writes any of them,
        // so a refusal here has left the store exactly as `before` describes it.
        const { saved } = await setSettings(args.patch, { db: db(), setBy: "mcp" });
        const after = maskedSettings(await loadSettings(db()));

        const narrow = (source: Record<string, unknown>): Record<string, unknown> =>
          Object.fromEntries(saved.map((key) => [key, source[key]]));

        return {
          saved,
          previous: narrow(before),
          // The *effective* value, re-read through `loadSettings`: a value that was coerced,
          // clamped or normalised on the way in differs from the one that was sent, and
          // echoing the input back would hide exactly that.
          effective: narrow(after),
        };
      },
    },
    {
      name: "ytdlp_update",
      scope: "tools:write",
      title: "Update yt-dlp",
      description:
        "Update the downloader. YouTube changes break it regularly and this is the fix for " +
        "most download failures that appeared overnight.",
      inputSchema: {},
      run: async () => await updateYtdlp({ db: db() }),
    },
    {
      name: "get_status",
      scope: "tools:read",
      title: "Is this installation working?",
      description:
        "The health of the four moving parts: the database, the toolbox (reachable, in " +
        "fixtures mode or not, and the versions of yt-dlp / ffmpeg / fpcalc / rsgain), " +
        "Navidrome, and whether a **worker** is alive to drain the queues. Plus the last " +
        "import that failed, with its error in full.\n\n" +
        "Read this first when anything is not behaving. It is the difference between " +
        "'the toolbox is not running', 'the toolbox refused the request' and 'nothing is " +
        "consuming the queue' — three failures that look identical from every other tool. " +
        "`problems` is the list to act on and is empty when `ok` is true.\n\n" +
        "`toolbox.contract` is the fourth of those failures and the least visible: a container " +
        "**older than the code calling it**. It reports the hash of the API it really " +
        "implements and this compares it with the one the client was generated from, because " +
        "an image one commit behind answers `422 extra_forbidden` on a field its models have " +
        "never heard of — while `reachable: true`, `error: null` and four healthy binary " +
        "versions all say nothing is wrong. `matches: false` means `bun run stack:up --build`.",
      inputSchema: {},
      run: async () => await systemStatus({ db: db() }),
    },
    {
      name: "discover_sync",
      scope: "library:write",
      title: "Recompute the recommendations",
      description:
        "Run the Discover pass now instead of waiting for its cron. `list_discover` is " +
        "read-only and returns three empty blocks until this has run at least once, which " +
        "is a dead end for an agent that has just enabled Discover. Runs in this request " +
        "(no worker needed) and never throws: a failure is a report with a reason.\n\n" +
        "Needs `library:write` rather than `settings:write` because what it writes is the " +
        "recommendation set — library data — and it changes no setting. That matches " +
        "`POST /api/v1/discover/sync`, which takes the same scope.",
      inputSchema: {},
      run: async () => await syncDiscover({ db: db(), trigger: "mcp" }),
    },
    {
      name: "scan",
      scope: "tools:write",
      title: "Scan the library",
      description:
        "Walk the library and reconcile it with the database: orphan files, missing files, " +
        "tag drift, duplicates. Queued to the worker, so `get_status` must show a worker " +
        "alive or nothing will happen; `queued: false` means there was none to hand it to.\n\n" +
        "Needs `tools:write`, matching `POST /api/v1/tools/scan`: a scan is an operation on " +
        "the installation, and it never edits metadata — the removals it proposes are moves " +
        "into the trash directory, taken by a human.",
      inputSchema: {
        driftLimit: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe("Stop comparing tags after this many files. Omit for the configured value."),
      },
      run: async (args: { driftLimit?: number }) => {
        const jobId = await enqueueLibraryScan({
          trigger: "mcp",
          ...(args.driftLimit === undefined ? {} : { driftLimit: args.driftLimit }),
        });
        return {
          queued: jobId !== null,
          jobId,
          note:
            jobId === null
              ? "The scan could not be queued. Check `get_status`."
              : "Queued. `get_status.worker.alive` says whether anything will pick it up; " +
                "`get_scan_report` reads the result once it has run.",
        };
      },
    },
    {
      name: "get_scan_report",
      scope: "tools:read",
      title: "Read what a scan found",
      description:
        "The result of a library scan: how many files were walked, and the orphans, missing " +
        "files, tag drift, duplicate recordings and merged rows it found.\n\n" +
        "Without `scanId` this is the most recent run, whatever its state — a `running` one " +
        "answers with its status and no findings, which is how you know the worker took it. " +
        "`scan` only *queues* the walk, and until this tool existed its result was reachable " +
        "from the Console and the CLI but from no MCP tool at all: an agent could start a " +
        "reconciliation and never learn what it said.\n\n" +
        "`counts` is complete and never depends on `limit`; each list is cut to `limit` and " +
        "carries `more` — how many it left out, counted before the cut.",
      inputSchema: {
        scanId: z.string().min(1).optional().describe("Omit for the most recent run."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("How many entries per list. The counts are always full."),
      },
      run: async (args: { scanId?: string; limit: number }) => {
        if (args.scanId !== undefined) {
          const scan = await getScan(args.scanId, db());
          if (scan === null) throw new Error(`No library scan with id ${args.scanId}.`);
          return summariseScan(scan, args.limit);
        }
        const [latest] = await recentScans(1, db());
        if (latest === undefined) {
          return {
            scanId: null,
            note: "No library scan has ever run on this installation. Start one with `scan`.",
          };
        }
        return summariseScan(latest, args.limit);
      },
    },
    {
      name: "relocate",
      scope: "library:write",
      title: "Re-file the library against the path template",
      description:
        "Move files that no longer match `pathTemplate` to where it says they belong. This " +
        "is the missing half of a template change: `retag` re-projects the tags but never " +
        "touches a path, so a library keeps its old names for ever after the setting moves.\n\n" +
        "`dryRun: true` (the default) changes nothing and returns the list of moves, the " +
        "count already in place, and what is blocked and why. **Navidrome identifies a file " +
        "by its path, so a real move loses that track's play count and its favourites** — " +
        "read the dry run first. A destination that already exists is skipped, never " +
        "overwritten; a track with no metadata document is reported, never guessed at. The " +
        "move goes through the toolbox, so it is a rename inside one mount and is atomic; the " +
        "database rows follow, and Navidrome is asked to rescan.",
      inputSchema: {
        albumId: z.string().optional().describe("Restrict to one album. Omit for the library."),
        dryRun: z.boolean().default(true),
      },
      run: async (args: { albumId?: string; dryRun: boolean }) =>
        await relocate({
          db: db(),
          dryRun: args.dryRun,
          ...(args.albumId === undefined ? {} : { albumId: args.albumId }),
        }),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* assembly                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a server for one principal.
 *
 * A fresh instance per request. That is the SDK's stateless pattern and it is right here: the
 * tool list depends on the caller's scopes, so a shared instance would have to be rebuilt per
 * key anyway, and a cached one would leak `settings:write` tools to a read-only key on the
 * first request after a restart.
 */
export function buildMcpServer(principal: ApiPrincipal): McpServer {
  const server = new McpServer(
    { name: "music-manager", version: APP_VERSION },
    {
      instructions:
        "Music Manager imports music from YouTube, matches it against MusicBrainz and writes " +
        "the fullest possible set of standard tags.\n\n" +
        "The usual flow: `create_import` with a URL, then `get_import` until it is " +
        "`awaiting_review` or `done`. If it is waiting, `get_candidates` shows what it thinks " +
        "the release is and `confirm_mapping` decides; `list_inbox` and `resolve_inbox` answer " +
        "anything else it is blocked on. Before importing, `search_library` says whether you " +
        "already have it.\n\n" +
        "`list_discover` is the other way in: it says what is worth importing, with a reason, " +
        "and its ids feed straight into `create_import`.\n\n" +
        "When something is not behaving — an import failing with no reason, a job that never " +
        "moves — call `get_status` before anything else: it says which of the database, the " +
        "toolbox, Navidrome and the worker is at fault, which no other tool can distinguish.\n\n" +
        "Read `mm://docs/03-metadonnees.md` for what a good tag set is, and `mm://tagmap` for " +
        "the table of every tag this app writes.",
    },
  );

  for (const tool of toolTable()) {
    if (!grants(principal.scopes, tool.scope)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        // The scope is in the description because an agent that knows why it was refused can
        // ask its operator for the right key rather than retrying for ever.
        description: `${tool.description}\n\nRequires the \`${tool.scope}\` scope.`,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          // The SDK has already parsed `args` against `inputSchema`, so this is the validated
          // shape the tool declared — not a hopeful cast.
          return json(await tool.run(args));
        } catch (error) {
          return failed(error instanceof Error ? error.message : String(error));
        }
      },
    );
  }

  registerResources(server, principal);
  return server;
}

/**
 * `mm://tagmap` and `mm://docs/*`.
 *
 * Both are read-only and both are the *specification*, not the data: an agent that has read
 * the tag map knows what `MUSICBRAINZ_RELEASETRACKID` is for without being told in a prompt.
 */
function registerResources(server: McpServer, principal: ApiPrincipal): void {
  server.registerResource(
    "tagmap",
    "mm://tagmap",
    {
      title: "The tag map",
      description:
        "Every tag this app writes: its canonical (Vorbis) name, its ID3v2.4 frame, its MP4 " +
        "atom, which level it belongs to and which consumers read it. The single source of " +
        "tag names for the whole system.",
      mimeType: "application/json",
    },
    () => ({
      contents: [
        {
          uri: "mm://tagmap",
          mimeType: "application/json",
          text: JSON.stringify({ note: TAGMAP_NOTE, tags: TAGS }, null, 2),
        },
      ],
    }),
  );

  // The documents are the specification, and the specification describes settings and
  // credentials management. `library:read` is a low bar but not no bar.
  if (!grants(principal.scopes, "library:read")) return;

  for (const doc of listDocs()) {
    server.registerResource(
      `docs/${doc.name}`,
      doc.uri,
      {
        title: doc.name,
        description: `The project's specification: docs/${doc.name}.`,
        mimeType: "text/markdown",
      },
      () => {
        let text: string;
        try {
          text = readFileSync(doc.path, "utf8");
        } catch {
          text = `docs/${doc.name} is not present in this installation.`;
        }
        return { contents: [{ uri: doc.uri, mimeType: "text/markdown", text }] };
      },
    );
  }
}

/** Prefixed to `mm://tagmap` so a reader knows what the table is and is not. */
const TAGMAP_NOTE =
  "The canonical tag table of docs/03-metadonnees.md §2. `vorbis` is the canonical name; " +
  "`id3v24` and `mp4` are how it is encoded in those containers, and `null` there means the " +
  "format has no slot for it — such a field is dropped rather than invented. `level` is how " +
  "much it matters: core > extended > nice-to-have.";
