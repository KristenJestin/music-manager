/**
 * The projection invariant, against a real Postgres.
 *
 * `AGENTS.md` opens on it: *the database is the source of truth for metadata; files are a
 * regenerable projection of it*. Four things had to become true, and none of them can be shown
 * without a database because every one of them is a row:
 *
 *  1. **the two questions are different questions.** `tracksBehindSchema` compares a schema
 *     *version*; `tracksAdrift` compares values. A re-matched album is invisible to the first
 *     and obvious to the second, which is why `mm retag` answered "nothing to do" on twelve
 *     files carrying the previous edition's identifiers;
 *  2. **a re-match queues the catch-up**, from `matchStep`, whichever door the confirmation came
 *     through;
 *  3. **a write that changes nothing queues nothing** — the honest test is the hash, so this is
 *     a property of the comparison and not of a caller being careful;
 *  4. **no loops and no floods**: a re-tag queues no re-tag, and a second write lands on the
 *     run the first one opened rather than opening a second.
 *
 * Offline: no toolbox, no network, no files. The one test that drives `runBatch` does it over
 * files that are deliberately *not* on disk, because what is under test there is which tracks
 * reach the loop at all — and before the fix a library run reached it with none of them.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrackDocument } from "@mm/domain";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_projection`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

async function postgresIsUp(): Promise<string | null> {
  try {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin`select 1`;
    await admin.end();
    return null;
  } catch {
    return `no postgres on ${BASE_URL}`;
  }
}

const unavailable = await postgresIsUp();
if (unavailable !== null) console.log(`  (projection integration tests skipped: ${unavailable})`);

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const { eq } = await import("drizzle-orm");
const schema = await import("#/server/db/schema/index.ts");
const { field, projectDocument, TAG_SCHEMA_VERSION } = await import("@mm/domain");

const { projectionHash } = await import("./jobs/steps/tag.ts");
const { tracksAdrift, tracksBehindSchema } = await import("./quality.ts");
const { ensureProjection, withoutProjection } = await import("./projection.ts");
const { createRun, planRetag, runBatch } = await import("./retag.ts");
const { storeDocument } = await import("./documents.ts");

resetServerEnv();

const AT = "2026-09-17T00:00:00.000Z";

/** The release and the recordings this album was filed under. */
const OLD = {
  release: "1111aaaa-0000-4000-8000-000000000001",
  track: (n: number) => `47b7da5d-0000-4000-8000-00000000000${String(n)}`,
  recording: (n: number) => `aaaa1111-0000-4000-8000-00000000000${String(n)}`,
};
/** The edition confirmed today. The owner's AURORA numbers, in shape if not in value. */
const NEW = {
  release: "2222bbbb-0000-4000-8000-000000000002",
  track: (n: number) => `9d279b62-0000-4000-8000-00000000000${String(n)}`,
};

function document(overrides: Record<string, unknown> = {}): TrackDocument {
  const fields: Record<string, ReturnType<typeof field>> = {};
  const put = (name: string, value: unknown): void => {
    fields[name] = field(value as never, "musicbrainz", AT);
  };
  put("title", "The Woman I Am");
  put("artist", "AURORA");
  put("album", "The Gods We Can Touch");
  put("albumartist", "AURORA");
  put("tracknumber", 1);
  put("musicbrainz_albumid", OLD.release);
  put("musicbrainz_recordingid", OLD.recording(1));
  put("musicbrainz_releasetrackid", OLD.track(1));
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete fields[name];
    else put(name, value);
  }
  return { fields, na: {}, schemaVersion: TAG_SCHEMA_VERSION } as unknown as TrackDocument;
}

interface Seed {
  albumId: string;
  importId: string;
  trackIds: string[];
  importTrackIds: string[];
}

/**
 * One album, two placed tracks, each with an import row, a document, and — the part that makes
 * this a *placed* track rather than a row nobody wrote a file for — a `projection_hash`
 * stamped exactly as the `tag` step stamps it once mutagen has written and read the block back.
 */
