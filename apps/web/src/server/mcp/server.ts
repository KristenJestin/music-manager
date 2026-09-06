/**
 * The MCP server (`docs/phases/P08-api-agents.md` § MCP).
 *
 * Fourteen tools and two resource families over the *same service layer* the REST API and the
 * Console use. No tool touches the database directly, which is the rule the spec states and
 * the reason an agent's view of a candidate list is the same view a human gets.
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
 * the tools that request's key may call. A `library:read` key therefore sees seven tools in
 * `tools/list` rather than fourteen tools of which seven fail — which is the difference between
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
import { getInboxItem, listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { albumDetail, albumGrid, artistList, trackList } from "#/server/services/library.ts";
import { createRun, runToCompletion } from "#/server/services/retag.ts";
import { verifyAlbum, verifyLibrary } from "#/server/services/verify.ts";
import { updateYtdlp } from "#/server/services/tools.ts";
import {
  isSettingKey,
  loadSettings,
  maskedSettings,
  setSetting,
} from "#/server/services/settings.ts";
import { enqueue, enqueueRetagRun } from "#/server/services/queue.ts";
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
/* the tools                                                           */
/* ------------------------------------------------------------------ */

interface ToolSpec {
  readonly name: string;
  readonly scope: ApiScope;
  readonly title: string;
  readonly description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one heterogeneous table of
  // tools, each with its own zod shape; the shapes are checked at each registration site.
  readonly inputSchema: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
  readonly run: (args: any) => Promise<unknown>;
}

/**
 * The fourteen tools of the spec, as data.
 *
 * A table rather than fourteen `server.registerTool(...)` calls, so that "which tools does this
 * key get?" is one `filter` and the scope of each tool is visible next to its name rather than
 * buried in its body.
 */
export function toolTable(): ToolSpec[] {
  return [
    {
      name: "list_imports",
      scope: "imports:read",
      title: "List imports",
      description:
        "Recent import jobs, newest first, with their status and current step. Start here to " +
        "find the id of something already in flight.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe("Filter on one status, e.g. `awaiting_review`, `running`, `done`."),
        limit: z.number().int().min(1).max(100).default(20),
      },
      run: async (args: { status?: string; limit: number }) => {
        const rows = await listImports(
          {
            limit: args.limit,
            ...(args.status === undefined ? {} : { status: args.status as never }),
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
        "items blocking it. If `inbox` is non-empty the job is waiting for a decision.",
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
          steps: detail.steps.map(({ step, row }) => ({
            step,
            status: row?.status ?? "pending",
            message: row?.message ?? null,
          })),
          tracks: detail.tracks.map((track) => ({
            position: track.position,
            title: track.sourceTitle,
            durationSeconds: track.sourceDuration,
            state: track.state,
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
        "Queue a YouTube URL (or `fixture://discovery` offline). Resolves the source " +
        "immediately, then hands the job to the worker. Poll `get_import`, or set " +
        "`autoConfirm` to let it run past the confirmation gate without asking.",
      inputSchema: {
        url: z.string().min(1).describe("A YouTube URL, or `fixture://…`."),
        releaseMbid: z
          .string()
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
          force: args.force,
        });
        await enqueue(created.job.id, "mcp");
        return {
          importId: created.job.id,
          status: created.job.status,
          step: created.job.step,
          title: created.job.title,
          duplicates: created.duplicates.map((row) => row.id),
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
        "Computed on demand — asking decides nothing.",
      inputSchema: { importId: z.string().min(1) },
      run: async (args: { importId: string }) => {
        const job = await getImport(args.importId, db());
        if (job === null) throw new Error(`No import with id ${args.importId}.`);
        const settings = await loadSettings(db());
        const result = await rankFor({ job, settings, db: db() });
        const { videos } = await videosOf(job.id, db());
        const hints = hintsFor(job, videos);
        return {
          kind: result.kind,
          preselectedId: result.ranking.preselected?.id ?? null,
          safe: result.ranking.preselected?.safe ?? false,
          ambiguous: result.ranking.ambiguous,
          margin: result.ranking.margin,
          hints: { album: hints.album ?? null, artist: hints.artist ?? null },
          candidates: result.ranking.candidates.slice(0, 12),
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
        "becomes an 'extra' and is not downloaded.",
      inputSchema: {
        importId: z.string().min(1),
        releaseMbid: z.string().nullable(),
        album: z.string().default(""),
        albumArtist: z.string().default(""),
        year: z.number().int().nullable().default(null),
        trackTotal: z.number().int().min(0).default(0),
        bindings: z
          .array(
            z.object({
              position: z.number().int().min(0).describe("The video's index in the source."),
              trackPosition: z.number().int().min(1),
              mediumPosition: z.number().int().min(1).default(1),
              recordingMbid: z.string().nullable(),
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
          { mapping, releaseMbid: args.releaseMbid, autoConfirm: true },
          { releaseMbid: args.releaseMbid },
          db(),
        );
        const settings = await loadSettings(db());
        const result = await runStep(args.importId, "match", { db: db(), settings });
        await enqueue(args.importId, "mcp confirm_mapping");
        const after = await getImport(args.importId, db());
        const info = (result.data ?? {}) as { mapped?: number; extras?: number };
        return {
          importId: args.importId,
          mapped: info.mapped ?? args.bindings.length,
          extras: info.extras ?? 0,
          status: after?.status ?? "pending",
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
      title: "Answer an Inbox item",
      description:
        "Answer a blocked question and let the import continue. `accept: true` takes the " +
        "preselected answer; `false` dismisses it. The decision is logged with `decidedBy: mcp`.",
      inputSchema: {
        itemId: z.string().min(1),
        accept: z.boolean().default(true),
      },
      run: async (args: { itemId: string; accept: boolean }) => {
        const item = await getInboxItem(args.itemId, db());
        if (item === null) throw new Error(`No Inbox item with id ${args.itemId}.`);
        const updated = await resolveInboxItem(
          args.itemId,
          {
            resolution: args.accept
              ? { accepted: true, ...(item.preselected ?? {}) }
              : { accepted: false, action: "dismiss" },
            decidedBy: "mcp",
            status: args.accept ? "resolved" : "dismissed",
          },
          db(),
        );
        if (item.importId !== null) await enqueue(item.importId, "mcp inbox resolved");
        return { id: updated.id, status: updated.status, resumed: item.importId };
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
      },
      run: async (args: {
        albumId?: string;
        trackId?: string;
        dryRun: boolean;
        onlyBehind: boolean;
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
          return {
            runId: finished.id,
            total: finished.total,
            changed: finished.changed,
            failed: finished.failed,
            status: finished.status,
            dryRun: args.dryRun,
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
        "Set one or more keys. Each value is validated against that key's own schema; an " +
        "unknown key refuses the whole call. `get_settings` lists what exists.",
      inputSchema: {
        patch: z.record(z.string(), z.unknown()).describe("`{ \"key\": value }` pairs."),
      },
      run: async (args: { patch: Record<string, unknown> }) => {
        const unknown = Object.keys(args.patch).filter((key) => !isSettingKey(key));
        if (unknown.length > 0) throw new Error(`Unknown setting(s): ${unknown.join(", ")}.`);
        const saved: string[] = [];
        for (const [key, value] of Object.entries(args.patch)) {
          if (!isSettingKey(key)) continue;
          await setSetting(key, value as never, { db: db(), setBy: "mcp" });
          saved.push(key);
        }
        return { saved };
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
      async (args: unknown) => {
        try {
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
