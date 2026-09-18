/**
 * An album with a hole in it, closed — against a real database and a real toolbox.
 *
 * The scenario is the owner's: the source publishes fewer titles than the release has tracks,
 * so one track of the record is covered by no video. Before this existed the album was
 * *permanently* incomplete — `import_tracks` is born from a video, so there was no id to adopt
 * onto, and `adoptTrackFile` answered `ADOPT_NOT_READY` however good the file in your hand was.
 *
 * Four claims, in the order they have to hold:
 *
 *  1. confirming materialises the gap as a real `import_tracks` row, keyed on
 *     `(mediumPosition, trackPosition)`, with no video id and no URL;
 *  2. `download` does not touch it — no fetch is attempted, the track is not failed, and the
 *     step does not fail;
 *  3. the import **settles** rather than hanging: a sourceless row is terminal, so the three
 *     pipelined step rows can reach `done` over the tracks that do have files;
 *  4. the row is adoptable, by exactly the same call as any other track, and once adopted it
 *     is an ordinary track — `downloaded`, then tagged and filed.
 *
 * `?gap=n` is the toolbox fixture that takes one entry out of a listing and reports it in
 * `ExtractResult.unreadable`, which is what a live extraction does when one video of a playlist
 * cannot be read (`AGENTS.md` § Toolbox). It is therefore the real shape of this problem, not a
 * simulation of it. No network.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-sourceless");
const LIBRARY_CONTAINER = "/library/.mm-sourceless";
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
const TEST_DB = `${BASE_DB}_sourceless`;
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
  console.log(`  (sourceless tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { and, eq, isNull } = await import("drizzle-orm");
const { MMError } = await import("@mm/contracts");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const imports = await import("./imports.ts");
const jobs = await import("./jobs/index.ts");
const { adoptTrackFile } = await import("./adopt.ts");
const { materialiseSourcelessTracks, sourcelessTracksOf } = await import("./sourceless.ts");
const { aggregateStatus, isTrackTerminal } = await import("./jobs/machine.ts");
const { nextStepOfTrack } = await import("./jobs/pipeline.ts");

resetServerEnv();

/**
 * Adopt, waiting out the single download slot the way the product tells a caller to.
 *
 * `adoptTrackFile` answers `LOCKED` rather than blocking when something else holds the slot —
 * every caller of it is interactive, and "try again shortly" beats a request held open for
 * minutes. The whole vitest run shares **one** toolbox, so the other integration suites are
 * downloading while this one is, and a test that ignored that advice would fail for the one
 * reason the product explicitly says is not a failure.
 *
 * Bounded, and not a flake mask: a `LOCKED` here *is* the documented contract, and this is the
 * test being the caller that obeys it.
 */
async function adoptWhenSlotFree(
  options: Parameters<typeof adoptTrackFile>[0],
): Promise<Awaited<ReturnType<typeof adoptTrackFile>>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await adoptTrackFile(options);
    } catch (error) {
      if (MMError.from(error).code !== "LOCKED" || attempt >= 30) throw error;
      await new Promise((wake) => setTimeout(wake, 1000));
    }
  }
}

