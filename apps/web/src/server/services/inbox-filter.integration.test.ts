/**
 * The review queue's filter, sort and paging, against a real Postgres and a queue the size of
 * the owner's.
 *
 * Three claims, and only a database can settle any of them:
 *
 *  1. **the count and the rows agree.** 320 items, a page of 50, seven pages: the number the
 *     pager prints, the number of rows walking the pages actually yields, and the number the
 *     same filter returns unpaged all have to be one number. "The filtered count lies" has been
 *     a bug here twice, both times because a count was computed from a predicate that had
 *     drifted from the list's, so it is asserted by *walking* rather than by trusting
 *     `inboxWhere` to have been used twice;
 *  2. **the per-filter counts describe the right set.** `countInboxByType` lifts the type
 *     predicate and keeps every other one, which is the only way a chip can say "Ambiguous
 *     release 40" while a different chip is the one selected;
 *  3. **the free text runs.** It is three `ilike`s and a cast of an enum to text, under an
 *     `or` inside an `and` — none of which is checked by rendering the SQL, and a missing cast
 *     is a runtime error and nothing else. The escaping matters too: every one of the fourteen
 *     type names contains an underscore, which `like` reads as a wildcard.
 *
 * Skips itself when there is no Postgres, like every `*.integration.test.ts` here. Offline by
 * construction: no toolbox, no network, no files.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import type { InboxType } from "#/server/db/schema/enums.vocab.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_inboxfilter`;
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
if (unavailable !== null) console.log(`  (inbox filter integration tests skipped: ${unavailable})`);

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { countInbox, countInboxByStatus, countInboxByType, listInbox } = await import("./inbox.ts");

resetServerEnv();

/**
 * A queue shaped like the one that broke: 307 open items of which 168 are verification
 * mismatches, and 40 edition decisions drowning underneath them.
 */
const OPEN: Readonly<Record<string, number>> = {
  verify_mismatch: 168,
  ambiguous_release: 40,
  uncovered_tracks: 47,
  extra_videos: 32,
  fingerprint_mismatch: 20,
};
const RESOLVED = 13;
const OPEN_TOTAL = Object.values(OPEN).reduce((sum, n) => sum + n, 0);

const PAGE = 50;

beforeAll(async () => {
  if (unavailable !== null) return;

  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`drop database if exists "${TEST_DB}" with (force)`);
  await admin.unsafe(`create database "${TEST_DB}"`);
  await admin.end();

  const sql = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  await migrate(drizzle(sql), { migrationsFolder: resolve(REPO_ROOT, "apps/web/drizzle") });
  await sql.end();

  const rows: (typeof schema.inboxItems.$inferInsert)[] = [];
  let n = 0;
  const at = (index: number): Date => new Date(Date.UTC(2026, 0, 1) + index * 60_000);

  for (const [type, howMany] of Object.entries(OPEN)) {
    for (let i = 0; i < howMany; i += 1) {
      n += 1;
      rows.push({
        id: `ibx_open_${String(n).padStart(4, "0")}`,
        type: type as InboxType,
        status: "open",
        // Every tenth one mentions an edition, so the free-text search has something to find
        // that the type filter cannot express.
        title:
          i % 10 === 0
            ? `Nothing matches “Album ${String(i)} (Expanded Edition)”`
            : `Question ${String(n)}`,
        summary: i % 10 === 0 ? "The search came back empty." : null,
        payload: {},
        createdAt: at(n),
        updatedAt: at(n),
      });
    }
  }
  for (let i = 0; i < RESOLVED; i += 1) {
    n += 1;
    rows.push({
      id: `ibx_done_${String(n).padStart(4, "0")}`,
      type: "ambiguous_release",
      status: "resolved",
      title: `Answered ${String(i)}`,
      payload: {},
      createdAt: at(n),
      updatedAt: at(n),
    });
  }

  await db().insert(schema.inboxItems).values(rows);
}, 120_000);