async function seedAlbum(suffix: string): Promise<Seed> {
  const database = db();
  const albumId = `alb_${suffix}`;
  const importId = `imp_${suffix}`;

  await database.insert(schema.libraryAlbums).values({
    id: albumId,
    releaseMbid: OLD.release,
    albumArtist: "AURORA",
    title: "The Gods We Can Touch",
    year: 2022,
    folder: `AURORA/The Gods We Can Touch (2022) ${suffix}`,
    trackCount: 2,
    presentCount: 2,
  });

  await database.insert(schema.imports).values({
    id: importId,
    url: `fixture://discovery?${suffix}`,
    kind: "album",
    releaseMbid: OLD.release,
  });

  const trackIds: string[] = [];
  const importTrackIds: string[] = [];
  for (const position of [1, 2]) {
    const importTrackId = `itr_${suffix}${String(position)}`;
    const trackId = `ltr_${suffix}${String(position)}`;
    await database.insert(schema.importTracks).values({
      id: importTrackId,
      importId,
      position,
      videoId: `vid${suffix}${String(position)}`,
      url: `https://youtu.be/vid${suffix}${String(position)}`,
      sourceTitle: `Track ${String(position)}`,
      role: "mapped",
      state: "done",
      trackPosition: position,
      mediumPosition: 1,
      recordingMbid: OLD.recording(position),
      trackMbid: OLD.track(position),
    });
    await database.insert(schema.libraryTracks).values({
      id: trackId,
      albumId,
      title: `Track ${String(position)}`,
      artist: "AURORA",
      discNumber: 1,
      trackNumber: position,
      path: `AURORA/The Gods We Can Touch (2022) ${suffix}/0${String(position)} Track.opus`,
      importId,
      importTrackId,
      recordingMbid: OLD.recording(position),
      trackMbid: OLD.track(position),
      tagSchemaVersion: TAG_SCHEMA_VERSION,
    });
    const doc = document({
      title: `Track ${String(position)}`,
      tracknumber: position,
      musicbrainz_releasetrackid: OLD.track(position),
      musicbrainz_recordingid: OLD.recording(position),
    });
    await database.insert(schema.metadataDocuments).values({
      id: `doc_${suffix}${String(position)}`,
      importTrackId,
      libraryTrackId: trackId,
      document: doc as unknown as Record<string, unknown>,
      tagSchemaVersion: TAG_SCHEMA_VERSION,
      projectionHash: projectionHash(projectDocument(doc, "vorbis")),
    });
    trackIds.push(trackId);
    importTrackIds.push(importTrackId);
  }

  return { albumId, importId, trackIds, importTrackIds };
}

/** What a re-match writes: a different release, and a different release-track per video. */
async function reMatch(seed: Seed): Promise<void> {
  await db()
    .update(schema.imports)
    .set({ releaseMbid: NEW.release })
    .where(eq(schema.imports.id, seed.importId));
  for (const [index, importTrackId] of seed.importTrackIds.entries()) {
    await db()
      .update(schema.importTracks)
      .set({ trackMbid: NEW.track(index + 1) })
      .where(eq(schema.importTracks.id, importTrackId));
  }
}

