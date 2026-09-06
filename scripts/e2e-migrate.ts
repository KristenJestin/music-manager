#!/usr/bin/env bun
/**
 * `bun run e2e-migrate` — the acceptance run of P11.
 *
 * It builds a whole v1 installation out of fixtures and then takes it over, exactly as the
 * phase's acceptance criteria describe:
 *
 *  1. load `fixtures/v1/dump.sql` into a scratch database (`mm_v1_fixture`) — thirty `Songs`
 *     rows, six `SongForceMetadata` overrides, two `UserPlaylists`;
 *  2. build the v1 library: one copy of the toolbox's five-second sample per `Present` row,
 *     tagged through `POST /tag` with **v1's** tag set and nothing else;
 *  3. `mm migrate v1 --dry-run` — a readable plan, and **zero** rows written anywhere but
 *     `migration_v1*`, asserted against the write counter and against the tables themselves;
 *  4. `mm migrate v1` — three albums migrated, documents built offline from the seeded raw
 *     cache, files re-tagged in place at the current schema, sidecars written, ReplayGain per
 *     album, paths unchanged, imports created for everything v1 never downloaded;
 *  5. `mm migrate v1` again — a genuine no-op;
 *  6. the report, printed.
 *
 * Everything is offline: the toolbox is in fixtures mode and `documents.build` runs with the
 * network unplugged against the cache `cache:seed-fixtures` wrote.
 *
 * It takes a database and a library directory of its own, both named after this process, so
 * it can run beside another agent's `bun run e2e` without either noticing (`CLAUDE.md`, the
 * process-safety note).
 *
 *     docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres toolbox
 *     bun run e2e-migrate
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import {
  bun,
  capture,
  createFreshDatabase,
  dropDatabaseIfExists,
  repoRoot,
  webDir,
  withDatabaseName,
} from "./lib.ts";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

const ADMIN_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

/** The v2 database under test, and the scratch database standing in for v1. */
const V2_DB = process.env["MM_E2E_DB"] ?? `mm_migrate_e2e_${String(process.pid)}`;
const V1_DB = process.env["MM_V1_FIXTURE_DB"] ?? "mm_v1_fixture";
const V2_DATABASE_URL = withDatabaseName(ADMIN_DATABASE_URL, V2_DB);
const V1_DATABASE_URL = withDatabaseName(ADMIN_DATABASE_URL, V1_DB);

/**
 * The library. It is inside the directory the toolbox has mounted, because that is the only
 * place the toolbox can read — and because migration *keeps the v1 paths*, which means in a
 * real migration the v1 library and the v2 library are the same directory.
 */
/*
 * A directory of its own per run, named after this process.
 *
 * Two reasons, both learned the hard way. Two concurrent runs would otherwise migrate into
 * each other; and this path is a Docker bind mount, where deleting and recreating the *same*
 * directory name leaves Docker Desktop on Windows serving the container a stale inode — every
 * later /tag on it answers "No such file" for a file that is plainly on the host. A fresh name
 * per run is picked up correctly every time, and is removed again at the end.
 */
const LIBRARY_LEAF = process.env["MM_E2E_LIBRARY_LEAF"] ?? `.mm-migrate-${String(process.pid)}`;
const LIBRARY = resolve(repoRoot, ".local", "library", LIBRARY_LEAF);
const TOOLBOX_LIBRARY = `/library/${LIBRARY_LEAF}`;

const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  DATABASE_URL: V2_DATABASE_URL,
  MM_TOOLBOX_URL: TOOLBOX_URL,
  MM_FIXTURES: "1",
  MM_TOOLBOX_FIXTURES: "1",
  MM_LIBRARY_ROOT: LIBRARY,
  MM_TOOLBOX_LIBRARY_ROOT: TOOLBOX_LIBRARY,
};

/* ------------------------------------------------------------------ */
/* reporting                                                           */
/* ------------------------------------------------------------------ */

let failures = 0;
let checks = 0;

