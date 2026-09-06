/**
 * `mm verify`, `mm scan`, `mm tools` — the P07b half of the command line.
 *
 * Their own module rather than three more functions in `bin/mm.ts`, because that file is a
 * table of contents that two phases are extending at the same time; a command that lives in
 * its own file is three added lines in the dispatcher and nothing else.
 *
 * Everything prints a table a human reads, and `--json` prints the same data for a script.
 * The read-back's table is the point of `mm verify`: it is the same three columns the Console
 * shows, so the answer to "does Navidrome see my tags" does not require a browser.
 */
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { libraryAlbums } from "#/server/db/schema/index.ts";
import { navidromeStatus } from "#/server/services/navidrome.ts";
import {
  identifyOrphan,
  lastScan,
  reportOf,
  runScan,
  trashFile,
  type ScanReport,
} from "#/server/services/scan.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { loadSettings } from "#/server/services/settings.ts";
import {
  cookiesStatus,
  downloaderHealth,
  errorCatalog,
  selftest,
  serviceLatencies,
  testUrl,
  updateYtdlp,
} from "#/server/services/tools.ts";
import { verifyAlbum, verifyLibrary, type AlbumVerification } from "#/server/services/verify.ts";

export interface CliArgs {
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

const out = (...parts: unknown[]): void => {
  console.log(parts.join(" "));
};

const flagString = (args: CliArgs, name: string): string | undefined =>
  typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined;

const flagBoolean = (args: CliArgs, name: string): boolean =>
  args.flags[name] === true || args.flags[name] === "true";

const MARK: Record<string, string> = { ok: "✓", mismatch: "✗", not_indexed: "·" };

/* ------------------------------------------------------------------ */
/* mm verify                                                           */
/* ------------------------------------------------------------------ */

/** `library_albums` rows matching a fragment of the id, the title or the artist. */
async function findAlbums(needle: string): Promise<{ id: string; label: string }[]> {
  const rows = await db().select().from(libraryAlbums);
  const lower = needle.toLowerCase();
  return rows
    .filter(
      (row) =>
        row.id === needle ||
        row.id.toLowerCase().includes(lower) ||
        row.title.toLowerCase().includes(lower) ||
        row.albumArtist.toLowerCase().includes(lower) ||
        row.folder.toLowerCase().includes(lower),
    )
    .map((row) => ({ id: row.id, label: `${row.albumArtist} — ${row.title}` }));
}

function printVerification(label: string, verification: AlbumVerification): void {
  out("");
  out(`${label}  ${verification.server} ${verification.serverVersion}`);
  if (verification.note !== null) {
    out(`  ${verification.note}`);
    return;
  }
  for (const field of verification.fields) {
    const mark = MARK[field.status] ?? "?";
    const required = field.required ? "R" : " ";
    out(
      `  ${mark} ${required} ${field.name.padEnd(22)} wrote=${truncate(field.written)}  read=${truncate(field.read)}`,
    );
  }
  out(
    `  ${String(verification.ok)} ok · ${String(verification.mismatches)} mismatch · ${String(verification.notIndexed)} not indexed` +
      (verification.requiredMismatches.length === 0
        ? ""
        : ` · required wrong: ${verification.requiredMismatches.join(", ")}`),
  );
}

const truncate = (value: string, width = 40): string =>
  value.length <= width ? value : `${value.slice(0, width - 1)}…`;

export async function cmdVerify(args: CliArgs): Promise<number> {
  const json = flagBoolean(args, "json");
  const rescan = flagBoolean(args, "rescan")
    ? true
    : flagBoolean(args, "no-rescan")
      ? false
      : undefined;

  const settings = await loadSettings();
  const status = await navidromeStatus({ settings });
  if (!status.configured) {
    throw new MMError("NAVIDROME_NOT_CONFIGURED", "No Navidrome server is configured.", {
      hint: "mm settings set navidromeUrl http://localhost:4533 && mm settings set navidromeUser admin",
      action: "Configure Navidrome",
    });
  }
  if (!status.ok) {
    throw new MMError("NAVIDROME_UNREACHABLE", status.error ?? "Navidrome did not answer.", {
      hint: `Tried ${status.url}.`,
    });
  }

  if (flagBoolean(args, "all")) {
    const report = await verifyLibrary({
      settings,
      ...(rescan === undefined ? {} : { rescan }),
    });
    if (json) {
      out(JSON.stringify(report, null, 2));
      return report.withMismatch === 0 ? 0 : 1;
    }
    out(`${String(report.verified)} album(s) read back against ${status.server}:`);
    for (const album of report.albums) {
      const state =
        album.note !== null
          ? "not indexed"
          : album.mismatches > 0
            ? `${String(album.mismatches)} mismatch`
            : "ok";
      out(`  ${state.padEnd(12)} ${album.albumArtist} — ${album.title}`);
    }
    out("");
    out(
      `${String(report.clean)} clean · ${String(report.withMismatch)} with a mismatch · ${String(report.notFound)} not indexed`,
    );
    return report.withMismatch === 0 ? 0 : 1;
  }

  const needle = args.positional[1];
  if (needle === undefined) {
    throw new MMError("INVALID_INPUT", "usage: mm verify <album> | mm verify --all");
  }
  const matches = await findAlbums(needle);
  if (matches.length === 0) {
    throw new MMError("NOT_FOUND", `No library album matches "${needle}".`, {
      hint: "mm verify --all lists every album as it goes.",
    });
  }
  if (matches.length > 1) {
    out(`"${needle}" matches ${String(matches.length)} albums:`);
    for (const match of matches) out(`  ${match.id}  ${match.label}`);
    return 2;
  }

  const only = matches[0];
  if (only === undefined) return 2;
  const verification = await verifyAlbum(only.id, {
    settings,
    ...(rescan === undefined ? {} : { rescan }),
    say: async (message) => {
      if (!json) out(`  … ${message}`);
    },
  });
  if (json) {
    out(JSON.stringify(verification, null, 2));
  } else {
    printVerification(only.label, verification);
  }
  return verification.requiredMismatches.length === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* mm scan                                                             */
/* ------------------------------------------------------------------ */

function printReport(report: ScanReport): void {
  out(
    `${String(report.filesSeen)} file(s) on disk · ${String(report.tracked)} tracked · ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  out(
    `  orphans ${String(report.orphans.length)} · missing ${String(report.missing.length)} · drift ${String(report.drift.length)} · duplicate groups ${String(report.duplicates.length)} · probed ${String(report.probed)}`,
  );
  for (const note of report.notes) out(`  note: ${note}`);

  if (report.orphans.length > 0) {
    out("");
    out("orphan files (on disk, not in the database)");
    for (const orphan of report.orphans.slice(0, 20)) out(`  ${orphan.path}`);
  }
  if (report.missing.length > 0) {
    out("");
    out("missing files (in the database, not on disk)");
    for (const missing of report.missing.slice(0, 20)) {
      out(`  ${missing.path}  (${missing.title})`);
    }
  }
  if (report.drift.length > 0) {
    out("");
    out("tag drift");
    for (const drift of report.drift.slice(0, 20)) {
      out(`  ${drift.path}`);
      for (const field of drift.fields) {
        out(`      ${field.key.padEnd(20)} db=${truncate(field.db)}  file=${truncate(field.file)}`);
      }
    }
  }
  if (report.duplicates.length > 0) {
    out("");
    out("duplicates (same recording MBID)");
    for (const group of report.duplicates.slice(0, 20)) {
      out(`  ${group.title}`);
      for (const file of group.files) out(`      ${file.path}`);
    }
  }
}

export async function cmdScan(args: CliArgs): Promise<number> {
  const sub = args.positional[1] ?? "run";
  const json = flagBoolean(args, "json");

  if (sub === "last") {
    const scan = await lastScan();
    if (scan === null) {
      out("The library has never been scanned. `mm scan` walks it.");
      return 0;
    }
    const report = reportOf(scan);
    if (json) {
      out(JSON.stringify(report, null, 2));
      return 0;
    }
    out(`last scan ${scan.finishedAt?.toISOString() ?? "unfinished"} (${scan.trigger})`);
    if (report !== null) printReport(report);
    return 0;
  }

  if (sub === "identify") {
    const path = args.positional[2];
    if (path === undefined) throw new MMError("INVALID_INPUT", "usage: mm scan identify <path>");
    const result = await identifyOrphan(path);
    if (json) {
      out(JSON.stringify(result, null, 2));
      return 0;
    }
    out(`${path}  ${result.duration === null ? "" : `${result.duration.toFixed(1)}s`}`);
    if (result.candidates.length === 0) {
      out("  AcoustID knows nothing about this file.");
      return 1;
    }
    for (const candidate of result.candidates.slice(0, 10)) {
      out(
        `  ${(candidate.score * 100).toFixed(0).padStart(3)}%  ${candidate.title} — ${candidate.artist}  ${candidate.recordingMbid ?? ""}`,
      );
    }
    return 0;
  }

  if (sub === "trash") {
    const path = args.positional[2];
    if (path === undefined) throw new MMError("INVALID_INPUT", "usage: mm scan trash <path>");
    const settings = await loadSettings();
    const moved = trashFile(resolvePaths(settings), path, settings.trashDir);
    out(`moved to ${moved.to}`);
    return 0;
  }

  if (sub !== "run") {
    throw new MMError("INVALID_INPUT", "usage: mm scan [run|last|identify <path>|trash <path>]");
  }

  const driftLimit = flagString(args, "drift-limit");
  const { report } = await runScan({
    trigger: "cli",
    ...(driftLimit === undefined ? {} : { driftLimit: Number(driftLimit) }),
    say: async (message) => {
      if (!json) out(`  … ${message}`);
    },
  });
  if (json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out("");
    printReport(report);
  }
  return report.missing.length === 0 && report.drift.length === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* mm tools                                                            */
/* ------------------------------------------------------------------ */

export async function cmdTools(args: CliArgs): Promise<number> {
  const sub = args.positional[1] ?? "status";
  const json = flagBoolean(args, "json");

  if (sub === "update") {
    const result = await updateYtdlp();
    if (json) {
      out(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      out(
        result.updated
          ? `yt-dlp ${result.from ?? "?"} → ${result.to ?? "?"} (${result.method})`
          : `yt-dlp is unchanged (${result.to ?? "?"}, ${result.method})`,
      );
    } else {
      out(`update failed: ${result.error ?? result.output.slice(-400)}`);
    }
    return result.ok ? 0 : 1;
  }

  if (sub === "selftest") {
    const result = await selftest({ network: flagBoolean(args, "network") });
    if (json) {
      out(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    for (const check of result.checks) {
      out(`  ${check.ok ? "✓" : "✗"} ${check.name.padEnd(10)} ${check.detail}`);
    }
    return result.ok ? 0 : 1;
  }

  if (sub === "url") {
    const url = args.positional[2];
    if (url === undefined) throw new MMError("INVALID_INPUT", "usage: mm tools url <url>");
    const result = await testUrl(url);
    if (json) {
      out(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    if (result.ok) {
      out(
        `${result.kind} · ${String(result.entries)} entr${result.entries === 1 ? "y" : "ies"} · ${String(result.durationMs)} ms`,
      );
      for (const entry of result.sample) out(`  ${entry.title}`);
      return 0;
    }
    out(`${result.error?.code ?? "UNKNOWN"}: ${result.error?.message ?? ""}`);
    if (result.error?.hint !== "") out(`hint: ${result.error?.hint ?? ""}`);
    if (result.error?.action !== "") out(`try : ${result.error?.action ?? ""}`);
    return 1;
  }

  if (sub === "errors") {
    const catalog = await errorCatalog();
    if (json) {
      out(JSON.stringify(catalog, null, 2));
      return 0;
    }
    for (const entry of catalog.entries) {
      out(`${entry.code.padEnd(22)} ${entry.hint}`);
      if ((entry.patterns ?? []).length > 0) {
        out(`${" ".repeat(22)} matches: ${(entry.patterns ?? []).join(" · ")}`);
      }
    }
    return 0;
  }

  if (sub !== "status") {
    throw new MMError("INVALID_INPUT", "usage: mm tools [status|update|selftest|url <url>|errors]");
  }

  const settings = await loadSettings();
  const [health, cookies, services, navidrome] = await Promise.all([
    downloaderHealth({ settings }),
    cookiesStatus({ settings }),
    serviceLatencies({ settings }),
    navidromeStatus({ settings }),
  ]);

  if (json) {
    out(JSON.stringify({ health, cookies, services, navidrome }, null, 2));
    return health.reachable ? 0 : 1;
  }

  out(`toolbox      ${health.reachable ? "reachable" : (health.error ?? "unreachable")}`);
  out(
    `yt-dlp       ${health.versions["yt-dlp"] ?? "missing"} · ${health.channel}${health.pin === "" ? "" : ` · pinned ${health.pin}`} · auto-update ${health.autoUpdate ? health.updateCron : "off"}`,
  );
  out(
    `binaries     ffmpeg ${health.versions.ffmpeg ?? "missing"} · fpcalc ${health.versions.fpcalc ?? "missing"} · rsgain ${health.versions.rsgain ?? "missing"}`,
  );
  out(`cookies      ${cookies.mode} · ${cookies.note}`);
  out(
    `navidrome    ${navidrome.ok ? `${navidrome.server} ${navidrome.serverVersion} · ${String(navidrome.latencyMs)} ms` : (navidrome.error ?? "not configured")}`,
  );
  out("services");
  for (const service of services) {
    out(
      `  ${service.label.padEnd(20)} ${service.enabled ? (service.ok ? `${String(service.latencyMs)} ms` : (service.error ?? "failed")) : "disabled"}`,
    );
  }
  return health.reachable ? 0 : 1;
}
