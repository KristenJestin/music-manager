/**
 * The way out of "MusicBrainz does not know this playlist", answered from the card that says so.
 *
 * Eight of the owner's imports were parked on `ambiguous_release` with nothing to choose
 * between. The escape had existed since P03 — `match` builds the album from the source's own
 * tags when `options.untaggedFallback` is true — but the flag is **off by default for a URL and
 * on for a folder** (`steps/match.ts`, `wantsUntaggedFallback`), and the only three ways to
 * state it were `mm import <url> --untagged`, `options.untaggedFallback` on the API, and a
 * button inside the wizard. His eight came from a batch, so they met none of them, and he
 * concluded the feature did not exist for URLs. It did; the *offer* did not.
 *
 * Only a database settles this, because the claim is about what one answer does to a job:
 *
 *  1. an import of a source MusicBrainz cannot identify **parks**, which is the right default
 *     and is not changed here — filing an album under a title nobody chose is worse;
 *  2. answering the card's new option writes `options.untaggedFallback` on **that** import;
 *  3. and re-runs `match` through the door the card's other two answers already use, so the
 *     same import comes back **untagged instead of parked again** — a mapping with no release,
 *     the source's own order, every track bound.
 *
 * `fixture://watched` is the source, and the choice is deliberate: `cassetteNameOf` finds no
 * recorded MusicBrainz traffic for it, which is the offline shape of "MusicBrainz knows nothing
 * about this record" — `runMatch` says so itself, in the comment above the `gateway === null`
 * branch. The toolbox serves its listing, so `resolve` is real.
 *
 * That branch raises **no Inbox item**, so the card is opened here the way the Console's own
 * specs seed it. That is not a shortcut around the thing under test: `optionsFor` is asked for
 * the answer rather than told it, so a card that stops offering this fails the test.
 *
 * Needs the stack, in fixtures mode:
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-untagged-itest");
const LIBRARY_CONTAINER = "/library/.mm-untagged-itest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_untaggeditest`;
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
  console.log(`  (untagged-offer tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { eq } = await import("drizzle-orm");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const imports = await import("#/server/services/imports.ts");
const jobs = await import("#/server/services/jobs/index.ts");
const { openInboxItem, resolveInboxBatch, resolveInboxItem } = await import("./inbox.ts");
const { optionsFor } = await import("#/server/functions/inbox.ts");

resetServerEnv();

/** A source the toolbox can list and MusicBrainz has nothing recorded for. */
const UNKNOWN_TO_MUSICBRAINZ = "fixture://watched?snapshot=1";

/**
 * An import parked exactly where the owner's eight are: `match` ran and could not identify it.
 *
 * The Inbox item is opened here because the offline "no gateway" branch returns `blocked`
 * without raising one — see the file header. Its payload is the candidateless shape
 * `matchOneAlbum` writes when the search comes back empty, which is what `offersQualifierSearch`
 * and `optionsFor` both key off.
 */
async function parkedImport(): Promise<{
  importId: string;
  card: Awaited<ReturnType<typeof openInboxItem>>;
}> {
  const created = await imports.createImport(UNKNOWN_TO_MUSICBRAINZ, { db: db() });
  const importId = created.job.id;

  const parked = await jobs.runStep(importId, "match", { db: db() });
  expect(parked.status).toBe("blocked");

  const card = await openInboxItem(
    {
      type: "ambiguous_release",
      importId,
      title: "No MusicBrainz release matches this playlist",
      summary: "Searched, and nothing came back.",
      payload: { url: UNKNOWN_TO_MUSICBRAINZ, candidates: [] },
    },
    db(),
  );
  return { importId, card };
}

