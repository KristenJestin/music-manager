/**
 * The admission rules against a real Postgres and a real toolbox in fixtures mode.
 *
 * The unit tests next door prove the *verdict* is right. What only a database can prove is the
 * part that actually differs between the three entry paths, because the same verdict has to
 * become three different things:
 *
 *  - a **pasted URL** is refused — the typed error reaches the caller and the job row keeps it;
 *  - an entry **inside a playlist** is skipped — no `import_tracks` row, a journal line saying
 *    which video and why, and the rest of the playlist imported as normal;
 *  - a video a **watched source** found is skipped — the item row carries the sentence, and no
 *    import is opened for it at all.
 *
 * It skips itself when the stack is down, like every other integration suite here:
 *
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { join, resolve, dirname } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MMError } from "@mm/contracts";
import type { ExtractEntry, ExtractResult, ToolboxClient } from "#/server/toolbox/client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-rules-itest");
const LIBRARY_CONTAINER = "/library/.mm-rules-itest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_rules_itest`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

async function stackIsUp(): Promise<string | null> {
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
  console.log(`  (admission-rule integration tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { eq } = await import("drizzle-orm");
const events = await import("./events.ts");
const imports = await import("./imports.ts");
const jobs = await import("./jobs/index.ts");
const settings = await import("./settings.ts");
const tools = await import("./tools.ts");
const watched = await import("./watched-sources.ts");

resetServerEnv();

/**
 * A video with nothing on it: no description, therefore no "Provided to YouTube by" line, and
 * no album tag. `fixture://watched` is exactly that, which is why the refusal cases below use
 * it and the acceptance cases use `fixture://discovery`, whose fifteen entries carry both.
 *
 * `#n` selects one entry, so it has to come last — a query string appended after the fragment
 * would be part of the fragment and the whole three-video listing would come back instead.
 */
const bareOne = (tag: string): string => `fixture://watched?snapshot=1&${tag}#0`;
const BARE_ONE = bareOne("probe");
const BARE_LIST = "fixture://watched?snapshot=1";

function entry(patch: Partial<ExtractEntry>): ExtractEntry {
  return {
    id: "v0",
    title: "A song",
    index: 0,
    duration: 200,
    uploader: "Someone - Topic",
    track: null,
    artist: null,
    album: null,
    release_year: null,
    description: null,
    thumbnails: [],
    webpage_url: null,
    playlist_index: null,
    availability: "public",
    unavailable: false,
    ...patch,
  } as ExtractEntry;
}

/**
 * A toolbox that answers one listing, so a *mixed* playlist can be tested.
 *
 * No recorded fixture has one — they are all uniformly official — and the case that matters
 * most for the playlist path is precisely the mixed one: some entries kept, some skipped, the
 * import carrying on with what is left.
 */
function toolboxAnswering(entries: readonly ExtractEntry[]): ToolboxClient {
  const result: ExtractResult = {
    kind: "playlist",
    title: "Mixed",
    uploader: "Someone - Topic",
    id: "PLmixed",
    entries: [...entries],
  } as ExtractResult;
  return { extract: async () => await Promise.resolve(result) } as unknown as ToolboxClient;
}

/** Set the two rules for one test and put them back afterwards. */
async function withRules<T>(
  rules: { officialUploadsOnly?: boolean; requireAlbum?: boolean },
  body: () => Promise<T>,
): Promise<T> {
  await settings.setSettings(rules, { db: db(), setBy: "test" });
  try {
    return await body();
  } finally {
    await settings.unsetSetting("officialUploadsOnly", db());
    await settings.unsetSetting("requireAlbum", db());
  }
}