const section = (title: string): void => {
  console.log(`\n=== ${title} ===`);
};
const info = (message: string): void => {
  console.log(`  ..   ${message}`);
};
function check(ok: boolean, what: string, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail === "" ? "" : `  ${detail}`}`);
}
function die(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function mm(
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await capture({
    label: `mm ${args.join(" ")}`,
    cmd: [bun, "run", join(webDir, "bin", "mm.ts"), ...args],
    env: childEnv,
  });
  if (result.code !== 0 && options.allowFailure !== true) {
    console.log(result.stdout);
    console.error(result.stderr);
    die(`mm ${args.join(" ")} exited ${String(result.code)}`);
  }
  return result;
}

async function must(label: string, cmd: string[]): Promise<void> {
  const result = await capture({ label, cmd, env: childEnv });
  if (result.code !== 0) {
    console.log(result.stdout);
    console.error(result.stderr);
    die(`"${label}" failed with exit code ${String(result.code)}`);
  }
}

async function toolboxReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${TOOLBOX_URL}/health`, { signal: AbortSignal.timeout(4000) });
      const body = (await response.json()) as { ok?: boolean; fixtures?: boolean };
      if (body.ok === true) {
        if (body.fixtures !== true) {
          die(
            "the toolbox is up but not in fixtures mode — bring it up with:\n" +
              "  docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres toolbox",
          );
        }
        return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) die(`no usable toolbox on ${TOOLBOX_URL}`);
    await Bun.sleep(1000);
  }
}

