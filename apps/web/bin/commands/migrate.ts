/**
 * `mm migrate v1` — the command line of P11.
 *
 * Its own module rather than another function in `bin/mm.ts`, for the reason `library-ops.ts`
 * gives: that file is a table of contents that several phases extend at once, and a command
 * living in its own file costs three lines in the dispatcher and nothing else.
 *
 * The command prints a report a human reads and, with `--json`, the same report a script
 * reads. Nothing here decides anything: every decision is in `src/server/migration/v1/`, so
 * the Console's button and this command cannot disagree about what a migration does.
 */
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import {
  acknowledgeBackup,
  backupAcknowledged,
  formatReport,
  listRuns,
  getRun,
  reportOf,
  runMigration,
} from "#/server/migration/v1/index.ts";
import { serverEnv } from "#/server/env.ts";

export interface CliArgs {
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

const out = (...parts: unknown[]): void => {
  console.log(parts.join(" "));
};

/**
 * A warning goes to stderr, not stdout.
 *
 * `--json` promises the report and nothing else on stdout, because that is what a script
 * parses; the rename banner printed there made `mm migrate v1 --rename-to-template --json`
 * emit a document no JSON parser accepts. stderr keeps the warning in front of the person who
 * typed the flag — which is the whole point of it — without putting it in the pipe.
 */
const warn = (...parts: unknown[]): void => {
  console.warn(parts.join(" "));
};

const flagString = (args: CliArgs, name: string): string | undefined =>
  typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined;

const flagBoolean = (args: CliArgs, name: string): boolean =>
  args.flags[name] === true || args.flags[name] === "true";

export const MIGRATE_USAGE = `usage:
  mm migrate v1 --db <postgres url> --library <dir> [--dry-run] [--rename-to-template]
                [--limit N] [--resume] [--i-have-a-backup] [--verify] [--json]
  mm migrate runs
  mm migrate show <run id> [--json]`;

/**
 * The warning `--rename-to-template` earns.
 *
 * Navidrome identifies a file by its path. Renaming one loses its play count and its
 * favourites, which for a library somebody has listened to for years is the most valuable
 * thing in it — more valuable than the tags this whole project is about. So the flag is off by
 * default and says this every time it is on.
 */
const RENAME_WARNING = [
  "  ! --rename-to-template will MOVE every migrated file to the v2 path template.",
  "  ! Navidrome identifies files by path: play counts and favourites for the renamed",
  "  ! files will be lost, and cannot be recovered afterwards.",
  "  ! The default — keeping the v1 paths — is what preserves them.",
].join("\n");

export async function cmdMigrate(args: CliArgs): Promise<number> {
  const sub = args.positional[1];

  if (sub === "runs") return await cmdRuns();
  if (sub === "show") return await cmdShow(args);
  if (sub !== "v1") {
    throw new MMError("INVALID_INPUT", MIGRATE_USAGE, {
      hint: 'The only source this migrates from is v1, so the subcommand is "v1".',
    });
  }

  const dbUrl = flagString(args, "db") ?? process.env["V1_DATABASE_URL"];
  const library = flagString(args, "library") ?? process.env["V1_LIBRARY_PATH"];

  if (dbUrl === undefined || library === undefined) {
    throw new MMError("INVALID_INPUT", "mm migrate v1 needs both --db and --library.", {
      hint:
        `${MIGRATE_USAGE}\n` +
        "V1_DATABASE_URL and V1_LIBRARY_PATH are read when the flags are absent.",
    });
  }

  const dryRun = flagBoolean(args, "dry-run");
  const renameToTemplate = flagBoolean(args, "rename-to-template");
  const limitRaw = flagString(args, "limit");
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new MMError("INVALID_INPUT", `--limit must be a number, got "${String(limitRaw)}".`);
  }

  if (renameToTemplate && !dryRun) {
    warn(RENAME_WARNING);
    warn("");
  }

  const env = serverEnv();
  const result = await runMigration({
    dbUrl,
    libraryPath: library,
    dryRun,
    renameToTemplate,
    ...(limit === undefined ? {} : { limit }),
    resume: flagBoolean(args, "resume"),
    acknowledgeBackup: flagBoolean(args, "i-have-a-backup"),
    verify: flagBoolean(args, "verify"),
    // Fixtures mode never reaches the network; a real migration may, because the v1 MBIDs are
    // exactly what makes a document worth rebuilding.
    offline: env.MM_FIXTURES,
    trigger: "cli",
    db: db(),
    say: async (message) => {
      if (!flagBoolean(args, "json") && flagBoolean(args, "verbose")) out(`  ..   ${message}`);
    },
  });

  if (flagBoolean(args, "json")) {
    out(JSON.stringify(result.report, null, 2));
  } else {
    out("");
    out(formatReport(result.report));
  }

  return result.report.counts.failed > 0 ? 1 : 0;
}

async function cmdRuns(): Promise<number> {
  const runs = await listRuns(20, db());
  if (runs.length === 0) {
    out("No migration has been run yet.");
    const acknowledged = await backupAcknowledged(db());
    out(
      acknowledged === null
        ? "A backup has not been acknowledged; a real run will refuse to start."
        : `A backup was acknowledged on ${acknowledged}.`,
    );
    return 0;
  }

  out(
    "id                              when                  mode      status   migrated imports failed",
  );
  for (const run of runs) {
    out(
      `${run.id.padEnd(31)} ${run.createdAt.toISOString().slice(0, 19)}  ` +
        `${(run.dryRun ? "dry run" : "real").padEnd(9)} ${run.status.padEnd(8)} ` +
        `${String(run.migrated).padStart(8)} ${String(run.importsCreated).padStart(7)} ` +
        `${String(run.failed).padStart(6)}`,
    );
  }
  return 0;
}

async function cmdShow(args: CliArgs): Promise<number> {
  const id = args.positional[2];
  if (id === undefined) throw new MMError("INVALID_INPUT", "usage: mm migrate show <run id>");
  const run = await getRun(id, db());
  if (run === null) throw new MMError("NOT_FOUND", `No migration run with id ${id}.`);

  const report = reportOf(run);
  if (report === null) {
    out(`${run.id}: ${run.status}, no report (${run.message ?? "still running"}).`);
    return 0;
  }
  if (flagBoolean(args, "json")) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  out(formatReport(report));
  return 0;
}

/** `mm migrate --i-have-a-backup` on its own, for somebody who wants to tick the box first. */
export async function cmdAcknowledgeBackup(): Promise<number> {
  await acknowledgeBackup(db());
  out("Backup acknowledged. `mm migrate v1` will now run for real.");
  return 0;
}