describe.skipIf(unavailable !== null)("the review queue's filter", () => {
  it("counts the open items the way the sidebar badge does", async () => {
    expect(await countInbox({ status: "open" })).toBe(OPEN_TOTAL);
    expect(await countInbox({})).toBe(OPEN_TOTAL + RESOLVED);
  });

  it("walks every page of the open queue and lands on the count it printed", async () => {
    const total = await countInbox({ status: "open" });
    const seen = new Set<string>();
    for (let page = 0; page * PAGE < total; page += 1) {
      const rows = await listInbox({ status: "open", limit: PAGE, offset: page * PAGE });
      // No page but the last is short, and no row appears twice: a sort with ties and no
      // tie-breaker shows one row on two pages and hides another, which reads as a miscount.
      expect(rows.length).toBe(Math.min(PAGE, total - page * PAGE));
      for (const row of rows) seen.add(row.id);
    }
    expect(seen.size).toBe(total);
    expect((await listInbox({ status: "open" })).length).toBe(total);
  });

  it("reaches the edition decisions through the type filter, and the count agrees", async () => {
    const filter = { status: "open", type: "ambiguous_release" } as const;
    const total = await countInbox(filter);
    expect(total).toBe(OPEN["ambiguous_release"]);

    const rows = await listInbox({ ...filter, limit: PAGE });
    expect(rows.length).toBe(Math.min(PAGE, total));
    expect(rows.every((row) => row.type === "ambiguous_release")).toBe(true);

    // The whole point of the filter: 40 reachable out of 307, rather than 40 buried under 168.
    expect(total).toBeLessThan(await countInbox({ status: "open" }));
  });

  it("counts every type with the type predicate lifted, and every status with the status one", async () => {
    const byType = await countInboxByType({ status: "open", type: "ambiguous_release" });
    // Selecting one chip must not zero the others — that is the bug this lift exists to stop.
    for (const [type, howMany] of Object.entries(OPEN)) {
      expect(byType[type as InboxType]).toBe(howMany);
    }
    expect(Object.values(byType).reduce((sum, n) => sum + n, 0)).toBe(OPEN_TOTAL);

    const byStatus = await countInboxByStatus({ status: "open" });
    expect(byStatus.open).toBe(OPEN_TOTAL);
    expect(byStatus.resolved).toBe(RESOLVED);
    expect(byStatus.dismissed).toBe(0);
  });

  it("searches what the card shows — the title, the summary and the type", async () => {
    const byTitle = await listInbox({ status: "open", search: "Expanded Edition" });
    expect(byTitle.length).toBeGreaterThan(0);
    expect(byTitle.every((row) => row.title.includes("Expanded Edition"))).toBe(true);
    expect(await countInbox({ status: "open", search: "Expanded Edition" })).toBe(byTitle.length);

    // The badge on every row reads "verify mismatch"; typing the word has to reach those rows.
    expect(await countInbox({ status: "open", search: "verify" })).toBe(OPEN["verify_mismatch"]);

    // Case-insensitive, as `ilike` promises and as anybody typing into a box assumes.
    expect(await countInbox({ status: "open", search: "VERIFY_MISMATCH" })).toBe(
      OPEN["verify_mismatch"],
    );
  });

  it("escapes the wildcards `like` would otherwise read in a type name", async () => {
    // `_` is "any one character" to `like`. Unescaped, `verify_mismatch` would also match
    // `verifyXmismatch`, and — far worse here — a search for `job_failed` would match nothing
    // while looking as if it had worked.
    expect(await countInbox({ status: "open", search: "verify_mismatch" })).toBe(
      OPEN["verify_mismatch"],
    );
    expect(await countInbox({ status: "open", search: "verifyXmismatch" })).toBe(0);
    // A bare `%` is a literal per cent sign, not "everything".
    expect(await countInbox({ status: "open", search: "%" })).toBe(0);
  });

  it("combines the search with the type filter, and the count still agrees with the rows", async () => {
    const filter = {
      status: "open",
      type: "ambiguous_release",
      search: "Expanded Edition",
    } as const;
    const total = await countInbox(filter);
    const rows = await listInbox(filter);
    expect(rows.length).toBe(total);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(OPEN["ambiguous_release"] ?? 0);

    // And the chips, computed from the same narrowed set minus the type predicate.
    const byType = await countInboxByType(filter);
    expect(byType.ambiguous_release).toBe(total);
    expect(Object.values(byType).reduce((sum, n) => sum + n, 0)).toBe(
      await countInbox({ status: "open", search: "Expanded Edition" }),
    );
  });

  it("sorts four ways, and every one of them is stable enough to page", async () => {
    const newest = await listInbox({ status: "open", sort: "recent", limit: 5 });
    const oldest = await listInbox({ status: "open", sort: "oldest", limit: 5 });
    expect(newest[0]?.id).not.toBe(oldest[0]?.id);
    expect(newest[0]?.createdAt.getTime()).toBeGreaterThan(
      oldest[0]?.createdAt.getTime() ?? Infinity,
    );

    // Oldest first is the one that matters at three hundred items: the questions that have
    // waited longest are the ones holding up imports, and newest-first buries them.
    const all = await listInbox({ status: "open", sort: "oldest" });
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i]?.createdAt.getTime()).toBeGreaterThanOrEqual(
        all[i - 1]?.createdAt.getTime() ?? 0,
      );
    }

    const byType = await listInbox({ status: "open", sort: "type" });
    const types = byType.map((row) => row.type);
    expect([...types].sort((a, b) => a.localeCompare(b))).toEqual(types);

    /*
     * By title, asserted by *which* rows come first rather than by re-sorting them in
     * JavaScript. Postgres orders under its own collation — which ignores spaces and
     * punctuation at the primary level, so "Album 10" sorts before "Album 100" where a
     * codepoint comparison in JS puts them the other way round. Re-deriving the expected order
     * here would be asserting that Node and Postgres collate identically, which they do not
     * and need not.
     */
    const byTitle = await listInbox({ status: "open", sort: "title", limit: 20 });
    expect(byTitle.every((row) => row.title.startsWith("Nothing matches"))).toBe(true);
    expect(byTitle[0]?.id).not.toBe(newest[0]?.id);
  });

  it("pages a sort other than the default without losing or repeating a row", async () => {
    const total = await countInbox({ status: "open", sort: "type" });
    const seen: string[] = [];
    for (let page = 0; page * PAGE < total; page += 1) {
      const rows = await listInbox({
        status: "open",
        sort: "type",
        limit: PAGE,
        offset: page * PAGE,
      });
      seen.push(...rows.map((row) => row.id));
    }
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
  });
});
