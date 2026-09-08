/**
 * Regression test for "fix(migration): the offline default follows MM_FIXTURES, not true".
 *
 * `runMigration` used to build every document with the network unplugged
 * (`offline: options.offline ?? true`) no matter who called it. The worker handler and the
 * server function never passed `offline` themselves, so a production migration
 * (`MM_FIXTURES=0`) failed **every track** with `Offline: musicbrainz "release/<mbid>?
 * inc=releaseFull" has never been fetched.` even though MusicBrainz was one HTTP call away.
 * `--dry-run` never caught it: a dry run never reaches `documents.build`, so nothing was ever
 * built to fail. The fix (`apps/web/src/server/migration/v1/run.ts`) makes the default follow
 * `serverEnv().MM_FIXTURES` instead.
 *
 * This file states the property the bug violated, against the real code path rather than a
 * white-box read of `run.ts`:
 *
 *  - **`MM_FIXTURES` unset (the production shape), no explicit `offline`.** With an empty
 *    `source_cache`, `documents.build` must reach out to MusicBrainz — proven against the real
 *    client (`integrations/musicbrainz.ts`) with a cassette standing in for the socket, never a
 *    mock of `documents.build` itself — and the track migrates.
 *  - **`MM_FIXTURES=1`, same empty cache.** No request may be attempted at all — a network call
 *    here is itself a failure of the test, not just the wrong branch — and the track fails with
 *    the explicit `OFFLINE_CACHE_MISS` message instead of hanging or silently succeeding.
 *
 * Both runs go through `runMigration` exactly as the worker handler and the CLI call it: real
 * Postgres, real toolbox (fixtures mode, for `/probe` and `/tag` — unrelated to MusicBrainz's
 * offline/online switch, which is the only thing this file varies), one real audio file. Needs
 * `MM_TOOLBOX_FIXTURES=1 bun run stack:up` first, like every other integration suite.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { play, type Player } from "../cassette.ts";
import { FIXTURE_SONGS } from "../../../../fixtures/v1/dataset.ts";
import { v1Tags } from "../../../../fixtures/v1/build-library.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const SAMPLE = join(REPO_ROOT, "services/toolbox/src/toolbox/fixtures/data/sample.opus");

const LIBRARY_LEAF = ".mm-migrate-offline-regress";
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", LIBRARY_LEAF);
const LIBRARY_CONTAINER = `/library/${LIBRARY_LEAF}`;

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";

const V1_DB = `${BASE_DB}_migrate_offline_v1`;
const V2_DB_ONLINE = `${BASE_DB}_migrate_offline_online`;
const V2_DB_FIXTURES = `${BASE_DB}_migrate_offline_fixtures`;

function withDbName(url: string, name: string): string {
  return url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

const V1_URL = withDbName(BASE_URL, V1_DB);
const V2_ONLINE_URL = withDbName(BASE_URL, V2_DB_ONLINE);
const V2_FIXTURES_URL = withDbName(BASE_URL, V2_DB_FIXTURES);

/** Song 101 of the v1 fixture: Daft Punk — Discovery, track 1, a real recorded release/recording. */
const SONG = FIXTURE_SONGS.find((song) => song.id === 101);
if (SONG === undefined) throw new Error("fixture song 101 (Discovery, One More Time) is missing");
const RELATIVE_PATH = SONG.finalFilePath;
if (RELATIVE_PATH === null) throw new Error("fixture song 101 has no finalFilePath");

async function dropDatabase(name: string): Promise<void> {
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}'`,
    );
    await admin.unsafe(`drop database if exists ${name}`);
  } finally {
    await admin.end();
  }
}

async function createDatabase(name: string): Promise<void> {
  await dropDatabase(name);
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
}

async function migrateSchema(url: string): Promise<void> {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(url, { max: 1 });
  await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
  await client.end();
}