describe.skipIf(unavailable !== null)("the admission rules against a real stack", () => {
  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    if (existsSync(LIBRARY_HOST)) rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(LIBRARY_HOST, { recursive: true });
  }, 120_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- */

  describe("off by default", () => {
    it("changes nothing: a bare video still imports", async () => {
      const created = await imports.createImport(bareOne("off=1"), { db: db() });
      expect(created.job.status).not.toBe("failed");
      const rows = await db()
        .select()
        .from(schema.importTracks)
        .where(eq(schema.importTracks.importId, created.job.id));
      expect(rows).toHaveLength(1);
    }, 60_000);

    it("is what the registry says, so an upgrade is a no-op for everybody", async () => {
      const loaded = await settings.loadSettings(db());
      expect(loaded.officialUploadsOnly).toBe(false);
      expect(loaded.requireAlbum).toBe(false);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("a single URL", () => {
    it("is refused, with the typed error naming the rule", async () => {
      await withRules({ officialUploadsOnly: true }, async () => {
        const url = bareOne("single=1");
        await expect(imports.createImport(url, { db: db() })).rejects.toThrow(
          /Provided to YouTube by/,
        );

        // The row is still written and still carries the same code: the refusal is a fact
        // about something that was asked for, and a thrown error alone would lose it.
        const [job] = await db().select().from(schema.imports).where(eq(schema.imports.url, url));
        expect(job?.status).toBe("failed");
        expect(job?.error?.code).toBe("SOURCE_NOT_OFFICIAL");
        expect(job?.error?.hint).toMatch(/Official uploads only/);

        const rows = await db()
          .select()
          .from(schema.importTracks)
          .where(eq(schema.importTracks.importId, job?.id ?? ""));
        expect(rows).toHaveLength(0);
      });
    }, 60_000);

    it("is refused by `requireAlbum` when nothing says which album it is on", async () => {
      await withRules({ requireAlbum: true }, async () => {
        const url = bareOne("album=1");
        const failure = await imports
          .createImport(url, { db: db() })
          .then(() => null)
          .catch((error: unknown) => MMError.from(error));
        expect(failure?.code).toBe("SOURCE_NO_ALBUM");
        expect(failure?.status).toBe(422);
      });
    }, 60_000);

    it("passes both rules when the description carries the line and the album", async () => {
      await withRules({ officialUploadsOnly: true, requireAlbum: true }, async () => {
        const created = await imports.createImport("fixture://skinny-love?rules=1", {
          db: db(),
        });
        expect(created.job.status).not.toBe("failed");
        expect(created.job.kind).toBe("single");
      });
    }, 60_000);
  });

  /* ---------------------------------------------------------------- */

  describe("inside a playlist", () => {
    it("skips the refused entries, keeps the rest, and says why in the journal", async () => {
      await withRules({ officialUploadsOnly: true }, async () => {
        const created = await imports.createImport("fixture://mixed-playlist", {
          db: db(),
          resolveNow: false,
        });
        const since = await events.emit({
          importId: created.job.id,
          type: "test.mark",
          message: "",
        });

        const result = await jobs.runStep(created.job.id, "resolve", {
          db: db(),
          toolbox: toolboxAnswering([
            entry({ id: "ok1", index: 0, album: "Twin", description: "Provided to YouTube by X" }),
            entry({ id: "bad", index: 1, title: "Somebody talking" }),
            entry({ id: "ok2", index: 2, album: "Twin", description: "Provided to YouTube by X" }),
          ]),
        });

        expect(result.status).toBe("done");
        expect(result.message).toMatch(/2 video\(s\).*1 refused/);

        // The refused entry left no row at all. Keeping it as `state: "skipped"` would not
        // have been enough: `match` re-roles whatever rows exist and `download` selects on
        // role rather than on state, so it would have been downloaded in the end.
        const rows = await db()
          .select()
          .from(schema.importTracks)
          .where(eq(schema.importTracks.importId, created.job.id));
        expect(rows.map((row) => row.videoId).sort()).toEqual(["ok1", "ok2"]);

        // …and the positions are the source's own, so video 3 still maps to track 3.
        expect(rows.map((row) => row.position).sort()).toEqual([0, 2]);

        const journal = (await events.readEvents({ since })).filter(
          (event) => event.importId === created.job.id && event.type === "resolve.skipped",
        );
        expect(journal).toHaveLength(1);
        expect(journal[0]?.message).toMatch(/Somebody talking: No “Provided to YouTube by” line/);
        expect(journal[0]?.level).toBe("warn");
      });
    }, 60_000);

    it("never applies `requireAlbum` to an entry inside a playlist", async () => {
      // The playlist is the album. Every entry of `fixture://watched` has a null album tag and
      // no description, and none of them is refused for it.
      await withRules({ requireAlbum: true }, async () => {
        const created = await imports.createImport(`${BARE_LIST}&inplaylist=1`, { db: db() });
        const rows = await db()
          .select()
          .from(schema.importTracks)
          .where(eq(schema.importTracks.importId, created.job.id));
        expect(rows).toHaveLength(3);
      });
    }, 60_000);

    it("fails the step when the rules refuse every entry", async () => {
      await withRules({ officialUploadsOnly: true }, async () => {
        const created = await imports.createImport(`${BARE_LIST}&none=1`, {
          db: db(),
          resolveNow: false,
        });
        const result = await jobs.runStep(created.job.id, "resolve", { db: db() });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("SOURCE_NOT_OFFICIAL");
        expect(result.message).toMatch(/refused by the import rules/);
      });
    }, 60_000);

    it("leaves an official playlist entirely alone", async () => {
      await withRules({ officialUploadsOnly: true }, async () => {
        const created = await imports.createImport("fixture://discovery?rules=1", { db: db() });
        const rows = await db()
          .select()
          .from(schema.importTracks)
          .where(eq(schema.importTracks.importId, created.job.id));
        expect(rows).toHaveLength(15);
      });
    }, 120_000);
  });

  /* ---------------------------------------------------------------- */

  describe("a watched source", () => {
    /**
     * A flat listing of one video, and a full extraction of it that carries nothing.
     *
     * The scan has to make two different calls — `flat: true` to diff the listing, then a full
     * extraction of each genuinely new video, because a flat listing has no description to
     * read — so the stub answers them differently. That second call is the cost the rule pays,
     * and it is the reason the scan asks the question itself rather than letting `resolve`
     * refuse the import a moment later: forty refused videos must not become forty failed jobs.
     */
    function scanningToolbox(patch: Partial<ExtractEntry>): ToolboxClient {
      const listed = entry({
        id: "wsvBARE0001",
        title: "Someone talking",
        webpage_url: "https://www.youtube.com/watch?v=wsvBARE0001",
      });
      return {
        extract: async (_url: string, _jar: unknown, options: { flat?: boolean } = {}) =>
          await Promise.resolve({
            kind: "playlist",
            title: "Bare",
            uploader: null,
            id: "PLbare",
            entries: [options.flat === true ? listed : entry({ ...listed, ...patch })],
          } as ExtractResult),
      } as unknown as ToolboxClient;
    }

    it("skips the video with the reason on the row, and opens no import for it", async () => {
      await withRules({ officialUploadsOnly: true }, async () => {
        const source = await watched.createWatchedSource(
          { url: "fixture://watched?snapshot=1&scan=refused", label: "Refused" },
          { db: db() },
        );
        const report = await watched.scanSource(source.id, {
          db: db(),
          toolbox: scanningToolbox({ description: "just me talking" }),
        });

        expect(report.discovered).toBe(1);
        expect(report.imported).toBe(0);
        expect(report.importIds).toHaveLength(0);
        expect(report.skipped).toBe(1);

        const [item] = await db()
          .select()
          .from(schema.watchedSourceItems)
          .where(eq(schema.watchedSourceItems.sourceId, source.id));
        expect(item?.status).toBe("skipped");
        expect(item?.importId).toBeNull();
        expect(item?.reason).toMatch(/Provided to YouTube by/);
      });
    }, 120_000);

    it("imports the ones that do carry the line", async () => {
      // Every reachable entry of `fixture://watched` resolves to `fixture://skinny-love`, whose
      // description carries both the line and an album — so the rule lets them through, and the
      // scan behaves exactly as it does with the rules off.
      await withRules({ officialUploadsOnly: true, requireAlbum: true }, async () => {
        const source = await watched.createWatchedSource(
          { url: "fixture://watched?snapshot=1&scan=official", label: "Official" },
          { db: db() },
        );
        const report = await watched.scanSource(source.id, { db: db() });
        expect(report.imported).toBe(2);
      });
    }, 180_000);
  });

  /* ---------------------------------------------------------------- */

  describe("asking before importing", () => {
    it("answers “is this source official?” on the dry run, without importing anything", async () => {
      const official = await tools.testUrl("fixture://discovery", { db: db() });
      expect(official.ok).toBe(true);
      expect(official.official).toBe(true);
      expect(official.officialEntries).toBe(official.entries);
      expect(official.sample[0]?.official).toBe(true);
      expect(official.sample[0]?.album).toBe("Discovery");

      const bare = await tools.testUrl(BARE_ONE, { db: db() });
      expect(bare.ok).toBe(true);
      expect(bare.official).toBe(false);
      expect(bare.officialEntries).toBe(0);
      expect(bare.sample[0]?.album).toBeNull();
    }, 60_000);

    it("says whether the rules currently switched on would let it in", async () => {
      const permissive = await tools.testUrl(BARE_ONE, { db: db() });
      expect(permissive.admissible).toBe(true);
      expect(permissive.rules).toEqual({ officialUploadsOnly: false, requireAlbum: false });

      await withRules({ officialUploadsOnly: true }, async () => {
        const strict = await tools.testUrl(BARE_ONE, { db: db() });
        expect(strict.admissible).toBe(false);
        expect(strict.refusedReason).toMatch(/Provided to YouTube by/);
        expect(strict.rules.officialUploadsOnly).toBe(true);
      });
    }, 60_000);
  });
});