describe.skipIf(unavailable !== null)("the projection invariant, against a real database", () => {
  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();
  }, 120_000);

  /* ---- 1 · the two questions are different questions ---- */

  it("a freshly filed album is adrift from nothing", async () => {
    const seed = await seedAlbum("P1");
    expect(await tracksAdrift({ db: db(), albumId: seed.albumId })).toHaveLength(0);
  });

  it("a re-matched album is adrift, and the schema-version question cannot see it", async () => {
    const seed = await seedAlbum("P2");
    await reMatch(seed);

    const adrift = await tracksAdrift({ db: db(), albumId: seed.albumId });
    expect(adrift).toHaveLength(2);
    expect(adrift.map((entry) => entry.reason)).toEqual(["sources", "sources"]);

    /*
     * The defect, as a row. Every file carries the current `MUSICMANAGER_TAGSCHEMA`, so the
     * selection every surface used to default to finds nothing at all — which is what
     * `mm retag --album …` reported as "every file in scope already carries that projection"
     * over twelve files that plainly did not.
     */
    const behind = await tracksBehindSchema({ db: db(), albumId: seed.albumId });
    expect(behind).toHaveLength(0);
    const planned = await planRetag({
      db: db(),
      scope: "album",
      targetId: seed.albumId,
      selection: "adrift",
    });
    expect(planned.map((track) => track.id).sort()).toEqual([...seed.trackIds].sort());
  });

  it("a corrected field is adrift too, by the hash rather than by the mapping", async () => {
    const seed = await seedAlbum("P3");
    const importTrackId = seed.importTrackIds[0] ?? "";
    await storeDocument(importTrackId, document({ engineer: "Robin Schmidt" }), db());

    const adrift = await tracksAdrift({ db: db(), albumId: seed.albumId });
    expect(adrift).toHaveLength(1);
    expect(adrift[0]?.reason).toBe("document");
  });

  /* ---- 2 · a write that changes nothing queues nothing ---- */

  it("writing an identical document queues nothing", async () => {
    const seed = await seedAlbum("P4");
    const importTrackId = seed.importTrackIds[0] ?? "";
    const [before] = await db()
      .select()
      .from(schema.metadataDocuments)
      .where(eq(schema.metadataDocuments.importTrackId, importTrackId))
      .limit(1);

    // The very same document back again — `storeDocument` really does write the row, so this
    // is not "nothing happened", it is "something happened and changed no value a file carries".
    await storeDocument(importTrackId, before?.document as unknown as TrackDocument, db());

    expect(await tracksAdrift({ db: db(), albumId: seed.albumId })).toHaveLength(0);
    expect(await ensureProjection({ db: db(), scope: "album", targetId: seed.albumId })).toBeNull();
    expect(await runsFor(seed.albumId)).toHaveLength(0);
  });

  /* ---- 3 · the catch-up, and its two guards ---- */

  it("opens one adrift run for a re-matched album", async () => {
    const seed = await seedAlbum("P5");
    await reMatch(seed);

    const outcome = await ensureProjection({ db: db(), scope: "album", targetId: seed.albumId });
    expect(outcome).not.toBeNull();
    expect(outcome?.reused).toBe(false);
    expect(outcome?.adrift).toBe(2);

    const runs = await runsFor(seed.albumId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      scope: "album",
      targetId: seed.albumId,
      selection: "adrift",
      dryRun: false,
      total: 2,
    });
  });

  it("a second write lands on the run the first one opened — one album, one run", async () => {
    const seed = await seedAlbum("P6");
    await reMatch(seed);

    const first = await ensureProjection({ db: db(), scope: "album", targetId: seed.albumId });
    // A hand correction on top of the re-match: two acts, two calls, still one run.
    await storeDocument(seed.importTrackIds[0] ?? "", document({ engineer: "Alex Wharton" }), db());
    const second = await ensureProjection({ db: db(), scope: "album", targetId: seed.albumId });

    expect(second?.reused).toBe(true);
    expect(second?.runId).toBe(first?.runId);
    expect(await runsFor(seed.albumId)).toHaveLength(1);
  });

  it("a track-scoped catch-up is promoted to its album, so a bulk edit is still one run", async () => {
    const seed = await seedAlbum("P7");
    await reMatch(seed);

    const outcomes = await Promise.all(
      seed.trackIds.map(
        async (trackId) => await ensureProjection({ db: db(), scope: "track", targetId: trackId }),
      ),
    );
    expect(outcomes.every((outcome) => outcome?.runId === outcomes[0]?.runId)).toBe(true);
    const runs = await runsFor(seed.albumId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.scope).toBe("album");
  });

  it("a re-tag does not queue a re-tag", async () => {
    const seed = await seedAlbum("P8");
    await reMatch(seed);

    /*
     * `withoutProjection` is what `runBatch`, `repairOrphans` and the v1 take-over wrap
     * themselves in. Inside it the invariant is somebody else's job — theirs — so the seam is
     * silent however adrift the album is, and the loop cannot start.
     */
    const inside = await withoutProjection(
      async () => await ensureProjection({ db: db(), scope: "album", targetId: seed.albumId }),
    );
    expect(inside).toBeNull();
    expect(await runsFor(seed.albumId)).toHaveLength(0);

    // And the suppression is scoped to the call, not sticky.
    expect(await ensureProjection({ db: db(), scope: "album", targetId: seed.albumId })).not.toBe(
      null,
    );
  });

  /* ---- 4 · the run really processes what it selected ---- */

  it("a library run over everything reaches every file, instead of filtering them all away", async () => {
    const seed = await seedAlbum("P9");

    /*
     * The second half of the owner's report. `runBatch` used to re-plan with `onlyBehind:
     * false` and then hand the result to a `scopeTargets` that filtered a `library` run back
     * down to the schema version — so `mm retag --all` opened a run over the whole library and
     * processed none of it, reporting `done` with `0/N`.
     *
     * The files are deliberately not on disk: `retagOne` fails each one with `NOT_FOUND`, which
     * is enough to prove it was *reached*. Whether it can then write is the e2e suite's job.
     */
    const run = await createRun({ db: db(), scope: "library", selection: "all" });
    expect(run.total).toBeGreaterThanOrEqual(seed.trackIds.length);

    const result = await runBatch(run.id, { db: db(), batchSize: 100 });
    expect(result.processed).toBe(run.total);
    expect(result.run.done).toBe(run.total);
    expect(result.run.failed).toBe(run.total);
  });

  it("a library run over what is behind the schema still means the schema", async () => {
    await seedAlbum("PA");
    const run = await createRun({ db: db(), scope: "library", selection: "behind" });
    expect(run.total).toBe(0);
    expect(run.status).toBe("done");
  });
});

/** The re-tag runs opened for one album, newest first. */
async function runsFor(albumId: string): Promise<(typeof schema.retagRuns.$inferSelect)[]> {
  return await db().select().from(schema.retagRuns).where(eq(schema.retagRuns.targetId, albumId));
}