async function stackIsUp(): Promise<string | null> {
  try {
    const response = await fetch(`${TOOLBOX_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { ok?: boolean; fixtures?: boolean };
    if (body.ok !== true) return "the toolbox is not healthy";
    if (body.fixtures !== true) {
      return "the toolbox is not in fixtures mode (add -f docker-compose.fixtures.yml)";
    }
  } catch {
    return `no toolbox on ${TOOLBOX_URL}`;
  }
  try {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin`select 1`;
    await admin.end();
  } catch {
    return `no postgres on ${BASE_URL}`;
  }
  return null;
}

const unavailable = await stackIsUp();
if (unavailable !== null) {
  console.log(`  (migration offline-default regression tests skipped: ${unavailable})`);
}

const { runMigration, acknowledgeBackup } = await import("#/server/migration/v1/index.ts");
const { createDatabase: createDrizzleClient } = await import("#/server/db/client.ts");
const { resetServerEnv } = await import("#/server/env.ts");
const { requestCount, resetRequestCount, resetFetch, setFetch } =
  await import("#/server/integrations/http.ts");
const { ToolboxClient } = await import("#/server/toolbox/client.ts");
const { defaults } = await import("#/server/services/settings.ts");

const ORIGINAL_MM_FIXTURES = process.env["MM_FIXTURES"];

/** Only MusicBrainz is enabled: the bug and the fix are both entirely about that one source. */
function settingsFor(): ReturnType<typeof defaults> {
  return {
    ...defaults(),
    libraryRoot: LIBRARY_HOST,
    toolboxLibraryRoot: LIBRARY_CONTAINER,
    replayGain: false,
    navidromeEnabled: false,
    sourcesEnabled: {
      musicbrainz: true,
      coverartarchive: false,
      acoustid: false,
      lrclib: false,
      deezer: false,
      lastfm: false,
      listenbrainz: false,
      wikimedia: false,
    },
  };
}

describe.skipIf(unavailable !== null)("runMigration's offline default (decision fix)", () => {
  beforeAll(async () => {
    await createDatabase(V1_DB);
    const dump = readFileSync(join(REPO_ROOT, "fixtures/v1/dump.sql"), "utf8");
    const v1 = postgres(V1_URL, { max: 1 });
    await v1.unsafe(dump);
    await v1.end();

    rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(dirname(join(LIBRARY_HOST, RELATIVE_PATH)), { recursive: true });
    copyFileSync(SAMPLE, join(LIBRARY_HOST, RELATIVE_PATH));
    const tagResponse = await fetch(`${TOOLBOX_URL}/tag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: `${LIBRARY_CONTAINER}/${RELATIVE_PATH}`,
        format: "auto",
        tags: v1Tags(SONG),
        pictures: [],
        lyrics_lrc: null,
        sidecar_lrc: false,
        clear: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!tagResponse.ok) {
      throw new Error(
        `toolbox /tag failed for the fixture file: HTTP ${String(tagResponse.status)}`,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await dropDatabase(V1_DB);
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  afterEach(() => {
    resetFetch();
    resetRequestCount();
    // Every scenario mutates the process-wide `MM_FIXTURES` and the cached `serverEnv()`;
    // put both back so a later file in the same worker never inherits either.
    if (ORIGINAL_MM_FIXTURES === undefined) delete process.env["MM_FIXTURES"];
    else process.env["MM_FIXTURES"] = ORIGINAL_MM_FIXTURES;
    resetServerEnv();
  });

  it("reaches MusicBrainz and migrates the track when MM_FIXTURES is unset (production shape)", async () => {
    await createDatabase(V2_DB_ONLINE);
    await migrateSchema(V2_ONLINE_URL);
    const db = createDrizzleClient(V2_ONLINE_URL, 5);

    let player: Player | undefined;
    try {
      delete process.env["MM_FIXTURES"];
      resetServerEnv();
      player = play("musicbrainz");
      resetRequestCount();

      await acknowledgeBackup(db);
      const { report } = await runMigration({
        dbUrl: V1_URL,
        libraryPath: LIBRARY_HOST,
        limit: 1,
        dryRun: false,
        acknowledgeBackup: true,
        trigger: "test",
        db,
        settings: settingsFor(),
        toolbox: new ToolboxClient({ baseUrl: TOOLBOX_URL }),
        // `offline` deliberately not set: this is exactly what the worker handler and the
        // server function do, and what the bug got wrong.
      });

      expect(report.counts.failed, JSON.stringify(report.errors)).toBe(0);
      expect(report.counts.migrated).toBe(1);
      expect(requestCount()).toBeGreaterThan(0);
      expect(player.plays()).toBeGreaterThan(0);
    } finally {
      player?.restore();
      await db.$client.end({ timeout: 1 }).catch(() => undefined);
      await dropDatabase(V2_DB_ONLINE);
    }
  }, 60_000);

  it("makes no request and fails explicitly when MM_FIXTURES=1, same empty cache", async () => {
    await createDatabase(V2_DB_FIXTURES);
    await migrateSchema(V2_FIXTURES_URL);
    const db = createDrizzleClient(V2_FIXTURES_URL, 5);

    try {
      process.env["MM_FIXTURES"] = "1";
      resetServerEnv();
      // A network attempt here would itself be the bug: poison the transport instead of
      // just leaving the real `fetch` in place, so a regression cannot slip past on a
      // machine that happens to have a route to musicbrainz.org.
      setFetch(() => {
        throw new Error("BUG: a network request was attempted while MM_FIXTURES=1");
      });
      resetRequestCount();

      await acknowledgeBackup(db);
      const { report } = await runMigration({
        dbUrl: V1_URL,
        libraryPath: LIBRARY_HOST,
        limit: 1,
        dryRun: false,
        acknowledgeBackup: true,
        trigger: "test",
        db,
        settings: settingsFor(),
        toolbox: new ToolboxClient({ baseUrl: TOOLBOX_URL }),
        // `offline` deliberately not set, same as above: only MM_FIXTURES tells the two
        // scenarios apart.
      });

      expect(requestCount()).toBe(0);
      expect(report.counts.migrated).toBe(0);
      expect(report.counts.failed).toBe(1);
      expect(report.errors[0]?.message).toContain("Offline: musicbrainz");
      expect(report.errors[0]?.message).toContain("has never been fetched");
    } finally {
      resetFetch();
      await db.$client.end({ timeout: 1 }).catch(() => undefined);
      await dropDatabase(V2_DB_FIXTURES);
    }
  }, 60_000);
});