describe.skipIf(unavailable !== null)("the untagged way out of a candidateless card", () => {
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
  }, 180_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  /**
   * The default, asserted before it is overridden, because it is the half that must not change.
   *
   * A URL MusicBrainz cannot identify parks. If this ever starts passing untagged on its own,
   * the offer below has stopped being an offer and has become a silent decision.
   */
  it("parks a URL MusicBrainz cannot identify, and does not file it untagged by itself", async () => {
    const { importId } = await parkedImport();

    const job = await imports.getImport(importId, db());
    expect(job?.status).toBe("awaiting_review");
    expect(job?.releaseMbid).toBeNull();
    expect((job?.options as Record<string, unknown>)["untaggedFallback"]).toBeUndefined();

    const rows = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, importId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.role === "unmatched")).toBe(true);
  }, 180_000);

  /** The whole of the fix, end to end: the card offers it, and answering it works. */
  it("answering the card sets the flag, re-runs match, and resolves untagged", async () => {
    const { importId, card } = await parkedImport();

    /* ---- the card really carries the answer -------------------------------- */

    const untagged = optionsFor(card).find((option) => option.id === "untagged");
    if (untagged === undefined) {
      throw new Error("the candidateless card no longer offers the untagged import");
    }
    expect(untagged.preselected).toBe(false);

    /* ---- answering it ------------------------------------------------------ */

    const outcome = await resolveInboxItem(
      card.id,
      { resolution: untagged.value, decidedBy: "test" },
      db(),
    );
    expect(outcome.resumed).toBe(true);
    expect(outcome.item.status).toBe("resolved");

    /* ---- the flag is on that import, and nothing else was invented ---------- */

    const job = await imports.getImport(importId, db());
    const options = job?.options as Record<string, unknown>;
    expect(options["untaggedFallback"]).toBe(true);
    // Not a pin, not a supplied mapping, not an album title: only the flag.
    expect(options["releaseMbid"]).toBeUndefined();
    expect(options["mapping"]).toBeUndefined();

    /* ---- and the import came back untagged rather than parked again --------- */

    expect(job?.status).not.toBe("awaiting_review");
    // No MusicBrainz identifier anywhere: that is what "untagged" means in the library.
    expect(job?.releaseMbid).toBeNull();

    const steps = await db()
      .select()
      .from(schema.jobSteps)
      .where(eq(schema.jobSteps.importId, importId));
    expect(steps.find((row) => row.step === "match")?.status).toBe("done");

    const rows = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, importId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.role === "mapped")).toBe(true);
    expect(rows.every((row) => row.recordingMbid === null)).toBe(true);
    // The source's own order, one track per entry: it is what `place` files the album on.
    expect(rows.every((row) => row.trackPosition !== null)).toBe(true);

    /* ---- the question is answered, not asked again -------------------------- */

    const open = await db()
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.importId, importId));
    expect(open.filter((row) => row.type === "ambiguous_release" && row.status === "open")).toEqual(
      [],
    );

    // Logged like every other answer, so "who decided to import this untagged?" has a row.
    const decided = await db()
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.inboxItemId, card.id));
    expect(decided).toHaveLength(1);
    expect(decided[0]?.choice).toMatchObject({ untaggedFallback: true, step: "match" });
  }, 180_000);

  /**
   * The same gesture in batch, which is the form the agent uses and the owner's eight need.
   *
   * `resolveInboxBatch` is the one function behind `POST /api/v1/inbox/resolve` and MCP's
   * `resolve_inbox`, so this is those two surfaces under test rather than a third
   * implementation. Two claims:
   *
   *  - **`accept: true` is not an answer to these cards**, and never was: their preselection is
   *    *cancel*, `{accepted: true}` names no release, and `planResolution` refuses it. That is
   *    exactly what an agent meets today over eight parked albums, and it is asserted here so
   *    the new flag is measured against the thing it replaces;
   *  - **`untaggedFallback: true` answers them all**, one import re-queued per import, and an
   *    item it cannot apply to comes back in `failed` with its import untouched rather than
   *    silently flagged.
   */
  it("answers a whole batch, and refuses the items it does not apply to", async () => {
    const first = await parkedImport();
    const second = await parkedImport();

    /* ---- what an agent meets today ----------------------------------------- */

    const refused = await resolveInboxBatch(
      { itemIds: [first.card.id] },
      { accept: true, decidedBy: "api" },
      db(),
    );
    expect(refused.resolved).toHaveLength(0);
    expect(refused.failed[0]?.message).toMatch(/names no release or recording/);

    /* ---- and what it can say instead --------------------------------------- */

    const answered = await resolveInboxBatch(
      { itemIds: [first.card.id, second.card.id] },
      { accept: true, decidedBy: "api", untaggedFallback: true },
      db(),
    );
    expect(answered.failed).toEqual([]);
    expect(answered.resolved).toHaveLength(2);
    expect([...answered.imports].sort()).toEqual([first.importId, second.importId].sort());

    for (const importId of [first.importId, second.importId]) {
      const job = await imports.getImport(importId, db());
      expect((job?.options as Record<string, unknown>)["untaggedFallback"]).toBe(true);
      expect(job?.status).not.toBe("awaiting_review");
      expect(job?.releaseMbid).toBeNull();
    }

    /* ---- a question this is not an answer to keeps its import untouched ----- */

    const other = await parkedImport();
    const wrongKind = await openInboxItem(
      {
        type: "fingerprint_mismatch",
        importId: other.importId,
        title: "The fingerprint disagrees",
      },
      db(),
    );

    const mixed = await resolveInboxBatch(
      { itemIds: [wrongKind.id] },
      { accept: true, decidedBy: "mcp", untaggedFallback: true },
      db(),
    );
    expect(mixed.resolved).toEqual([]);
    expect(mixed.failed[0]?.message).toMatch(/not an answer to a fingerprint_mismatch/);

    const untouched = await imports.getImport(other.importId, db());
    expect((untouched?.options as Record<string, unknown>)["untaggedFallback"]).toBeUndefined();
    expect(untouched?.status).toBe("awaiting_review");
  }, 240_000);
});
