/**
 * Adopting a local file, against a real database and a real toolbox.
 *
 * Two claims, and neither can be made without the stack:
 *
 *  1. **a file that never came from YouTube reaches `place`.** The track is given a file, the
 *     three pipelined steps run, and the album ends up on disk with a document that says the
 *     file was adopted — `COMMENT`, read back out of the placed file with ffprobe, not out of
 *     the row that produced it.
 *  2. **every refusal refuses.** A container the tagger cannot write to, a file that is not
 *     audio, a track that already has a file, an import that has not been confirmed, and a
 *     path outside the allow-list. Each one has its own code because each one has its own fix,
 *     and a test per code is what keeps that true.
 *
 * The allow-list is exercised for real: the source directory is created *outside* the library
 * and outside `adoptSourceRoots` first — so the first attempt is a 403 — and only then added.
 *
 * Needs postgres and this checkout's toolbox in fixtures mode; skips itself without them.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-adopt");
const LIBRARY_CONTAINER = "/library/.mm-adopt";
/** Deliberately not under the library: the allow-list has to be the thing that opens it. */
const OUTSIDE = join(REPO_ROOT, ".local", "mm-adopt-source");
/** The five-second Opus the toolbox's own fixtures use. Real audio, no network. */
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
const TEST_DB = `${BASE_DB}_adopt`;
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
  console.log(`  (adopt tests skipped: ${unavailable})`);
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
const settings = await import("./settings.ts");
const { adoptTrackFile } = await import("./adopt.ts");
const { adoptionOf } = await import("./adopt.record.ts");
const { toolbox } = await import("#/server/toolbox/client.ts");
const { containerPath, pathMap } = await import("#/server/paths.ts");

resetServerEnv();

const paths = pathMap({ host: LIBRARY_HOST, container: LIBRARY_CONTAINER });

