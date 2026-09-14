/**
 * `download`'s three "do not fetch this again" rules, and one of them in particular.
 *
 * The third — *this import's own file, already filed* — is the one that closes the resume
 * window `place` leaves between the toolbox's rename and the `library_tracks` row. A worker
 * killed inside that window comes back to a track whose work file is gone, whose
 * `library_tracks` row was never written, and whose only surviving trace is
 * `import_tracks.library_path`, written before the move on purpose. If `download` does not
 * believe that column, the track is downloaded a second time — which is the one thing this
 * app is built never to do, and what `e2e-fixture`'s "no track was downloaded twice" caught.
 *
 * Offline and without a database: the step is handed a context whose `db` answers "no such
 * row" to everything, so the only thing left to decide the outcome is the filesystem.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Import, ImportTrack } from "#/server/db/schema/index.ts";
import { pathMap } from "#/server/paths.ts";
import { defaults } from "#/server/services/settings.ts";
import type { StepContext } from "../context.ts";
import { downloadStep } from "./download.ts";

let library = "";

beforeEach(() => {
  library = mkdtempSync(join(tmpdir(), "mm-download-"));
});

afterEach(() => {
  rmSync(library, { recursive: true, force: true });
});

/** A library file with something in it, at a library-relative path. */
function put(relative: string, bytes = 8): string {
  const absolute = join(library, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, Buffer.alloc(bytes));
  return relative;
}

const FILED = "Daft Punk/Discovery (2001)/01 - One More Time.opus";

