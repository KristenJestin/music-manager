/**
 * The "already in the library" shortcut, and the one thing it must not do.
 *
 * On *Soleil bleu* the title track was spared because the same **recording** existed under
 * another disc of the library; `download` therefore never looked at the 4 MB file waiting for it
 * in `.mm-work`; adopting that file was refused with `ADOPT_CONFLICT: This track already has a
 * file` — a sentence about a file this pipeline had left there itself; and `mm retry --step tag`
 * walked past the row without a word. The album stayed holed until somebody typed an `update`
 * into the database by hand.
 *
 * **A song on a compilation is not a reason to hole the album it came from.** The shortcut now
 * asks its question *within the disc being filed*.
 *
 * The fake database here answers a query by its **bound parameters**, read out of the compiled
 * SQL with `PgDialect` — the same trick `library-filter.sql.test.ts` uses. That is what makes
 * this a test of the bound rather than of the call: an unbounded `where recording_mbid = $1`
 * returns the compilation's row and spares the track, and the first case below fails.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Import, ImportTrack } from "#/server/db/schema/index.ts";
import { pathMap } from "#/server/paths.ts";
import { defaults } from "#/server/services/settings.ts";
import type { StepContext } from "../context.ts";
import { downloadStep } from "./download.ts";

let library = "";

beforeEach(() => {
  library = mkdtempSync(join(tmpdir(), "mm-already-"));
});

afterEach(() => {
  rmSync(library, { recursive: true, force: true });
});

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
    state: "pending",
    trackMbid: null,
    recordingMbid: "rec-1",
    trackTitle: "One More Time",
    trackPosition: 1,
    mediumPosition: 1,
    confidence: 1,
    downloadPath: null,
    downloadedBytes: null,
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

type AlbumRow = Readonly<Record<string, string | null>> & {
  readonly id: string;
  readonly releaseMbid: string | null;
};

type HeldRow = Readonly<Record<string, string | number | null>> & {
  readonly albumId: string;
  readonly recordingMbid: string | null;
  readonly discNumber: number | null;
  readonly path: string;
};

/** The drizzle table name, which is how the fake database tells the two queries apart. */
function tableName(table: unknown): string {
  for (const symbol of Object.getOwnPropertySymbols(table as object)) {
    if (symbol.description === "drizzle:Name") {
      return String((table as Record<symbol, unknown>)[symbol]);
    }
  }
  return "?";
}

/** Every value a bound parameter could be matching, as strings. */
function candidates(row: Readonly<Record<string, unknown>>): string[] {
  return Object.values(row).map((value) => String(value));
}

function contextFor(
  rows: ImportTrack[],
  options: {
    readonly albums?: readonly AlbumRow[];
    readonly held?: readonly HeldRow[];
    readonly releaseMbid?: string | null;
  } = {},
): { ctx: StepContext; fetched: string[]; wrote: Record<string, unknown>[]; said: string[] } {
  const fetched: string[] = [];
  const wrote: Record<string, unknown>[] = [];
  const said: string[] = [];
  const dialect = new PgDialect();
  const albums = options.albums ?? [];
  const held = options.held ?? [];

  const resolve = (table: unknown, where: unknown): unknown[] => {
    const query = dialect.sqlToQuery(where as never);
    const params = query.params.map((value) => String(value));
    if (tableName(table) === "library_albums") {
      return albums.filter((album) => params.every((value) => candidates(album).includes(value)));
    }
    return held.filter((row) => params.every((value) => candidates(row).includes(value)));
  };

  const select = () => ({
    from: (table: unknown) => ({
      where: (where: unknown) => ({
        limit: () => Promise.resolve(resolve(table, where)),
        then: (onFulfilled: (value: unknown[]) => unknown) =>
          Promise.resolve(resolve(table, where)).then(onFulfilled),
      }),
    }),
  });

  const update = () => ({
    set: (patch: Record<string, unknown>) => {
      wrote.push(patch);
      return { where: () => Promise.resolve([]) };
    },
  });

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
    db: { select, update },
    toolbox,
    settings: defaults(),
    paths: pathMap({ host: library, container: "/library" }),
    fixtures: true,
    job: {
      id: "imp_1",
      releaseMbid: options.releaseMbid === undefined ? "rel-1" : options.releaseMbid,
      options: {},
    } as Import,
    step: "download" as const,
    signal: undefined,
    trackScope: null,
    say: (type: string) => {
      said.push(type);
      return Promise.resolve();
    },
    tracks: () => Promise.resolve(rows),
    mappedTracks: () => Promise.resolve(rows),
    albumTracks: () => Promise.resolve(rows),
    onTrackDownloaded: () => Promise.resolve(),
  } as unknown as StepContext;

  return { ctx, fetched, wrote, said };
}

/**
 * The compilation's own copy of the same recording, **with its file really on disk**.
 *
 * The file has to exist or the test proves nothing: `alreadyInLibrary` checks the filesystem
 * before it believes a row, so a path that points at nothing answers "no" whatever the query
 * returned — and the bug this file is about would look fixed on code that still has it. With
 * the file there, the row is a *real* reason to spare the track, and only the bound decides.
 */
function otherAlbum(): HeldRow {
  return {
    albumId: "alb_compilation",
    recordingMbid: "rec-1",
    discNumber: 1,
    path: put("Various/Now That's Music/07 - One More Time.opus"),
  };
}

const DISCOVERY: AlbumRow = { id: "alb_discovery", releaseMbid: "rel-1" };

describe("download · the shortcut is bounded to the disc being filed", () => {
  it("does not spare a track because the same recording is on another album", async () => {
    const run = contextFor([track()], { albums: [DISCOVERY], held: [otherAlbum()] });

    const result = await downloadStep(run.ctx);

    expect(run.fetched, "the file is not on this record, so it has to be fetched").toEqual([
      "itr_1",
    ]);
    expect(result.data).toMatchObject({ skipped: 0 });
  });

  it("does not spare a track because the same recording is on another disc of the record", async () => {
    // The *Soleil bleu* shape: the title track was spared because the same recording existed
    // under another disc, and the album was left with a hole in the middle.
    const run = contextFor([track({ mediumPosition: 1 })], {
      albums: [DISCOVERY],
      held: [{ ...otherAlbum(), albumId: "alb_discovery", discNumber: 2 }],
    });

    await downloadStep(run.ctx);

    expect(run.fetched).toEqual(["itr_1"]);
  });

  it("still spares a track that really is on this disc of this album", async () => {
    // The shortcut has to keep working for the case it was written for: a re-run of the step
    // meets its own earlier work, and downloading it again is the one thing this app is built
    // never to do.
    const run = contextFor([track()], {
      albums: [DISCOVERY],
      held: [{ albumId: "alb_discovery", recordingMbid: "rec-1", discNumber: 1, path: put(FILED) }],
    });

    const result = await downloadStep(run.ctx);

    expect(run.fetched).toEqual([]);
    expect(result.data).toMatchObject({ skipped: 1 });
    expect(run.said).toContain("track.skipped");
  });

  it("does not spare anything when the import has no release to resolve", async () => {
    // An untagged import: there is no album to ask the question of, so the shortcut is off
    // rather than widened to the whole library.
    const run = contextFor([track()], { albums: [], held: [otherAlbum()], releaseMbid: null });

    await downloadStep(run.ctx);

    expect(run.fetched).toEqual(["itr_1"]);
  });

  it("does not spare anything when the album is not in the library yet", async () => {
    const run = contextFor([track()], { albums: [], held: [otherAlbum()] });

    await downloadStep(run.ctx);

    expect(run.fetched).toEqual(["itr_1"]);
  });
});
