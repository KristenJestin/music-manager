/**
 * Integration tests: real Postgres, real toolbox, real files.
 *
 * They skip themselves when the stack is not up, so a bare `vitest run` on a laptop with no
 * Docker stays green — but they are not optional in spirit. The unit tests prove the machine
 * is correct; these prove the *wiring* is, which is where an orchestrator actually breaks:
 * an enum that does not round-trip, a path that means something else inside the container, a
 * step that is not as idempotent as its docstring claims.
 *
 * Everything runs in its own database (`<db>_itest`) and its own corner of the library
 * (`.local/library/.mm-itest`), so a run never disturbs the developer's own data. The library
 * corner has to be *inside* the bind mount, which is exactly why `MM_LIBRARY_ROOT` and
 * `MM_TOOLBOX_LIBRARY_ROOT` are two settings and not one.
 *
 *   docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres toolbox
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-itest");
const LIBRARY_CONTAINER = "/library/.mm-itest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

/**
 * `<this checkout's database>_itest`, not a fixed `mm_itest`.
 *
 * Postgres is shared between every checkout on the machine (`CLAUDE.md`: one server, one
 * database each), so a constant name is a name two agents own at once — and this suite drops
 * and recreates it in `beforeAll`. Deriving it from `DATABASE_URL` gives `mm_itest` in `v2/`,
 * exactly as before, and `mm_<slug>_itest` in a worktree.
 */
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_itest`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

/** The whole suite needs both halves of the stack; ask them before deciding to run. */
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
  console.log(`  (integration tests skipped: ${unavailable})`);
}

/* ------------------------------------------------------------------ */

// The environment has to be right *before* anything reads it: `serverEnv()` is lazy but
// cached, and every service below resolves its database and its paths through it.
process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { and, eq } = await import("drizzle-orm");
const events = await import("./events.ts");
const cache = await import("./cache.ts");
const inbox = await import("./inbox.ts");
const settings = await import("./settings.ts");
const imports = await import("./imports.ts");
const jobs = await import("./jobs/index.ts");
const { optionsFor } = await import("#/server/functions/inbox.ts");

resetServerEnv();

describe.skipIf(unavailable !== null)("the orchestrator against a real stack", () => {
  beforeAll(async () => {
    // A database of our own. Dropped and recreated so a previous failure cannot leak in.
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    // P04: fixtures mode is a pre-filled raw cache, not a branch in `tag`. The recorded
    // responses go in under the keys the real clients use, so the pipeline below takes the
    // production path with the network unplugged — which is the thing worth testing.
    const { seedFixtures } = await import("#/server/integrations/seed-fixtures.ts");
    await seedFixtures();

    rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(LIBRARY_HOST, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- */

  describe("settings", () => {
    it("returns defaults until something is stored, then the stored value", async () => {
      expect((await settings.loadSettings()).sanitizeMode).toBe("windows");
      await settings.setSetting("sanitizeMode", "strict", { setBy: "test" });
      expect((await settings.loadSettings()).sanitizeMode).toBe("strict");
      expect(await settings.getSetting("sanitizeMode")).toBe("strict");
      await settings.unsetSetting("sanitizeMode");
      expect(await settings.getSetting("sanitizeMode")).toBe("windows");
    });

    it("refuses a value the schema rejects rather than storing it", async () => {
      await expect(settings.setSetting("sanitizeMode", "sideways")).rejects.toThrow(/sanitizeMode/);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("cache.getOrFetch", () => {
    it("calls the source once, ever", async () => {
      let calls = 0;
      const fetcher = async (): Promise<{ hello: string }> => {
        calls += 1;
        return await Promise.resolve({ hello: "world" });
      };

      const first = await cache.getOrFetch("test", "k1", fetcher);
      const second = await cache.getOrFetch("test", "k1", fetcher);

      expect(calls).toBe(1);
      expect(first.fresh).toBe(true);
      expect(second.fresh).toBe(false);
      expect(second.data).toEqual({ hello: "world" });
    });

    it("calls it again when asked to refresh, and only then", async () => {
      let calls = 0;
      const fetcher = async (): Promise<number> => {
        calls += 1;
        return await Promise.resolve(calls);
      };
      await cache.getOrFetch("test", "k2", fetcher);
      const refreshed = await cache.getOrFetch("test", "k2", fetcher, { refresh: true });
      expect(calls).toBe(2);
      expect(refreshed.data).toBe(2);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("the journal", () => {
    it("delivers to a live subscriber and replays for a late one", async () => {
      const seen: string[] = [];
      const subscription = await events.subscribe({
        onEvent: (event) => {
          if (event.type === "test.line") seen.push(event.message);
        },
      });

      await events.emit({ type: "test.line", message: "first" });
      await events.emit({ type: "test.line", message: "second" });
      await waitUntil(() => seen.length >= 2, "two events to arrive");
      await subscription.unsubscribe();

      // The rows are the record; a subscriber that was never listening sees the same thing.
      const replayed = (await events.readEvents({ since: 0 })).filter(
        (event) => event.type === "test.line",
      );
      expect(replayed.map((event) => event.message)).toEqual(["first", "second"]);
      expect(seen).toEqual(["first", "second"]);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("the Inbox", () => {
    it("re-opens the item already open for the same subject instead of duplicating it", async () => {
      const first = await inbox.openInboxItem({
        type: "ytdlp_update",
        title: "yt-dlp is behind",
      });
      const again = await inbox.openInboxItem({
        type: "ytdlp_update",
        title: "yt-dlp is behind (still)",
      });
      expect(again.id).toBe(first.id);
      expect(again.title).toBe("yt-dlp is behind (still)");

      const open = await inbox.listInbox({ status: "open", type: "ytdlp_update" });
      expect(open).toHaveLength(1);
    });

    it("logs a decision when an item is answered", async () => {
      const item = await inbox.openInboxItem({ type: "cookies_expiring", title: "Cookies" });
      await inbox.resolveInboxItem(item.id, { resolution: { accepted: true }, decidedBy: "test" });

      const [after] = await db()
        .select()
        .from(schema.inboxItems)
        .where(eq(schema.inboxItems.id, item.id));
      expect(after?.status).toBe("resolved");

      const decisions = await db()
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.inboxItemId, item.id));
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.decidedBy).toBe("test");
    });
  });

  /* ---------------------------------------------------------------- */

  /**
   * A failed job is a question — DRIVE-1 §A3.
   *
   * `job_failed` existed in the vocabulary, in `docs/04` § Inbox and in the options test, and
   * nothing ever raised one: `/review` said "Nothing to decide" with two failed jobs on the
   * Jobs page. And the two answers a failure has — run it again, give up — have to *happen*,
   * from the Console and from `/api/v1` and from MCP alike, which is why they are carried out
   * by `resolveInboxItem` rather than by each of the three callers.
   */
  describe("a failed job, in the Inbox", () => {
    async function failOne(): Promise<string> {
      // A fixture URL the toolbox has never heard of: `resolve` fails with a decoded error
      // rather than throwing something shapeless.
      const created = await imports.createFromUrl(`fixture://no-such-fixture-${newSuffix()}`, {
        resolveNow: false,
      });
      const result = await jobs.runStep(created.job.id, "resolve");
      expect(result.status).toBe("failed");
      return created.job.id;
    }

    let suffix = 0;
    function newSuffix(): string {
      suffix += 1;
      return String(suffix);
    }

    it("raises one item, carrying the step and the decoded error code", async () => {
      const importId = await failOne();

      const open = await inbox.listInbox({ status: "open", importId, type: "job_failed" });
      expect(open).toHaveLength(1);
      const item = open[0];
      expect(item?.payload["step"]).toBe("resolve");
      expect(typeof item?.payload["code"]).toBe("string");
      expect(item?.title).toContain("resolve");
      // The preselection is the answer that lets the job carry on, like every other card.
      expect(item?.preselected).toMatchObject({ action: "retry" });

      // Idempotent per import: failing again refreshes the question, never adds a second one.
      await jobs.runStep(importId, "resolve");
      expect(await inbox.listInbox({ status: "open", importId, type: "job_failed" })).toHaveLength(
        1,
      );
    });

    it("offers Retry, Cancel and Later rather than “Accept the proposed answer”", async () => {
      const importId = await failOne();
      const [item] = await inbox.listInbox({ status: "open", importId, type: "job_failed" });
      expect(item).toBeDefined();

      const options = optionsFor(item!);
      expect(options.map((option) => option.id)).toEqual(["retry", "cancel", "later"]);
      expect(options[0]?.preselected).toBe(true);
      expect(options[0]?.value).toMatchObject({ action: "retry", step: "resolve" });
    });

    it("cancels the import when the answer is Cancel — from anywhere, not just the Console", async () => {
      const importId = await failOne();
      const [item] = await inbox.listInbox({ status: "open", importId, type: "job_failed" });

      // `decidedBy: "api"` is what `/api/v1/inbox/{id}/resolve` passes; the effect must be the
      // same one the Console gets, because it is the same function.
      await inbox.resolveInboxItem(item!.id, {
        resolution: { action: "cancel" },
        decidedBy: "api",
      });

      const after = await imports.getImport(importId);
      expect(after?.status).toBe("cancelled");
      // Cancelling a job closes every question it had left, including this one.
      expect(await inbox.listInbox({ status: "open", importId })).toHaveLength(0);
    });

    it("runs the failed step again when the answer is Retry", async () => {
      const importId = await failOne();
      const [item] = await inbox.listInbox({ status: "open", importId, type: "job_failed" });
      const [before] = await db()
        .select()
        .from(schema.jobSteps)
        .where(eq(schema.jobSteps.importId, importId));

      // `decidedBy: "mcp"` is what `resolve_inbox` passes. It answers the same card, through
      // the same function, and the job moves — which is the whole claim.
      await inbox.resolveInboxItem(item!.id, {
        resolution: { action: "retry", step: "resolve" },
        decidedBy: "mcp",
      });

      const [after] = await db()
        .select()
        .from(schema.jobSteps)
        .where(eq(schema.jobSteps.importId, importId));
      expect(after?.attempt).toBe((before?.attempt ?? 0) + 1);

      /*
       * This fixture can only ever fail — the URL names nothing — so the retry fails too, and
       * that is the interesting half: the question comes back rather than the job disappearing
       * quietly into the Jobs list a second time.
       */
      const job = await imports.getImport(importId);
      expect(job?.step).toBe("resolve");
      const reopened = await inbox.listInbox({ status: "open", importId, type: "job_failed" });
      expect(reopened).toHaveLength(1);
      expect(reopened[0]?.id).not.toBe(item!.id);
    }, 60_000);
  });

  /* ---------------------------------------------------------------- */

  describe("the whole pipeline, on the Discovery fixture", () => {
    let importId = "";

    it("resolves fifteen videos as soon as the import is created", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { autoConfirm: true });
      importId = created.job.id;
      expect(created.job.kind).toBe("album");

      const tracks = await db()
        .select()
        .from(schema.importTracks)
        .where(eq(schema.importTracks.importId, importId));
      expect(tracks).toHaveLength(15);
    }, 60_000);

    it("runs the eight steps to done", async () => {
      const outcome = await jobs.runImport(importId);
      expect(outcome.status).toBe("done");

      const steps = await jobs.stepsOf(importId);
      expect(steps).toHaveLength(8);
      for (const { step, row } of steps) {
        expect(["done", "skipped"], `${step}: ${row?.message ?? "no row"}`).toContain(
          row?.status ?? "missing",
        );
      }
    }, 300_000);

    it("maps fourteen videos and flags the fifteenth as extra", async () => {
      const tracks = await db()
        .select()
        .from(schema.importTracks)
        .where(eq(schema.importTracks.importId, importId));
      expect(tracks.filter((track) => track.role === "mapped")).toHaveLength(14);
      expect(tracks.filter((track) => track.role === "extra")).toHaveLength(1);

      const extras = await inbox.listInbox({ importId, type: "extra_videos" });
      expect(extras).toHaveLength(1);
    });

    it("puts the files where packages/domain/paths says", () => {
      expect(existsSync(join(LIBRARY_HOST, "Daft Punk", "Discovery (2001)"))).toBe(true);
      expect(
        existsSync(join(LIBRARY_HOST, "Daft Punk", "Discovery (2001)", "01 - One More Time.opus")),
      ).toBe(true);
      expect(existsSync(join(LIBRARY_HOST, "Daft Punk", "Discovery (2001)", "cover.jpg"))).toBe(
        true,
      );
    });

    it("records the album, the tracks and one document per track", async () => {
      const albums = await db().select().from(schema.libraryAlbums);
      expect(albums).toHaveLength(1);
      expect(albums[0]?.folder).toBe("Daft Punk/Discovery (2001)");

      const tracks = await db().select().from(schema.libraryTracks);
      expect(tracks).toHaveLength(14);
      expect(tracks.every((track) => track.recordingMbid !== null)).toBe(true);

      const documents = await db().select().from(schema.metadataDocuments);
      expect(documents).toHaveLength(14);
      expect(documents.every((doc) => doc.projectionHash !== null)).toBe(true);
      expect(documents.every((doc) => (doc.completeness ?? 0) > 0.8)).toBe(true);
    });

    it("is idempotent: the same import again downloads nothing", async () => {
      const again = await imports.createFromUrl("fixture://discovery", { autoConfirm: true });
      const outcome = await jobs.runImport(again.job.id);
      expect(outcome.status).toBe("done");

      const download = outcome.ran.find((entry) => entry.step === "download");
      expect(download?.result.status).toBe("skipped");
      expect(download?.result.message).toContain("already present");

      // And nothing new appeared on disk.
      const tracks = await db().select().from(schema.libraryTracks);
      expect(tracks).toHaveLength(14);
    }, 300_000);

    /*
     * The regression that made this a priority-one bug: an album that doubled.
     *
     * `pathTemplate` decides the file *name*, and a library track's identity used to be its
     * path — so changing the template and re-importing renamed every file and inserted a
     * second row for every track. The report measured twenty-five rows for a thirteen-track
     * album, thirteen of them pointing at files that no longer existed, and `trackCount`, the
     * completeness score, `relocate` and `verify` each answered differently and wrongly.
     */
    it("does not duplicate a row when the path template changes under it", async () => {
      const before = await db().select().from(schema.libraryTracks);
      expect(before).toHaveLength(14);

      // The same layout with the dash removed: every file of the album gets a new name.
      await settings.setSetting(
        "pathTemplate",
        "{albumArtist}/{album} ({year})/{disc-}{track:02} {title}.{ext}",
        { setBy: "test" },
      );
      try {
        const again = await imports.createFromUrl("fixture://discovery", {
          autoConfirm: true,
          force: true,
        });
        const outcome = await jobs.runImport(again.job.id);
        expect(outcome.status).toBe("done");

        const after = await db().select().from(schema.libraryTracks);
        expect(after).toHaveLength(14);

        // Each row followed its file to the new name rather than leaving a ghost behind.
        expect(after.filter((track) => track.path.includes(" - ")).length).toBe(0);
        const albums = await db().select().from(schema.libraryAlbums);
        expect(albums[0]?.trackCount).toBe(14);

        // And the identity that made that possible is the recording, not the path.
        const mbids = new Set(after.map((track) => track.recordingMbid));
        expect(mbids.size).toBe(14);
      } finally {
        await settings.unsetSetting("pathTemplate");
      }
    }, 300_000);

    /*
     * "Pause on disagreement" has to mean it, even when there is nothing left to measure.
     *
     * `place` clears `downloadPath`, so a `fingerprint` re-run over a placed import found no
     * file to fingerprint, counted zero disagreements and returned `done` — walking straight
     * past its own open questions. That is how the report's import finished `done` with five
     * `fingerprint_mismatch` items still open: "le step est passé sans les attendre".
     */
    it("blocks on an unanswered fingerprint mismatch even with nothing left to measure", async () => {
      await settings.setSetting("verifyFingerprint", true, { setBy: "test" });
      const [track] = await db()
        .select()
        .from(schema.importTracks)
        .where(
          and(eq(schema.importTracks.importId, importId), eq(schema.importTracks.role, "mapped")),
        )
        .limit(1);
      expect(track).toBeDefined();

      // The state the report describes: a placed track (no `downloadPath`), a stored verdict
      // of "disagrees", and a question nobody has answered.
      await db()
        .update(schema.importTracks)
        .set({ fingerprintOk: false })
        .where(eq(schema.importTracks.id, track?.id ?? ""));
      await inbox.openInboxItem(
        {
          type: "fingerprint_mismatch",
          importId,
          trackId: track?.id ?? null,
          title: "Fingerprint disagrees",
          preselected: { action: "accept" },
        },
        db(),
      );

      const blocked = await jobs.runStep(importId, "fingerprint", { db: db() });
      expect(blocked.status).toBe("blocked");
      expect(blocked.blockedAs).toBe("awaiting_review");

      // And answering it is what lets the step through — the same act, over any surface.
      await inbox.resolveInboxBatch(
        { importId, type: "fingerprint_mismatch" },
        { accept: true, decidedBy: "test" },
        db(),
      );
      const through = await jobs.runStep(importId, "fingerprint", { db: db() });
      expect(through.status).toBe("done");
      await settings.unsetSetting("verifyFingerprint");
    }, 120_000);

    it("re-runs a single step without disturbing the rest", async () => {
      const before = await db().select().from(schema.libraryTracks);
      const result = await jobs.runStep(importId, "verify");
      expect(result.status).toBe("done");
      const after = await db().select().from(schema.libraryTracks);
      expect(after).toHaveLength(before.length);
      expect(after.every((track) => track.verifiedAt !== null)).toBe(true);
    }, 60_000);
  });

  /* ---------------------------------------------------------------- */

  describe("confirm blocks without --yes", () => {
    it("parks the job in awaiting_confirm and goes no further", async () => {
      // Fixtures mode confirms automatically, which is the point of it — so this test asks
      // for the one thing that is not automatic: a job that nobody said yes to, with the
      // fixture switch off for this call only.
      process.env["MM_FIXTURES"] = "0";
      resetServerEnv();
      try {
        const created = await imports.createFromUrl("fixture://discovery", { autoConfirm: false });
        const outcome = await jobs.runImport(created.job.id);
        expect(outcome.status).toBe("awaiting_confirm");
        expect(outcome.step).toBe("confirm");

        const steps = await jobs.stepsOf(created.job.id);
        const download = steps.find((entry) => entry.step === "download");
        expect(download?.row).toBeNull();
      } finally {
        process.env["MM_FIXTURES"] = "1";
        resetServerEnv();
      }
    }, 120_000);
  });
});

/** Poll until `predicate` holds. Used only for the LISTEN/NOTIFY round trip. */
async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