async function probe(relative: string): Promise<Record<string, string>> {
  const response = await fetch(`${TOOLBOX_URL}/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: `${TOOLBOX_LIBRARY}/${relative}` }),
  });
  if (!response.ok) die(`toolbox /probe failed for ${relative}: HTTP ${String(response.status)}`);
  const body = (await response.json()) as { tags?: Record<string, string> };
  return body.tags ?? {};
}

/** Every audio file under the library, library-relative, sorted. */
function walk(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(child, relative));
    else out.push(relative);
  }
  return out.sort();
}

interface Report {
  runId: string;
  dryRun: boolean;
  counts: {
    songs: number;
    byClass: Record<string, number>;
    migrated: number;
    documentsComplete: number;
    importsCreated: number;
    importTracksCreated: number;
    orphanFiles: number;
    withoutFile: number;
    filesRetagged: number;
    sidecarsWritten: number;
    replaygainAlbums: number;
    renamed: number;
    inboxItems: number;
    failed: number;
    alreadyDone: number;
  };
  albums: { folder: string; tracks: number; completeness: number | null; replaygain: boolean }[];
  imports: { importId: string; status: string; tracks: number; preselected: number }[];
  playlists: { name: string; entries: number; missing: number }[];
  discrepancies: { kind: string; detail: string }[];
  errors: { message: string }[];
  writes: number;
}

/* ------------------------------------------------------------------ */
/* the run                                                             */
/* ------------------------------------------------------------------ */

const v2 = new SQL({ url: V2_DATABASE_URL, max: 2 });

async function main(): Promise<void> {
  section("preflight");
  await toolboxReady();
  info(`toolbox healthy at ${TOOLBOX_URL}, fixtures mode on`);

  await createFreshDatabase(ADMIN_DATABASE_URL, V2_DB);
  await must("migrate the v2 schema", [bun, "run", join(webDir, "src/server/db/migrate.ts")]);
  await must("seed the recorded sources", [
    bun,
    "run",
    join(webDir, "src/server/integrations/seed-fixtures.ts"),
  ]);
  info(`v2 database ${V2_DB} created, migrated and seeded`);

  /* ---------------------------------------------------------------- */
  section("1 · the v1 installation, from fixtures");
  /* ---------------------------------------------------------------- */

  await createFreshDatabase(ADMIN_DATABASE_URL, V1_DB);
  const dump = readFileSync(join(repoRoot, "fixtures/v1/dump.sql"), "utf8");
  const v1 = new SQL({ url: V1_DATABASE_URL, max: 1 });
  await v1.unsafe(dump);
  const [songCount] = await v1<{ count: number }[]>`select count(*)::int as count from "Songs"`;
  const [forceCount] = await v1<
    { count: number }[]
  >`select count(*)::int as count from "SongForceMetadata"`;
  const [playlistCount] = await v1<
    { count: number }[]
  >`select count(*)::int as count from "UserPlaylists"`;
  await v1.end();

  check(songCount?.count === 30, "the dump loaded thirty Songs rows", String(songCount?.count));
  check(forceCount?.count === 6, "with six SongForceMetadata overrides", String(forceCount?.count));
  check(playlistCount?.count === 2, "and two UserPlaylists", String(playlistCount?.count));

  // The builder empties the directory; it deliberately does not delete it. See the note in
  // `fixtures/v1/build-library.ts`: this path is a Docker bind mount, and recreating the
  // mounted directory itself is how the container ends up looking at a stale inode.
  await must("build the v1 fixture library", [
    bun,
    "run",
    join(repoRoot, "fixtures/v1/build-library.ts"),
  ]);
  const beforeFiles = walk(LIBRARY);
  check(
    beforeFiles.filter((path) => path.endsWith(".opus")).length === 25,
    "the v1 library holds twenty-five tagged Opus files",
    String(beforeFiles.filter((path) => path.endsWith(".opus")).length),
  );

  // The files must carry v1's tags and none of v2's, or the migration proves nothing.
  const sampleTags = await probe("Daft Punk/Discovery (2001)/01 - One More Time.opus");
  check(
    sampleTags["MUSICBRAINZ_TRACKID"] === "60fa767a-d85d-4991-82bc-4294e0b11ae7",
    "v1 wrote the recording id into MUSICBRAINZ_TRACKID",
    sampleTags["MUSICBRAINZ_TRACKID"] ?? "(absent)",
  );
  check(
    sampleTags["MUSICMANAGER_TAGSCHEMA"] === undefined,
    "and nothing v2-only is in the file yet",
  );
  check(
    (sampleTags["COMMENT"] ?? "").startsWith("Source: "),
    "the only provenance is v1's `Source: <url>` comment",
    sampleTags["COMMENT"] ?? "(absent)",
  );
  check(
    sampleTags["MUSICBRAINZ_RELEASETRACKID"] === undefined,
    "and no release-track id, which only v2 writes",
  );

  /* ---------------------------------------------------------------- */
  section("2 · dry run: a readable plan, and no writes at all");
  /* ---------------------------------------------------------------- */

  const dry = await mm([
    "migrate",
    "v1",
    "--db",
    V1_DATABASE_URL,
    "--library",
    LIBRARY,
    "--dry-run",
    "--json",
  ]);
  const dryReport = JSON.parse(dry.stdout) as Report;

  check(dryReport.dryRun, "the run is marked as a dry run");
  check(dryReport.counts.songs === 30, "it read thirty v1 songs", String(dryReport.counts.songs));
  check(
    dryReport.counts.byClass["present_with_file"] === 24,
    "twenty-four rows have a file",
    JSON.stringify(dryReport.counts.byClass),
  );
  check(dryReport.counts.byClass["needed"] === 2, "two rows were never downloaded");
  check(dryReport.counts.byClass["needs_manual_review"] === 1, "one row needs a manual review");
  check(dryReport.counts.byClass["failed"] === 2, "two rows failed in v1");
  check(
    dryReport.counts.byClass["present_missing_file"] === 1,
    "one Present row has lost its file",
  );
  check(dryReport.albums.length === 3, "it plans three albums", String(dryReport.albums.length));
  check(dryReport.counts.orphanFiles === 1, "and finds the one orphan file");
  check(dryReport.writes === 0, "the write counter is zero", String(dryReport.writes));

  const [albumsAfterDry] = await v2<
    { count: number }[]
  >`select count(*)::int as count from library_albums`;
  const [tracksAfterDry] = await v2<
    { count: number }[]
  >`select count(*)::int as count from library_tracks`;
  const [importsAfterDry] = await v2<
    { count: number }[]
  >`select count(*)::int as count from imports`;
  const [docsAfterDry] = await v2<
    { count: number }[]
  >`select count(*)::int as count from metadata_documents`;
  check(
    (albumsAfterDry?.count ?? -1) === 0 &&
      (tracksAfterDry?.count ?? -1) === 0 &&
      (importsAfterDry?.count ?? -1) === 0 &&
      (docsAfterDry?.count ?? -1) === 0,
    "and the four tables it would have written to are still empty",
    `albums ${String(albumsAfterDry?.count)} tracks ${String(tracksAfterDry?.count)} ` +
      `imports ${String(importsAfterDry?.count)} documents ${String(docsAfterDry?.count)}`,
  );

  const afterDryFiles = walk(LIBRARY);
  check(
    JSON.stringify(afterDryFiles) === JSON.stringify(beforeFiles),
    "no file was added, removed or renamed",
    `${String(afterDryFiles.length)} file(s)`,
  );
  const afterDryTags = await probe("Daft Punk/Discovery (2001)/01 - One More Time.opus");
  check(afterDryTags["MUSICMANAGER_TAGSCHEMA"] === undefined, "and no file was re-tagged");

  /* ---------------------------------------------------------------- */
  section("3 · a real run without an acknowledged backup is refused");
  /* ---------------------------------------------------------------- */

  const unsafe = await mm(["migrate", "v1", "--db", V1_DATABASE_URL, "--library", LIBRARY], {
    allowFailure: true,
  });
  check(unsafe.code !== 0, "it exits non-zero", `code ${String(unsafe.code)}`);
  check(
    `${unsafe.stdout}${unsafe.stderr}`.includes("backup"),
    "and says why",
    `${unsafe.stdout}${unsafe.stderr}`.trim().split("\n")[0] ?? "",
  );

  /* ---------------------------------------------------------------- */
  section("4 · the migration");
  /* ---------------------------------------------------------------- */

  const real = await mm([
    "migrate",
    "v1",
    "--db",
    V1_DATABASE_URL,
    "--library",
    LIBRARY,
    "--i-have-a-backup",
    "--json",
  ]);
  const report = JSON.parse(real.stdout) as Report;

  check(report.counts.failed === 0, "nothing failed", JSON.stringify(report.errors.slice(0, 3)));
  check(report.albums.length === 3, "three albums migrated", String(report.albums.length));
  check(
    report.counts.migrated === 24,
    "twenty-four tracks migrated",
    String(report.counts.migrated),
  );
  check(
    report.counts.filesRetagged === 24,
    "and every one of them was re-tagged in place",
    String(report.counts.filesRetagged),
  );
  check(report.counts.renamed === 0, "no file was renamed (paths are kept by default)");

  /* ---- paths unchanged --------------------------------------------- */
  const afterFiles = walk(LIBRARY).filter((path) => path.endsWith(".opus"));
  const beforeOpus = beforeFiles.filter((path) => path.endsWith(".opus"));
  check(
    JSON.stringify(afterFiles) === JSON.stringify(beforeOpus),
    "every .opus file is exactly where v1 left it",
    `${String(afterFiles.length)} file(s)`,
  );

  /* ---- the tags are v2's now --------------------------------------- */
  const migrated = await probe("Daft Punk/Discovery (2001)/01 - One More Time.opus");
  check(
    migrated["MUSICMANAGER_TAGSCHEMA"] !== undefined,
    "the files carry the current tag schema",
    migrated["MUSICMANAGER_TAGSCHEMA"] ?? "(absent)",
  );
  check(
    migrated["MUSICBRAINZ_TRACKID"] === "60fa767a-d85d-4991-82bc-4294e0b11ae7",
    "the recording id survived (Picard's key, which v1 and v2 both use)",
    migrated["MUSICBRAINZ_TRACKID"] ?? "(absent)",
  );
  check(
    migrated["MUSICBRAINZ_RELEASETRACKID"] !== undefined,
    "and v2 added the release-track id v1 never wrote",
    migrated["MUSICBRAINZ_RELEASETRACKID"] ?? "(absent)",
  );
  check(
    migrated["R128_TRACK_GAIN"] !== undefined || migrated["REPLAYGAIN_TRACK_GAIN"] !== undefined,
    "ReplayGain was written",
    migrated["R128_TRACK_GAIN"] ?? migrated["REPLAYGAIN_TRACK_GAIN"] ?? "(absent)",
  );
  check(
    report.counts.replaygainAlbums === 3,
    "once per album, not once per file",
    String(report.counts.replaygainAlbums),
  );

  /* ---- documents --------------------------------------------------- */
  const discovery = report.albums.find((album) => album.folder.includes("Discovery"));
  check(
    (discovery?.completeness ?? 0) > 0.85,
    "the album with MusicBrainz ids scores high",
    `${String(Math.round((discovery?.completeness ?? 0) * 100))}%`,
  );
  check(
    report.counts.documentsComplete >= 13,
    "and its thirteen documents have every required field, n/a excluded",
    String(report.counts.documentsComplete),
  );

  // The overrides are the only good metadata album B has, so "locked" is the assertion that
  // matters most in the whole run: it is what a migration would otherwise silently revert.
  const locked = await v2<{ field: string }[]>`
    select jsonb_object_keys(d.document->'fields') as field
      from metadata_documents d
     where d.document->'fields' @> '{"title":{"locked":true}}'::jsonb`;
  const lockedTitle = await v2<{ value: string }[]>`
    select d.document->'fields'->'title'->>'value' as value
      from metadata_documents d
     where d.document->'fields' @> '{"title":{"locked":true}}'::jsonb`;
  check(
    locked.length > 0,
    "the SongForceMetadata title override came across locked",
    lockedTitle[0]?.value ?? "(none)",
  );
  check(
    lockedTitle[0]?.value === "Genesis (Woman Worldwide edit)",
    "with the value v1's owner typed in, not the one v1 guessed",
    lockedTitle[0]?.value ?? "(none)",
  );

  const lockedGenre = await v2<{ value: string }[]>`
    select d.document->'fields'->'genre'->>'value' as value
      from metadata_documents d
     where d.document->'fields' @> '{"genre":{"locked":true}}'::jsonb`;
  check(
    (lockedGenre[0]?.value ?? "").includes("French House"),
    "and the `;`-joined forced genre list came across split and locked",
    lockedGenre[0]?.value ?? "(none)",
  );

  /* ---- sidecars ---------------------------------------------------- */
  check(
    report.counts.sidecarsWritten > 0,
    "sidecars were written",
    String(report.counts.sidecarsWritten),
  );

  /* ---- imports for what v1 never downloaded ------------------------ */
  // Three, not six: the rows are grouped by the v1 parent playlist they came from, which is
  // what § Étapes 4 asks for. Four Birdy rows share one, and the two `Needed` rows have none,
  // so each of those becomes an import of its own.
  check(
    report.counts.importsCreated === 3,
    "three imports were created for the six rows with no file, grouped by parent playlist",
    String(report.counts.importsCreated),
  );
  check(
    report.counts.importTracksCreated === 6,
    "one import track per row",
    String(report.counts.importTracksCreated),
  );

  const needed = await v2<{ id: string; status: string; preselect: string | null }[]>`
    select i.id, i.status::text as status, it.recording_mbid as preselect
      from imports i join import_tracks it on it.import_id = i.id
     where it.raw->>'v1Status' = 'Needed'
     order by it.id`;
  check(needed.length === 2, "the two Needed songs became imports", String(needed.length));
  check(
    needed.every((row) => row.status === "paused"),
    "queued rather than running — a migration downloads nothing",
    needed.map((row) => row.status).join(", "),
  );
  check(
    needed.every((row) => row.preselect !== null),
    "each carrying its forced MBID as a preselection",
    needed.map((row) => row.preselect ?? "(none)").join(", "),
  );

  const review = await v2<{ status: string }[]>`
    select i.status::text as status from imports i
      join import_tracks it on it.import_id = i.id
     where it.raw->>'v1Status' = 'NeedsManualReview'`;
  check(
    review[0]?.status === "awaiting_review",
    "the NeedsManualReview row rests in awaiting_review",
    review[0]?.status ?? "(none)",
  );

  const [inbox] = await v2<{ count: number }[]>`
    select count(*)::int as count from inbox_items where status = 'open'`;
  check((inbox?.count ?? 0) > 0, "and the Inbox has the questions", String(inbox?.count));

  /* ---- nothing was downloaded -------------------------------------- */
  const [downloaded] = await v2<{ count: number }[]>`
    select count(*)::int as count from import_tracks where download_path is not null`;
  check((downloaded?.count ?? -1) === 0, "no track was downloaded during the migration");

  /* ---- playlists ---------------------------------------------------- */
  const archive = resolve(LIBRARY, "..", "_archive", "v1-playlists");
  check(
    report.playlists.length === 2,
    "both v1 playlists were exported as M3U",
    report.playlists.map((playlist) => playlist.name).join(", "),
  );
  const m3u = existsSync(archive) ? readdirSync(archive) : [];
  check(m3u.length === 2, `two .m3u8 files in ${archive}`, m3u.join(", "));
  const roadTrip = m3u.find((name) => name.startsWith("Road trip"));
  if (roadTrip !== undefined) {
    const body = readFileSync(join(archive, roadTrip), "utf8");
    check(body.startsWith("#EXTM3U"), "the export is a real M3U");
    check(body.includes("# not migrated"), "and says which of its songs v1 never downloaded");
  }
  const [playlistTables] = await v2<{ count: number }[]>`
    select count(*)::int as count from information_schema.tables
     where table_schema = 'public' and table_name like '%playlist%'`;
  check(
    (playlistTables?.count ?? -1) === 0,
    "no playlist data entered v2 — the export is all there is",
  );

  /* ---- the discrepancy report --------------------------------------- */
  const kinds = new Set(report.discrepancies.map((item) => item.kind));
  check(kinds.has("path_moved"), "the two moved files are reported as moved");
  check(kinds.has("missing_file"), "the Present row with no file is reported");
  check(kinds.has("orphan_file"), "the unclaimed file is reported as an orphan");

  const matched = await v2<{ matched_by: string; count: number }[]>`
    select matched_by, count(*)::int as count from migration_v1
     where outcome = 'migrated' group by matched_by order by matched_by`;
  const byKey = Object.fromEntries(matched.map((row) => [row.matched_by, row.count]));
  check(
    byKey["recording_mbid"] === 1,
    "one file was found only by its recording MBID",
    JSON.stringify(byKey),
  );
  check(byKey["youtube_id"] === 1, "and one only by the YouTube id in its comment");

  /* ---------------------------------------------------------------- */
  section("5 · a second run is a no-op");
  /* ---------------------------------------------------------------- */

  const sizesBefore = new Map(
    afterFiles.map((path) => [path, statSync(join(LIBRARY, path)).mtimeMs]),
  );

  const again = await mm([
    "migrate",
    "v1",
    "--db",
    V1_DATABASE_URL,
    "--library",
    LIBRARY,
    "--json",
  ]);
  const second = JSON.parse(again.stdout) as Report;

  check(second.counts.migrated === 0, "nothing was migrated again", String(second.counts.migrated));
  check(
    second.counts.importsCreated === 0,
    "no import was created again",
    String(second.counts.importsCreated),
  );
  check(
    second.counts.alreadyDone === 30,
    "all thirty rows were recognised as already done",
    String(second.counts.alreadyDone),
  );
  check(second.counts.failed === 0, "and nothing failed");

  const untouched = afterFiles.every(
    (path) => statSync(join(LIBRARY, path)).mtimeMs === sizesBefore.get(path),
  );
  check(untouched, "not one file was rewritten");

  const [albumsNow] = await v2<
    { count: number }[]
  >`select count(*)::int as count from library_albums`;
  const [tracksNow] = await v2<
    { count: number }[]
  >`select count(*)::int as count from library_tracks`;
  check(
    (albumsNow?.count ?? 0) === 3 && (tracksNow?.count ?? 0) === 24,
    "the library still holds exactly what the first run put there",
    `${String(albumsNow?.count)} album(s), ${String(tracksNow?.count)} track(s)`,
  );

  /* ---------------------------------------------------------------- */
  section("6 · the report");
  /* ---------------------------------------------------------------- */
  const printed = await mm(["migrate", "show", report.runId]);
  console.log("");
  console.log(printed.stdout.trimEnd());

  section("result");
  console.log(`  ${String(checks - failures)}/${String(checks)} checks passed`);
  if (failures > 0) die(`${String(failures)} check(s) failed`);
}

async function cleanup(): Promise<void> {
  await v2.end().catch(() => {});
  if (process.env["MM_E2E_KEEP"] === "1") return;
  await dropDatabaseIfExists(ADMIN_DATABASE_URL, V2_DB).catch(() => {});
  await dropDatabaseIfExists(ADMIN_DATABASE_URL, V1_DB).catch(() => {});
  // Both the library and the playlist archive this run created, and nothing else.
  rmSync(LIBRARY, { recursive: true, force: true });
  rmSync(resolve(LIBRARY, "..", "_archive", "v1-playlists"), { recursive: true, force: true });
}

try {
  await main();
  await cleanup();
  console.log("\ne2e-migrate: green\n");
  process.exit(0);
} catch (error) {
  console.error(error);
  await cleanup();
  process.exit(1);
}
