/**
 * `mm watch` — the watched playlists and channels from the command line.
 *
 * **Not `mm sources`**, which already exists and prints which metadata credentials are
 * configured (`docs/03-metadonnees.md` §4). Two commands a word apart, one of which watches
 * YouTube and one of which does not, is a trap rather than a naming scheme.
 *
 * Four verbs: `add`, `list`, `scan`, `remove`. `scan` runs the scan **in this process** by
 * default, so `mm watch scan` on a machine with no worker still answers; `--queue` hands it to
 * the worker instead, which is what a cron wrapper wants. The imports it opens are always
 * queued, because the download slot is global and a CLI that ran steps of its own would be a
 * second worker.
 */
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import {
  createWatchedSource,
  deleteWatchedSource,
  getWatchedSource,
  listWatchedSources,
  scanSource,
  enabledSources,
} from "#/server/services/watched-sources.ts";
import { enqueueWatchedSourceScan, enqueue } from "#/server/services/queue.ts";

export interface CliArgs {
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

const out = (...parts: unknown[]): void => {
  console.log(parts.join(" "));
};

const flagBoolean = (args: CliArgs, name: string): boolean =>
  args.flags[name] === true || args.flags[name] === "true";

const flagString = (args: CliArgs, name: string): string | undefined => {
  const raw = args.flags[name];
  return typeof raw === "string" ? raw : undefined;
};

const flagNumber = (args: CliArgs, name: string): number | undefined => {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

export async function cmdWatch(args: CliArgs): Promise<number> {
  const action = args.positional[1] ?? "list";
  const asJson = flagBoolean(args, "json");

  if (action === "add") {
    const url = args.positional[2];
    if (url === undefined) {
      throw new MMError(
        "INVALID_INPUT",
        "usage: mm watch add <url> [--label x] [--auto-accept] [--min-duration s] [--max-duration s]",
      );
    }
    const created = await createWatchedSource(
      {
        url,
        ...(flagString(args, "label") === undefined ? {} : { label: flagString(args, "label") }),
        ...(flagBoolean(args, "auto-accept") ? { autoAccept: true } : {}),
        ...(flagNumber(args, "min-duration") === undefined
          ? {}
          : { minDuration: flagNumber(args, "min-duration") }),
        ...(flagNumber(args, "max-duration") === undefined
          ? {}
          : { maxDuration: flagNumber(args, "max-duration") }),
        ...(flagBoolean(args, "require-provided") ? { requireProvidedToYouTube: true } : {}),
      },
      { db: db() },
    );
    if (asJson) {
      out(JSON.stringify(created, null, 2));
      return 0;
    }
    out(`watching ${created.id}`);
    out(`  url          ${created.url}`);
    out(`  kind         ${created.kind}`);
    out(
      `  auto-accept  ${created.autoAccept ? "on — unambiguous matches skip the review" : "off"}`,
    );
    out(`  next         mm watch scan ${created.id}`);
    return 0;
  }

  if (action === "remove") {
    const id = args.positional[2];
    if (id === undefined) throw new MMError("INVALID_INPUT", "usage: mm watch remove <id>");
    await deleteWatchedSource(id, db());
    out(`${id} is no longer watched. Its imports are kept.`);
    return 0;
  }

  if (action === "scan") {
    const id = args.positional[2];

    if (flagBoolean(args, "queue")) {
      const jobId = await enqueueWatchedSourceScan({
        ...(id === undefined ? {} : { sourceId: id }),
        trigger: "cli",
      });
      out(jobId === null ? "already queued" : `queued on watched-sources.scan (${jobId})`);
      return 0;
    }

    const targets = id === undefined ? (await enabledSources(db())).map((s) => s.id) : [id];
    if (targets.length === 0) {
      out("no enabled source to scan — `mm watch add <url>`");
      return 0;
    }

    const reports = [];
    for (const sourceId of targets) {
      reports.push(
        await scanSource(sourceId, {
          db: db(),
          enqueue: async (importId: string) => {
            await enqueue(importId, "mm watch scan");
          },
        }),
      );
    }

    if (asJson) {
      out(JSON.stringify(reports, null, 2));
      return reports.some((report) => report.status === "failed") ? 1 : 0;
    }
    for (const report of reports) {
      out(
        `${report.sourceId}  ${pad(report.status, 8)} ` +
          `${String(report.listed)} listed, ${String(report.discovered)} new, ` +
          `${String(report.imported)} imported, ${String(report.skipped)} skipped ` +
          `(${String(report.durationMs)} ms)`,
      );
      if (report.error !== null) out(`  error  ${report.error.message}`);
      for (const importId of report.importIds) out(`  import ${importId}`);
    }
    return reports.some((report) => report.status === "failed") ? 1 : 0;
  }

  if (action === "show") {
    const id = args.positional[2];
    if (id === undefined) throw new MMError("INVALID_INPUT", "usage: mm watch show <id>");
    const detail = await getWatchedSource(id, db());
    if (detail === null) throw new MMError("NOT_FOUND", `No watched source with id ${id}.`);
    if (asJson) {
      out(JSON.stringify(detail, null, 2));
      return 0;
    }
    out(
      `${detail.source.id}  ${detail.source.label === "" ? detail.source.url : detail.source.label}`,
    );
    out(`  url          ${detail.source.url}`);
    out(`  kind         ${detail.source.kind}`);
    out(`  enabled      ${detail.source.enabled ? "yes" : "paused"}`);
    out(`  auto-accept  ${detail.source.autoAccept ? "on" : "off"}`);
    out(
      `  last scan    ${detail.source.lastScanStatus} ${detail.source.lastScanAt?.toISOString() ?? ""}`,
    );
    out("");
    out("VIDEO ID      STATUS     IMPORT / REASON");
    for (const item of detail.items) {
      out(` ${pad(item.videoId, 13)}${pad(item.status, 11)}${item.importId ?? item.reason ?? ""}`);
    }
    return 0;
  }

  if (action === "list") {
    const rows = await listWatchedSources(db());
    if (asJson) {
      out(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      out("nothing watched — `mm watch add https://www.youtube.com/@artist`");
      return 0;
    }
    out("ID                              KIND      AUTO  SCAN      VIDEOS    LABEL");
    for (const row of rows) {
      out(
        ` ${pad(row.source.id, 31)}${pad(row.source.kind, 10)}` +
          `${pad(row.source.autoAccept ? "on" : "off", 6)}${pad(row.source.lastScanStatus, 10)}` +
          `${pad(`${String(row.imported)}/${String(row.total)}`, 10)}` +
          `${row.source.label === "" ? row.source.url : row.source.label}`,
      );
    }
    return 0;
  }

  throw new MMError(
    "INVALID_INPUT",
    "usage: mm watch add <url> | list | show <id> | scan [id] [--queue] | remove <id>",
  );
}
