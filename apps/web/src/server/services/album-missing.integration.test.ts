/**
 * The holes in an album, against a real database and a real toolbox.
 *
 * Three claims, and none of them can be made without the stack, because all three are about
 * the agreement between a *release* in the raw cache and *rows* that a real `place` wrote:
 *
 *  1. **the holes are named, on the couple.** An album holding three of a fourteen-track
 *     release reports the other eleven, each at its own `(mediumPosition, trackPosition)`,
 *     with the title and the credit the release gives it.
 *  2. **one hole fills, and only that one.** The missing track is given a file, resumes at
 *     `fingerprint`, is tagged and filed — and when it is, `present_count` moves by exactly
 *     one and the album's other three files are not rewritten.
 *  3. **a slot with no import row is materialised.** A track the playlist never published has
 *     no `import_tracks` row to hang a file on, and `refuseAdoption` would answer
 *     `ADOPT_NOT_READY` — *"this video is not bound to a track"* — for ever. One is created
 *     with no source instead.
 *
 * The situation is built rather than mocked: a real Discovery import is matched and confirmed,
 * three of its tracks are adopted and run through `fingerprint` → `tag` → `place` so that a
 * genuine `library_albums` row exists with genuine `library_tracks` under it, and the album is
 * then *incomplete in the way the owner's albums are incomplete*. Nothing writes the two
 * counter columns by hand; `place` does it, through `recountAlbum`, as it does in production.
 *
 * Offline throughout. The release comes from `seedFixtures()`, the audio is the toolbox's own
 * five-second sample, and `queue: false` keeps the steps in this process instead of needing a
 * worker. Needs postgres and this checkout's toolbox in fixtures mode; skips itself without
 * them, exactly as `adopt.integration.test.ts` does.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-missing");
const LIBRARY_CONTAINER = "/library/.mm-missing";
/** Inside the library, so `adoptRoots` allows it without an `adoptSourceRoots` entry. */
const HELD = join(LIBRARY_HOST, ".mm-held");
const SAMPLE = join(
  REPO_ROOT,
  "services",
  "toolbox",
  "src",
  "toolbox",
  "fixtures",
  "data",
  "sample.opus",
);

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_missing`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

async function stackIsUp(): Promise<string | null> {
  if (!existsSync(SAMPLE)) return "the toolbox's sample.opus is missing";
  try {
    const response = await fetch(`${TOOLBOX_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { ok?: boolean; fixtures?: boolean };
    if (body.ok !== true) return "the toolbox is not healthy";
    if (body.fixtures !== true) return "the toolbox is not in fixtures mode";
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
  console.log(`  (album-missing tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { and, eq } = await import("drizzle-orm");
const { MMError } = await import("@mm/contracts");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const imports = await import("./imports.ts");
const jobs = await import("./jobs/index.ts");
const { adoptTrackFile } = await import("./adopt.ts");
const { adoptLibraryTrack, albumMissingTracks, slotKey } = await import("./album-missing.ts");

resetServerEnv();

/** The code of whatever `run` threw, or `"(no refusal)"` when it did not throw. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "(no refusal)";
  } catch (error) {
    return MMError.from(error).code;
  }
}

/** Adopt the sample onto one import track and carry it to `place`. */
async function fileOneTrack(importId: string, trackId: string): Promise<void> {
  await adoptTrackFile({
    importId,
    trackId,
    source: { kind: "path", path: join(HELD, "held.opus") },
    adoptedBy: "test",
    db: db(),
    queue: false,
  });
  for (const step of ["fingerprint", "tag", "place"] as const) {
    const outcome = await jobs.runTrackStep(importId, trackId, step, { db: db() });
    expect(["done", "skipped"], `${step}: ${outcome.result.message ?? ""}`).toContain(
      outcome.result.status,
    );
  }
}

describe.skipIf(unavailable !== null)("an album with holes in it", () => {
  let importId = "";
  let albumId = "";
  /** The `(medium, position)` of the track this test leaves out of the album on purpose. */
  let gap = { mediumPosition: 1, trackPosition: 0 };
  /** A slot whose `import_tracks` row is deleted, so adopting it has to create one. */
  let unpublished = { mediumPosition: 1, trackPosition: 0 };

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    // The Discovery release, into `source_cache`. Everything after this is offline.
    const { seedFixtures } = await import("#/server/integrations/seed-fixtures.ts");
    await seedFixtures();

    /*
     * The fingerprint safety net off, and only here.
     *
     * Every track in this test is given the *same* five-second sample, because the subject is
     * which slots of a release are filled and not what is in them. One sample cannot match
     * four different recordings, so the net would stop three of the four on a disagreement it
     * is right to raise — an artefact of the fixture, not a fact about album holes.
     * `review.spec.ts` is where the net itself is exercised.
     */
    const settings = await import("./settings.ts");
    await settings.setSettings({ verifyFingerprint: false }, { db: db() });

    rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(HELD, { recursive: true });
    copyFileSync(SAMPLE, join(HELD, "held.opus"));

    const created = await imports.createImport("fixture://discovery", {
      autoConfirm: true,
      confirmedBy: "test",
      // ReplayGain is an album-wide rsgain pass, and this album is deliberately never whole.
      replaygain: false,
    });
    importId = created.job.id;
    for (const step of ["match", "confirm"] as const) {
      const outcome = await jobs.runStep(importId, step, { db: db() });
      // `runStep` answers with a `StepResult` directly; `runTrackStep` wraps one in `.result`.
      expect(outcome.status, `${step}: ${outcome.message ?? ""}`).not.toBe("failed");
    }

    const mapped = await db()
      .select()
      .from(schema.importTracks)
      .where(
        and(eq(schema.importTracks.importId, importId), eq(schema.importTracks.role, "mapped")),
      )
      .orderBy(schema.importTracks.trackPosition);
    expect(mapped.length).toBeGreaterThan(5);

    /*
     * File three of them and leave the rest. Three rather than all-but-one because the claim
     * under test is "which are missing", and an album missing eleven exercises the ordering
     * of the answer as well as its contents — while costing three `place` runs instead of
     * thirteen.
     */
    const [one, two, three, four, five] = mapped;
    for (const track of [one, two, four]) {
      if (track !== undefined) await fileOneTrack(importId, track.id);
    }
    gap = {
      mediumPosition: three?.mediumPosition ?? 1,
      trackPosition: three?.trackPosition ?? 3,
    };

    /*
     * And one slot with no row at all — the *Cars* case, where the playlist simply never
     * published the track. Deleting the row is how that situation is reached from a fixture
     * whose listing is complete; the situation itself is the ordinary one.
     */
    unpublished = {
      mediumPosition: five?.mediumPosition ?? 1,
      trackPosition: five?.trackPosition ?? 5,
    };
    if (five !== undefined) {
      await db().delete(schema.importTracks).where(eq(schema.importTracks.id, five.id));
    }

    const [album] = await db().select().from(schema.libraryAlbums).limit(1);
    expect(album, "three placed tracks made an album").toBeDefined();
    albumId = album?.id ?? "";
  }, 300_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------------ */
  /* naming them                                                         */
  /* ------------------------------------------------------------------ */

  it("counts the release and not the rows, so the album knows it is short", async () => {
    const found = await albumMissingTracks(albumId, { db: db() });
    expect(found.unavailable).toBeNull();
    expect(found.presentCount).toBe(3);
    // The denominator is the release's, which is the whole point of `album-counters.ts`.
    expect(found.trackCount).toBeGreaterThan(3);
    expect(found.missing).toHaveLength(found.trackCount - found.presentCount);
  });

  it("names the track it does not have, at its own couple", async () => {
    const found = await albumMissingTracks(albumId, { db: db() });
    const keys = found.missing.map((track) => slotKey(track.mediumPosition, track.trackPosition));
    expect(keys).toContain(slotKey(gap.mediumPosition, gap.trackPosition));
  });

  it("does not name a track it does have", async () => {
    const found = await albumMissingTracks(albumId, { db: db() });
    const held = await db()
      .select({ disc: schema.libraryTracks.discNumber, n: schema.libraryTracks.trackNumber })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.albumId, albumId));

    const missing = new Set(
      found.missing.map((track) => slotKey(track.mediumPosition, track.trackPosition)),
    );
    // The failure this guards is the one that matters: a false hole invites the owner to
    // download a file he already has, over the top of itself.
    for (const row of held) {
      expect(missing.has(slotKey(row.disc ?? 1, row.n ?? 0)), `${String(row.n)} is on disk`).toBe(
        false,
      );
    }
  });

  it("gives every missing track a title and the release's own credit", async () => {
    const found = await albumMissingTracks(albumId, { db: db() });
    for (const track of found.missing) {
      expect(track.title.length).toBeGreaterThan(0);
      expect(track.title).not.toBe("(untitled)");
      expect(track.trackMbid).not.toBeNull();
    }
  });

  it("returns them in release order", async () => {
    const found = await albumMissingTracks(albumId, { db: db() });
    const order = found.missing.map((track) => track.mediumPosition * 1000 + track.trackPosition);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  /* ------------------------------------------------------------------ */
  /* filling one                                                         */
  /* ------------------------------------------------------------------ */

  it("refuses a position the album is not in fact missing", async () => {
    const held = await db()
      .select({ disc: schema.libraryTracks.discNumber, n: schema.libraryTracks.trackNumber })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.albumId, albumId))
      .limit(1);
    const row = held[0];
    expect(row).toBeDefined();

    const code = await refusalOf(async () =>
      adoptLibraryTrack({
        albumId,
        mediumPosition: row?.disc ?? 1,
        trackPosition: row?.n ?? 1,
        source: { kind: "path", path: join(HELD, "held.opus") },
        adoptedBy: "test",
        db: db(),
        queue: false,
      }),
    );
    expect(code).toBe("ADOPT_CONFLICT");
  });

  it("fills the hole, and the track alone carries on to `place`", async () => {
    const before = await albumMissingTracks(albumId, { db: db() });

    const result = await adoptLibraryTrack({
      albumId,
      mediumPosition: gap.mediumPosition,
      trackPosition: gap.trackPosition,
      source: { kind: "path", path: join(HELD, "held.opus") },
      adoptedBy: "test",
      db: db(),
      queue: false,
    });

    // It found the import row this track already had rather than making a second one.
    expect(result.materialised).toBe(false);
    expect(result.nextStep).toBe("fingerprint");
    expect(result.trackTitle.length).toBeGreaterThan(0);
    // The counters are the album *as it is*, before `place` has run — not a prediction.
    expect(result.counters.presentCount).toBe(before.presentCount);

    for (const step of ["fingerprint", "tag", "place"] as const) {
      const outcome = await jobs.runTrackStep(importId, result.trackId, step, { db: db() });
      expect(["done", "skipped"], `${step}: ${outcome.result.message ?? ""}`).toContain(
        outcome.result.status,
      );
    }

    const after = await albumMissingTracks(albumId, { db: db() });
    // Exactly one: the other holes are untouched, and nothing else was re-filed.
    expect(after.presentCount).toBe(before.presentCount + 1);
    expect(after.missing).toHaveLength(before.missing.length - 1);
    expect(
      after.missing.map((track) => slotKey(track.mediumPosition, track.trackPosition)),
    ).not.toContain(slotKey(gap.mediumPosition, gap.trackPosition));
    // And the denominator did not move, which is what tells a repair from a redefinition.
    expect(after.trackCount).toBe(before.trackCount);
  }, 120_000);

  it("materialises a sourceless row for a track the playlist never published", async () => {
    const result = await adoptLibraryTrack({
      albumId,
      mediumPosition: unpublished.mediumPosition,
      trackPosition: unpublished.trackPosition,
      source: { kind: "path", path: join(HELD, "held.opus") },
      adoptedBy: "test",
      db: db(),
      queue: false,
    });

    expect(result.materialised).toBe(true);

    const [row] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, result.trackId));
    // No video, and `mapped` all the same — which is what `refuseAdoption` has to see, and
    // exactly what it refused before this existed.
    expect(row?.videoId).toBe("");
    expect(row?.role).toBe("mapped");
    expect(row?.trackPosition).toBe(unpublished.trackPosition);

    for (const step of ["fingerprint", "tag", "place"] as const) {
      const outcome = await jobs.runTrackStep(importId, result.trackId, step, { db: db() });
      expect(["done", "skipped"], `${step}: ${outcome.result.message ?? ""}`).toContain(
        outcome.result.status,
      );
    }

    const after = await albumMissingTracks(albumId, { db: db() });
    expect(
      after.missing.map((track) => slotKey(track.mediumPosition, track.trackPosition)),
    ).not.toContain(slotKey(unpublished.mediumPosition, unpublished.trackPosition));
  }, 120_000);
});