function track(overrides: Partial<ImportTrack> = {}): ImportTrack {
  return {
    id: "itr_1",
    importId: "imp_1",
    position: 1,
    videoId: "v1",
    url: "fixture://discovery#1",
    sourceTitle: "Daft Punk - One More Time",
    sourceDuration: 320,
    uploader: null,
    raw: {},
    role: "mapped",
    state: "tagged",
    trackMbid: null,
    recordingMbid: "rec-1",
    trackTitle: "One More Time",
    trackPosition: 1,
    mediumPosition: 1,
    confidence: 1,
    downloadPath: ".mm-work/imp_1/itr_1.opus",
    downloadedBytes: 8,
    fingerprint: null,
    fingerprintDuration: null,
    acoustidMbid: null,
    fingerprintOk: null,
    libraryPath: null,
    attempts: 0,
    error: null,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Run {
  readonly ctx: StepContext;
  /** Every `ctx.say` line, so the journal the resume test counts can be asserted on. */
  readonly said: { type: string; reason: unknown }[];
  /** One entry per `POST /download` the step opened. */
  readonly fetched: string[];
  readonly announced: string[];
  /** Every patch the step wrote to `import_tracks`. */
  readonly wrote: Record<string, unknown>[];
}

/**
 * A context with no database behind it.
 *
 * Both queries `download` can make — the `library_tracks` lookup of `alreadyInLibrary`, and
 * the writes of `updateTrack` and `setTrackState` — are answered with "nothing"; the chainable
 * stub is only as deep as those two call chains, on purpose. Whatever the step decides here it
 * decides from the row it was given and from the filesystem.
 */
function contextFor(rows: ImportTrack[], options: { force?: boolean } = {}): Run {
  const said: { type: string; reason: unknown }[] = [];
  const fetched: string[] = [];
  const announced: string[] = [];

  const wrote: Record<string, unknown>[] = [];
  const nothing = {
    from: () => nothing,
    where: () => nothing,
    set: (patch: Record<string, unknown>) => {
      wrote.push(patch);
      return nothing;
    },
    limit: () => Promise.resolve([]),
    then: (resolve: (value: unknown[]) => unknown) => resolve([]),
  };
  const db = { select: () => nothing, update: () => nothing };

  const toolbox = {
    download: function (request: { id: string }) {
      fetched.push(request.id);
      return (async function* () {
        await Promise.resolve();
        yield { event: "done", path: `/library/.mm-work/imp_1/${request.id}.opus`, bytes: 8 };
      })();
    },
  };

  const ctx = {
    db,
    toolbox,
    settings: defaults(),
    paths: pathMap({ host: library, container: "/library" }),
    fixtures: true,
    job: {
      id: "imp_1",
      options: options.force === true ? { force: true } : {},
    } as Import,
    step: "download" as const,
    signal: undefined,
    trackScope: null,
    say: (type: string, _message: string, given?: { data?: Record<string, unknown> }) => {
      said.push({ type, reason: given?.data?.["reason"] });
      return Promise.resolve();
    },
    tracks: () => Promise.resolve(rows),
    mappedTracks: () => Promise.resolve(rows),
    albumTracks: () => Promise.resolve(rows),
    onTrackDownloaded: (trackId: string) => {
      announced.push(trackId);
      return Promise.resolve();
    },
    // The stub is shaped for the two call chains above and for nothing else; the cast says so,
    // rather than dragging a real Drizzle client and a real toolbox client into a unit test.
  } as unknown as StepContext;

  return { ctx, said, fetched, announced, wrote };
}

describe("download · a track already filed into the library", () => {
  it("is not fetched again, even with no library_tracks row to prove it", async () => {
    const run = contextFor([track({ libraryPath: put(FILED, 139_089) })]);

    const result = await downloadStep(run.ctx);

    expect(run.fetched, "nothing should have been downloaded").toEqual([]);
    expect(result.data).toMatchObject({ downloaded: 0, reused: 0, skipped: 1 });
  });

  it("says “already present”, which is the journal line the resume test counts", async () => {
    const run = contextFor([track({ libraryPath: put(FILED, 139_089) })]);

    await downloadStep(run.ctx);

    expect(run.said).toContainEqual({ type: "track.skipped", reason: "already present" });
    // No `track.done` at `download`: that event is what "downloaded twice" is counted from.
    expect(run.said.map((line) => line.type)).not.toContain("track.done");
  });

  it("is handed on without being touched, so it resumes where it stopped", async () => {
    // The track is `tagged`, not `placed`: it was caught between the rename and the rows.
    // Announcing it is what sends it back to `place`; swallowing it would strand the file.
    // And its state must survive: rewriting `tagged` to `skipped` would lose the only record
    // of how far the track had got, which is what the aggregate step rows are derived from.
    const run = contextFor([track({ libraryPath: put(FILED, 139_089), state: "tagged" })]);

    await downloadStep(run.ctx);

    expect(run.fetched).toEqual([]);
    expect(run.announced).toEqual(["itr_1"]);
    expect(run.wrote, "the row is already right; the step has nothing to correct").toEqual([]);
  });

  it("does not believe a library_path that points at nothing", async () => {
    const run = contextFor([track({ libraryPath: FILED })]);

    await downloadStep(run.ctx);

    expect(run.fetched, "the row lied, so the file has to be fetched").toEqual(["itr_1"]);
  });

  it("does not believe a zero-byte file either", async () => {
    // What a copy that died halfway leaves behind. `existsSync` alone would call it a track.
    const run = contextFor([track({ libraryPath: put(FILED, 0) })]);

    await downloadStep(run.ctx);

    expect(run.fetched).toEqual(["itr_1"]);
  });

  it("does not believe a directory sitting at the destination", async () => {
    mkdirSync(join(library, FILED), { recursive: true });
    const run = contextFor([track({ libraryPath: FILED })]);

    await downloadStep(run.ctx);

    expect(run.fetched).toEqual(["itr_1"]);
  });

  it("is overridden by --force, like every other reason to skip", async () => {
    const run = contextFor([track({ libraryPath: put(FILED, 139_089) })], { force: true });

    await downloadStep(run.ctx);

    expect(run.fetched).toEqual(["itr_1"]);
  });

  it("costs nothing when both the work file and the library file are there", async () => {
    // `place` was asked to skip an existing destination, so the work file was never moved.
    // Either reason spares the track; what matters is that neither opens a download.
    const run = contextFor([track({ libraryPath: put(FILED, 139_089) })]);
    put(".mm-work/imp_1/itr_1.opus", 139_089);

    const result = await downloadStep(run.ctx);

    expect(run.fetched).toEqual([]);
    expect(result.data).toMatchObject({ downloaded: 0 });
  });
});