/**
 * Adopt, waiting out the single download slot the way the product tells a caller to.
 *
 * `adoptTrackFile` answers `LOCKED` rather than blocking when something else holds the slot,
 * deliberately: every caller of it is interactive, and "try again shortly" beats a request
 * held open for minutes. The whole vitest run shares **one** toolbox, so the other integration
 * suites are downloading while this one is, and a test that did not honour that advice would
 * fail for the one reason the product explicitly says is not a failure.
 *
 * So this is the retry the hint asks for, bounded. It is not papering over a flake: a `LOCKED`
 * here *is* the documented contract, and the test is simply the caller obeying it.
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

/** The code of whatever `run` threw, or `"(no refusal)"` when it did not throw. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "(no refusal)";
  } catch (error) {
    return MMError.from(error).code;
  }
}

describe.skipIf(unavailable !== null)("adopting a local file", () => {
  let importId = "";
  let trackId = "";
  let trackTitle = "";
  /** The second import, whose one taken-over track exercises the replacement address. */
  let urlImportId = "";
  /** The track that address is adopted onto. */
  let urlTrackId = "";
  /** That track's own video URL — the provenance a replacement must *not* overwrite. */
  let urlTrackUrl = "";

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

    for (const dir of [LIBRARY_HOST, OUTSIDE]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
    copyFileSync(SAMPLE, join(OUTSIDE, "03 Digital Love.opus"));
    // A container the tagger cannot write to, and something that is not audio at all.
    copyFileSync(SAMPLE, join(OUTSIDE, "wrong-container.webm"));
    writeFileSync(join(OUTSIDE, "not-really.mp3"), "this is a text file wearing a hat\n");

    // Up to `download`, and no further: the whole point is that the file arrives instead.
    const created = await imports.createImport("fixture://discovery", {
      autoConfirm: true,
      confirmedBy: "test",
      // ReplayGain is an album-wide rsgain pass and this test never completes an album.
      replaygain: false,
    });
    importId = created.job.id;
    for (const step of ["match", "confirm"] as const) {
      const outcome = await jobs.runStep(importId, step, { db: db() });
      expect(outcome.status, `${step}: ${outcome.message ?? ""}`).not.toBe("failed");
    }

    const [first] = await db()
      .select()
      .from(schema.importTracks)
      .where(
        and(eq(schema.importTracks.importId, importId), eq(schema.importTracks.role, "mapped")),
      )
      .orderBy(schema.importTracks.trackPosition);
    expect(first).toBeDefined();
    trackId = first?.id ?? "";
    trackTitle = first?.sourceTitle ?? "";

    /*
     * A second import for the replacement-address half, with **fingerprinting off**.
     *
     * Its own import rather than a second track of the first, for a reason that is itself a
     * fact about the feature: a replacement address is by definition a *different upload*, so
     * its audio does not fingerprint as the recording the track is mapped to, and
     * `fingerprint` correctly answers `blocked` with a mismatch to decide. That is right, and
     * it is what the fixtures reproduce — `fixture://skinny-love` downloaded onto a Discovery
     * track really is the wrong audio.
     *
     * The owner's own `fingerprint: false` is therefore what this half runs under: it is a
     * real per-import option, it is the one an owner replacing a dead video would use, and it
     * lets the track reach `place` so the COMMENT can be read back off a real file. The
     * mismatch behaviour is not being hidden — it is simply a different test's subject.
     */
    const forUrl = await imports.createImport("fixture://discovery", {
      autoConfirm: true,
      confirmedBy: "test",
      replaygain: false,
      fingerprint: false,
    });
    urlImportId = forUrl.job.id;
    for (const step of ["match", "confirm"] as const) {
      const outcome = await jobs.runStep(urlImportId, step, { db: db() });
      expect(outcome.status, `${step}: ${outcome.message ?? ""}`).not.toBe("failed");
    }
    // A *different* track of the record from the one the first half takes over. Both imports
    // are the same fixture album, so track 1 of each would be filed at the same library path
    // and the second `place` would land on the first one's file.
    const forUrlMapped = await db()
      .select()
      .from(schema.importTracks)
      .where(
        and(eq(schema.importTracks.importId, urlImportId), eq(schema.importTracks.role, "mapped")),
      )
      .orderBy(schema.importTracks.trackPosition);
    const target = forUrlMapped[2];
    expect(target).toBeDefined();
    urlTrackId = target?.id ?? "";
    urlTrackUrl = target?.url ?? "";
    await db()
      .update(schema.importTracks)
      .set({
        state: "failed",
        error: { code: "YTDLP_UNAVAILABLE", message: "Video unavailable" },
      })
      .where(eq(schema.importTracks.id, urlTrackId));

    // The state the owner is actually in: this one video will not download.
    await db()
      .update(schema.importTracks)
      .set({
        state: "failed",
        error: { code: "YTDLP_AGE", message: "Sign in to confirm your age" },
      })
      .where(eq(schema.importTracks.id, trackId));
  }, 300_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
    rmSync(OUTSIDE, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------------ */
  /* the refusals                                                        */
  /* ------------------------------------------------------------------ */

  it("refuses a path outside the library and the allow-list", async () => {
    const code = await refusalOf(
      async () =>
        await adoptTrackFile({
          importId,
          trackId,
          source: { kind: "path", path: join(OUTSIDE, "03 Digital Love.opus") },
          adoptedBy: "test",
          db: db(),
          queue: false,
        }),
    );
    expect(code).toBe("ADOPT_PATH_REFUSED");
  });

  it("refuses a path that escapes an allowed root through `..`", async () => {
    await settings.setSetting("adoptSourceRoots", [OUTSIDE], { db: db() });
    const escape = join(OUTSIDE, "..", "..", "package.json");
    const code = await refusalOf(
      async () =>
        await adoptTrackFile({
          importId,
          trackId,
          source: { kind: "path", path: escape },
          adoptedBy: "test",
          db: db(),
          queue: false,
        }),
    );
    expect(code).toBe("ADOPT_PATH_REFUSED");
  });

  it("refuses a container the tagger cannot write to, without copying it", async () => {
    const code = await refusalOf(
      async () =>
        await adoptTrackFile({
          importId,
          trackId,
          source: { kind: "path", path: join(OUTSIDE, "wrong-container.webm") },
          adoptedBy: "test",
          db: db(),
          queue: false,
        }),
    );
    expect(code).toBe("ADOPT_UNSUPPORTED");
    // Refused *before* the copy: nothing of it may be sitting in the work directory.
    expect(existsSync(join(LIBRARY_HOST, ".mm-work", importId, `${trackId}.webm`))).toBe(false);
  });

  it("refuses a file that is not audio, and does not keep it", async () => {
    const code = await refusalOf(
      async () =>
        await adoptTrackFile({
          importId,
          trackId,
          source: { kind: "path", path: join(OUTSIDE, "not-really.mp3") },
          adoptedBy: "test",
          db: db(),
          queue: false,
        }),
    );
    expect(code).toBe("ADOPT_NOT_AUDIO");
    // It had to be copied in to be probed; it must not survive the refusal, or the *next*
    // attempt would fail with `ADOPT_CONFLICT` naming a file nobody accepted.
    expect(existsSync(join(LIBRARY_HOST, ".mm-work", importId, `${trackId}.mp3`))).toBe(false);
  });

  it("refuses an import that has not been confirmed yet", async () => {
    const fresh = await imports.createImport("fixture://skinny-love", { db: db() });
    const [video] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, fresh.job.id))
      .limit(1);
    const code = await refusalOf(
      async () =>
        await adoptTrackFile({
          importId: fresh.job.id,
          trackId: video?.id ?? "",
          source: { kind: "path", path: join(OUTSIDE, "03 Digital Love.opus") },
          adoptedBy: "test",
          db: db(),
          queue: false,
        }),
    );
    expect(code).toBe("ADOPT_NOT_READY");
  });

  /* ------------------------------------------------------------------ */
  /* the happy path                                                      */
  /* ------------------------------------------------------------------ */

  it("puts the file where `download` would have left it, and clears the failure", async () => {
    /*
     * The import has given up, which is what actually happens: one video of fourteen comes back
     * `YTDLP_AGE`, `settleImport` concludes the album `failed`, and from then on `runTrackStep`
     * refuses every message it is sent. Without the re-open this whole feature is a file copied
     * into a directory and nothing else, so the state is set here on purpose.
     */
    await db()
      .update(schema.imports)
      .set({ status: "failed", error: { code: "STEP_FAILED", message: "1 download failed" } })
      .where(eq(schema.imports.id, importId));

    const result = await adoptTrackFile({
      importId,
      trackId,
      source: { kind: "path", path: join(OUTSIDE, "03 Digital Love.opus") },
      adoptedBy: "test",
      db: db(),
      // The worker is not running in this test; the steps are driven by hand below.
      queue: false,
    });

    // The import is back on the line — `runTrackStep` would refuse a `failed` job outright.
    expect(result.reopened).toBe(true);
    const [job] = await db().select().from(schema.imports).where(eq(schema.imports.id, importId));
    expect(job?.status).toBe("running");
    expect(job?.error).toBeNull();

    expect(result.path).toBe(`.mm-work/${importId}/${trackId}.opus`);
    expect(result.codec).toBe("opus");
    expect(result.via).toBe("path");
    expect(result.originalName).toBe("03 Digital Love.opus");
    // The step after `download`, which is the whole point.
    expect(result.nextStep).toBe("fingerprint");
    expect(existsSync(join(LIBRARY_HOST, ".mm-work", importId, `${trackId}.opus`))).toBe(true);

    const [row] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, trackId));
    expect(row?.state).toBe("downloaded");
    expect(row?.downloadPath).toBe(result.path);
    expect(row?.error).toBeNull();
    expect(row?.attempts).toBe(0);

    const adoption = adoptionOf(row?.raw);
    expect(adoption?.originalName).toBe("03 Digital Love.opus");
    expect(adoption?.via).toBe("path");
    expect(adoption?.adoptedBy).toBe("test");
    // The yt-dlp entry is still there: the video is still the track's identity.
    expect((row?.raw as { id?: string }).id).not.toBeUndefined();
  }, 60_000);

  it("refuses a second file for a track that now has one", async () => {
    const code = await refusalOf(
      async () =>
        await adoptTrackFile({
          importId,
          trackId,
          source: { kind: "path", path: join(OUTSIDE, "03 Digital Love.opus") },
          adoptedBy: "test",
          db: db(),
          queue: false,
        }),
    );
    expect(code).toBe("ADOPT_CONFLICT");
  });

  it("carries the track through fingerprint, tag and place", async () => {
    for (const step of ["fingerprint", "tag", "place"] as const) {
      const outcome = await jobs.runTrackStep(importId, trackId, step, { db: db() });
      expect(["done", "skipped"], `${step}: ${outcome.result.message ?? ""}`).toContain(
        outcome.result.status,
      );
    }

    const [row] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, trackId));
    expect(row?.state).toBe("placed");
    expect(row?.libraryPath).not.toBeNull();
    expect(existsSync(join(LIBRARY_HOST, row?.libraryPath ?? "nowhere"))).toBe(true);
    // The work file has left the work directory: `place` is a rename, not a copy.
    expect(existsSync(join(LIBRARY_HOST, ".mm-work", importId, `${trackId}.opus`))).toBe(false);
  }, 300_000);

  it("writes a COMMENT that says the file was adopted, not downloaded", async () => {
    const [row] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, trackId));
    const probe = await toolbox().probe(containerPath(paths, row?.libraryPath ?? ""));
    const tags: Readonly<Record<string, string>> = probe.tags ?? {};
    const comment = tags["COMMENT"] ?? tags["DESCRIPTION"] ?? "";

    expect(comment).toContain("Adopted local file");
    expect(comment).toContain("03 Digital Love.opus");
    expect(comment).toContain("not downloaded from");
    // The one thing it must *not* say, which is what the old resolver said unconditionally.
    expect(comment.startsWith("Source:")).toBe(false);
    // …while the machine-readable identity of the track is untouched: the v1 reconciliation,
    // the library scan and the re-tag all match on it.
    expect(tags["MUSICMANAGER_SOURCEURL"] ?? "").toBe(row?.url ?? "");
    // Nothing of ours encoded this file.
    expect(tags["ENCODEDBY"] ?? "").not.toMatch(/yt-dlp|\d{4}\.\d{2}\.\d{2}/);
    expect(trackTitle).not.toBe("");
  }, 120_000);

  /* ------------------------------------------------------------------ */
  /* the third kind: a replacement address                               */
  /* ------------------------------------------------------------------ */

  /*
   * The case the owner actually has nineteen times over: there is no file anywhere, the video
   * is gone, and the same song is still on YouTube under another upload.
   *
   * `fixture://skinny-love` stands in for that other upload. It is a real round trip through
   * `POST /download` — the toolbox takes its single slot, streams NDJSON, and copies its
   * bundled Opus sample — so what is being tested is the actual download path and not a mock
   * of it. No network: `AGENTS.md` § Testing.
   */
  const REPLACEMENT = "fixture://skinny-love";

  it("refuses a scheme the toolbox must never be handed, before any download", async () => {
    for (const address of ["file:///etc/shadow", "data:audio/opus;base64,AAAA", "/etc/shadow"]) {
      const code = await refusalOf(
        async () =>
          await adoptTrackFile({
            importId: urlImportId,
            trackId: urlTrackId,
            source: { kind: "url", url: address },
            adoptedBy: "test",
            db: db(),
            queue: false,
          }),
      );
      expect(code, address).toBe("INVALID_INPUT");
    }
    // And nothing was staged for any of them: the refusal is before the toolbox is called.
    expect(existsSync(join(LIBRARY_HOST, ".mm-work", urlImportId, `${urlTrackId}.opus`))).toBe(
      false,
    );
  });

  it("downloads from the replacement address into the work path, as a file would have", async () => {
    const result = await adoptWhenSlotFree({
      importId: urlImportId,
      trackId: urlTrackId,
      source: { kind: "url", url: REPLACEMENT },
      adoptedBy: "test",
      db: db(),
      queue: false,
    });

    expect(result.via).toBe("url");
    expect(result.downloadedFrom).toBe(REPLACEMENT);
    // Exactly where a file adopted from disk lands, and exactly what `fileReady` probes for —
    // which is what lets the rest of the pipeline not know the difference.
    expect(result.path).toBe(`.mm-work/${urlImportId}/${urlTrackId}.opus`);
    expect(result.codec).toBe("opus");
    expect(result.nextStep).toBe("fingerprint");
    expect(existsSync(join(LIBRARY_HOST, ".mm-work", urlImportId, `${urlTrackId}.opus`))).toBe(
      true,
    );
    // The staging stem is gone. It exists so a half-finished download is invisible to
    // `fileReady` and to `workPathOf`; leaving one behind would be a file nobody accepted.
    expect(
      existsSync(join(LIBRARY_HOST, ".mm-work", urlImportId, `${urlTrackId}.adopting.opus`)),
    ).toBe(false);

    const [row] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, urlTrackId));
    expect(row?.state).toBe("downloaded");
    expect(row?.downloadPath).toBe(result.path);
    expect(row?.error).toBeNull();
    // **The declared provenance did not move.** This is the claim the whole design rests on.
    expect(row?.url).toBe(urlTrackUrl);

    const adoption = adoptionOf(row?.raw);
    expect(adoption?.via).toBe("url");
    expect(adoption?.url).toBe(REPLACEMENT);
    // The yt-dlp entry of the *original* video is still there, untouched: it is the identity.
    expect((row?.raw as { id?: string }).id).not.toBeUndefined();
  }, 120_000);

  it("refuses a second source for a track the replacement already filled", async () => {
    const code = await refusalOf(
      async () =>
        await adoptTrackFile({
          importId: urlImportId,
          trackId: urlTrackId,
          source: { kind: "url", url: REPLACEMENT },
          adoptedBy: "test",
          db: db(),
          queue: false,
        }),
    );
    expect(code).toBe("ADOPT_CONFLICT");
  });

  it("carries the replaced track through fingerprint, tag and place too", async () => {
    for (const step of ["fingerprint", "tag", "place"] as const) {
      const outcome = await jobs.runTrackStep(urlImportId, urlTrackId, step, { db: db() });
      expect(["done", "skipped"], `${step}: ${outcome.result.message ?? ""}`).toContain(
        outcome.result.status,
      );
    }
    const [row] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, urlTrackId));
    expect(row?.state).toBe("placed");
    expect(existsSync(join(LIBRARY_HOST, row?.libraryPath ?? "nowhere"))).toBe(true);
  }, 300_000);

  it("writes a COMMENT naming the address that gave up the bytes, read back off the file", async () => {
    const [row] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, urlTrackId));
    const probe = await toolbox().probe(containerPath(paths, row?.libraryPath ?? ""));
    const tags: Readonly<Record<string, string>> = probe.tags ?? {};
    const comment = tags["COMMENT"] ?? tags["DESCRIPTION"] ?? "";

    expect(comment).toContain("Downloaded from");
    expect(comment).toContain(REPLACEMENT);
    expect(comment).toContain("unavailable");
    // It was downloaded, so it must not claim to be a file taken off a disk…
    expect(comment).not.toContain("Adopted local file");
    // …and it must not answer to the `Source:` prefix that `repair.ts` reads a video id from.
    expect(comment.startsWith("Source:")).toBe(false);
    // The identity is still the original video, not the address the audio came from.
    expect(tags["MUSICMANAGER_SOURCEURL"] ?? "").toBe(urlTrackUrl);
  }, 120_000);
});