describe.skipIf(unavailable !== null)("an album the source did not fully publish", () => {
  let importId = "";

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    const { seedFixtures } = await import("#/server/integrations/seed-fixtures.ts");
    await seedFixtures();

    rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(LIBRARY_HOST, { recursive: true });

    // One entry short of the listing the release expects: the hole this feature is about.
    const created = await imports.createImport("fixture://discovery?gap=3", {
      autoConfirm: true,
      confirmedBy: "test",
      replaygain: false,
      fingerprint: false,
    });
    importId = created.job.id;
    for (const step of ["match", "confirm"] as const) {
      const outcome = await jobs.runStep(importId, step, { db: db() });
      expect(outcome.status, `${step}: ${outcome.message ?? ""}`).not.toBe("failed");
    }
  }, 300_000);

  it("turns the release's uncovered track into a row with no video", async () => {
    const rows = await sourcelessTracksOf(importId, db());
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // The two columns that make it what it is. Nothing was invented to fill them.
      expect(row.videoId).toBeNull();
      expect(row.url).toBeNull();
      expect(row.state).toBe("sourceless");
      // `mapped`, because it is bound to a track of the confirmed release — which is exactly
      // the condition `refuseAdoption` checks before it will accept a file.
      expect(row.role).toBe("mapped");
      // Where it sits on the record. Without these it could not be keyed, displayed or filed.
      expect(row.trackPosition).not.toBeNull();
      expect(row.mediumPosition).not.toBeNull();
      expect(row.sourceTitle).not.toBe("");
      // A distinct listing position, after the real entries, so the unique index holds.
      expect(row.position).toBeGreaterThan(0);
    }
  });

  it("does not collide with the videos, and is idempotent when confirm runs twice", async () => {
    const before = await sourcelessTracksOf(importId, db());

    // A re-run of the same materialisation — which is what a retry, a resume or an Inbox
    // answer that re-queues the job produces — must not double the tracklist.
    const again = await materialiseSourcelessTracks({
      importId,
      cells: before.map((row) => ({
        position: row.trackPosition ?? 0,
        mediumPosition: row.mediumPosition ?? 1,
        title: row.trackTitle,
        recordingMbid: row.recordingMbid,
        lengthSeconds: row.sourceDuration,
      })),
      by: "test",
      db: db(),
    });
    expect(again.created).toHaveLength(0);
    expect(again.existing).toBe(before.length);
    expect(await sourcelessTracksOf(importId, db())).toHaveLength(before.length);

    // And a cell that a *video* already covers is not materialised either: the gap is only a
    // gap where nothing sits at that (medium, track).
    const [covered] = await db()
      .select()
      .from(schema.importTracks)
      .where(
        and(eq(schema.importTracks.importId, importId), eq(schema.importTracks.role, "mapped")),
      )
      .orderBy(schema.importTracks.trackPosition);
    expect(covered?.videoId).not.toBeNull();
    const shouldSkip = await materialiseSourcelessTracks({
      importId,
      cells: [
        {
          position: covered?.trackPosition ?? 1,
          mediumPosition: covered?.mediumPosition ?? 1,
          title: "a track that already has a video",
          recordingMbid: null,
          lengthSeconds: null,
        },
      ],
      db: db(),
    });
    expect(shouldSkip.created).toHaveLength(0);
    expect(shouldSkip.existing).toBe(1);
  });

  it("is never downloaded, and does not fail the download step", async () => {
    const outcome = await jobs.runStep(importId, "download", { db: db() });
    expect(outcome.status, outcome.message ?? "").not.toBe("failed");
    // The step counted them rather than trying them.
    expect((outcome.data as { sourceless?: number }).sourceless).toBeGreaterThan(0);

    for (const row of await sourcelessTracksOf(importId, db())) {
      // Untouched: not attempted, not failed, no file, still waiting for a person.
      expect(row.state).toBe("sourceless");
      expect(row.error).toBeNull();
      expect(row.attempts).toBe(0);
      expect(row.downloadPath).toBeNull();
    }
  }, 300_000);

  it("is terminal, so the pipelined steps can finish and the import can settle", () => {
    // The property the whole design turns on. Were it non-terminal, `aggregateStatus` would
    // never see `done === total`, the `fingerprint` and `place` rows would stay `running`, and
    // an album with one gap would sit unfinished for ever.
    expect(isTrackTerminal("sourceless")).toBe(true);

    const withGap = [
      { state: "placed" as const },
      { state: "placed" as const },
      { state: "sourceless" as const },
    ];
    const aggregate = aggregateStatus(withGap, "place");
    expect(aggregate.status).toBe("done");
    // Out of the denominator: two tracks had work to do and both are done.
    expect(aggregate.total).toBe(2);
    expect(aggregate.done).toBe(2);
  });

  it("accepts a file, by the same call as any other track — which is the whole point", async () => {
    const [row] = await sourcelessTracksOf(importId, db());
    expect(row).toBeDefined();
    const trackId = row?.id ?? "";

    /*
     * This exact call is what used to answer `ADOPT_NOT_READY` — "this video is not bound to a
     * track" — with no id to pass in the first place. Nothing about `adoptTrackFile` was
     * changed to make it work; the row simply exists now and satisfies the conditions it
     * always checked.
     */
    const result = await adoptWhenSlotFree({
      importId,
      trackId,
      source: { kind: "url", url: "fixture://skinny-love" },
      adoptedBy: "test",
      db: db(),
      queue: false,
    });

    expect(result.via).toBe("url");
    expect(result.path).toBe(`.mm-work/${importId}/${trackId}.opus`);
    expect(existsSync(join(LIBRARY_HOST, ".mm-work", importId, `${trackId}.opus`))).toBe(true);

    const [after] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, trackId));
    // From here it is an ordinary track, and nothing downstream can tell the difference.
    expect(after?.state).toBe("downloaded");
    expect(after?.downloadPath).toBe(result.path);
    // It still has no video, because it never had one — the audio came from elsewhere and
    // the row never pretended otherwise.
    expect(after?.videoId).toBeNull();
    expect(after?.url).toBeNull();
  }, 300_000);

  it("rejoins the pipeline at the same step any other adopted track would", async () => {
    /*
     * The end of the claim, stated as the pipeline states it.
     *
     * Running `tag` and `place` here would prove something else: this import matched a
     * release whose MusicBrainz document is not in the offline cache (the `?gap=` listing
     * leads the matcher to a different edition from the recorded one), so `tag` would fail on
     * a missing cassette rather than on anything to do with sourceless rows. That a *adopted*
     * track reaches `place` and gets a truthful COMMENT is already proven end to end in
     * `adopt.integration.test.ts`, with the same `adoptTrackFile` and the same work path.
     *
     * What belongs here is the join: once adopted, this row is indistinguishable from a track
     * that was downloaded, and the machine that routes work agrees.
     */
    // The adopted one specifically: `download` ran earlier in this file, so the other
    // `downloaded` rows are ordinary videos. `video_id is null` is what singles ours out —
    // and is itself the point, since the row kept its honesty about having had no source.
    const [row] = await db()
      .select()
      .from(schema.importTracks)
      .where(
        and(
          eq(schema.importTracks.importId, importId),
          eq(schema.importTracks.state, "downloaded"),
          isNull(schema.importTracks.videoId),
        ),
      )
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.videoId).toBeNull();

    // No longer terminal, and owed exactly the work a downloaded video is owed.
    expect(isTrackTerminal(row?.state ?? "sourceless")).toBe(false);
    // `fingerprint` — the step after `download` — which is precisely what `adoptTrackFile`
    // reports as `nextStep` for a track it gave a file to, sourceless or not.
    expect(await nextStepOfTrack(db(), row?.id ?? "")).toBe("fingerprint");

    // And it is now counted: it left the set `aggregateStatus` excludes, so the album's
    // denominator grew by one the moment it got a source.
    const states = (
      await db()
        .select({ state: schema.importTracks.state })
        .from(schema.importTracks)
        .where(
          and(eq(schema.importTracks.importId, importId), eq(schema.importTracks.role, "mapped")),
        )
    ).map((held) => ({ state: held.state }));
    expect(states.some((held) => held.state === "downloaded")).toBe(true);
    expect(aggregateStatus(states, "tag").total).toBe(
      states.filter((held) => held.state !== "skipped" && held.state !== "sourceless").length,
    );
  }, 300_000);
});
