/**
 * The loop the owner hit, against a real Postgres: dismiss, scan, scan again.
 *
 * Eleven legitimate duplicates — one recording on *Ceremonials* and on the compilation *Under
 * Heaven Over Hell* — were answered "keep both copies" one at a time, and the next scan raised
 * all eleven again under new ids. The dismissal had been written on the *item*, and a scan
 * builds new items, so the memory died with the row that held it.
 *
 * Only a database can settle any of this, because the whole claim is about what survives a
 * second run:
 *
 *  1. **a dismissed duplicate never becomes a row again.** Not "is raised and then filtered
 *     on the way out" — `inbox_items` must not grow at all between the second scan and the
 *     third, which is what makes the queue quiet rather than merely pre-answered;
 *  2. **a different pair is still raised.** *Delilah* is the control: same library, same scan,
 *     never dismissed, and it has to keep asking;
 *  3. **an orphan is remembered per path**, so a *new* stray file brings the card back
 *     carrying only itself;
 *  4. **a `verify_mismatch` whose values moved comes back.** Its key holds what was written
 *     and what was read, so "accept what Navidrome reports" is an answer about what Navidrome
 *     reported and not a permanent gag on the album.
 *
 * Skips itself when there is no Postgres, like every `*.integration.test.ts` here. Offline by
 * construction: a temporary directory for the library, no toolbox (`driftLimit: 0` means not
 * one file is probed), no network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import type { InboxType } from "#/server/db/schema/enums.vocab.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_inboxdismissals`;
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
if (unavailable !== null) {
  console.log(`  (inbox dismissal integration tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { and, eq, sql } = await import("drizzle-orm");
const { resetServerEnv } = await import("#/server/env.ts");
const { createDatabase } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { pathMap } = await import("#/server/paths.ts");
const { runScan } = await import("./scan.ts");
const { openLibraryItem } = await import("./library-inbox.ts");
const { resolveInboxItem } = await import("./inbox.ts");
const dismissals = await import("./inbox-dismissals.ts");

resetServerEnv();

/** Two connections, not the client default of ten: this Postgres is shared with other agents. */
const db = createDatabase(TEST_URL, 2);

const SHIP_TO_WRECK = "rec-ship-to-wreck";
const DELILAH = "rec-delilah";

const CEREMONIALS = "Florence + The Machine/Ceremonials (2011)";
const COMPILATION = "Various Artists/Under Heaven Over Hell (2015)";

let root = "";

/** `InboxItem`, without naming the type through a dynamic import that carries no types. */
type InboxRow = typeof schema.inboxItems.$inferSelect;

function write(relative: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x");
}

async function openItems(type: InboxType): Promise<InboxRow[]> {
  return await db
    .select()
    .from(schema.inboxItems)
    .where(and(eq(schema.inboxItems.type, type), eq(schema.inboxItems.status, "open")));
}

async function countItems(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.inboxItems);
  return row?.count ?? 0;
}

async function scan(): Promise<void> {
  await runScan({
    db,
    paths: pathMap({ host: root, container: "/library" }),
    driftLimit: 0,
    trigger: "cli",
  });
}

/** Answer an item the way the Console's preselected button does: "keep both copies". */
async function keepBoth(item: InboxRow): Promise<void> {
  await resolveInboxItem(
    item.id,
    { resolution: { action: "keep_all", accepted: true }, decidedBy: "user" },
    db,
  );
}

beforeAll(async () => {
  if (unavailable !== null) return;

  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`drop database if exists "${TEST_DB}" with (force)`);
  await admin.unsafe(`create database "${TEST_DB}"`);
  await admin.end();

  const client = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  await migrate(drizzle(client), { migrationsFolder: resolve(REPO_ROOT, "apps/web/drizzle") });
  await client.end();

  root = mkdtempSync(join(tmpdir(), "mm-dismissals-"));

  /*
   * Two albums, two recordings, four files: exactly the shape of the owner's library. Each
   * recording is on the studio album and on the compilation, which is legitimate and is what
   * the scan keeps asking about.
   */
  await db.insert(schema.libraryAlbums).values([
    {
      id: "alb_ceremonials",
      albumArtist: "Florence + The Machine",
      title: "Ceremonials",
      folder: CEREMONIALS,
      trackCount: 2,
      presentCount: 2,
      trackCountSource: "release",
    },
    {
      id: "alb_compilation",
      albumArtist: "Various Artists",
      title: "Under Heaven Over Hell",
      folder: COMPILATION,
      trackCount: 2,
      presentCount: 2,
      trackCountSource: "release",
    },
  ]);

  const tracks: (typeof schema.libraryTracks.$inferInsert)[] = [
    {
      id: "trk_ship_album",
      albumId: "alb_ceremonials",
      recordingMbid: SHIP_TO_WRECK,
      title: "Ship to Wreck",
      trackNumber: 1,
      path: `${CEREMONIALS}/01 Ship to Wreck.opus`,
    },
    {
      id: "trk_ship_comp",
      albumId: "alb_compilation",
      recordingMbid: SHIP_TO_WRECK,
      title: "Ship to Wreck",
      trackNumber: 7,
      path: `${COMPILATION}/07 Ship to Wreck.opus`,
    },
    {
      id: "trk_delilah_album",
      albumId: "alb_ceremonials",
      recordingMbid: DELILAH,
      title: "Delilah",
      trackNumber: 2,
      path: `${CEREMONIALS}/02 Delilah.opus`,
    },
    {
      id: "trk_delilah_comp",
      albumId: "alb_compilation",
      recordingMbid: DELILAH,
      title: "Delilah",
      trackNumber: 8,
      path: `${COMPILATION}/08 Delilah.opus`,
    },
  ];
  await db.insert(schema.libraryTracks).values(tracks);
  for (const track of tracks) write(track.path);

  // One stray file nothing in the database claims: the orphan question.
  write("Loose/unknown-a.opus");
});

describe.skipIf(unavailable !== null)("the loop the owner hit", () => {
  it("raises both duplicates on the first scan", async () => {
    await scan();
    const raised = await openItems("duplicate_recording");
    expect(raised.map((item) => item.payload["subject"]).sort()).toEqual([
      `recording:${DELILAH}`,
      `recording:${SHIP_TO_WRECK}`,
    ]);
  });

  it("does not raise a dismissed duplicate again, twice over", async () => {
    const [ship] = (await openItems("duplicate_recording")).filter(
      (item) => item.payload["subject"] === `recording:${SHIP_TO_WRECK}`,
    );
    expect(ship).toBeDefined();
    await keepBoth(ship!);

    await scan();
    const settled = await countItems();
    await scan();

    // The count is the assertion, not the absence of an *open* item: the bug was new rows
    // under new ids every night, which a status filter would have hidden.
    expect(await countItems()).toBe(settled);

    const open = await openItems("duplicate_recording");
    expect(open.map((item) => item.payload["subject"])).not.toContain(`recording:${SHIP_TO_WRECK}`);
  });

  it("still asks about the pair nobody answered", async () => {
    const open = await openItems("duplicate_recording");
    expect(open.map((item) => item.payload["subject"])).toContain(`recording:${DELILAH}`);
  });

  it("wrote the memory on the pair, not on the recording alone", async () => {
    const { rows } = await dismissals.listInboxDismissals({ type: "duplicate_recording" }, db);
    expect(rows.map((row) => row.subject)).toEqual([
      dismissals.duplicateSubject(SHIP_TO_WRECK, ["alb_ceremonials", "alb_compilation"]),
    ]);
  });

  it("asks again about the same recording when a third copy appears", async () => {
    await db.insert(schema.libraryAlbums).values({
      id: "alb_greatest",
      albumArtist: "Florence + The Machine",
      title: "Greatest Hits",
      folder: "Florence + The Machine/Greatest Hits (2020)",
      trackCount: 1,
      presentCount: 1,
      trackCountSource: "release",
    });
    const third = "Florence + The Machine/Greatest Hits (2020)/01 Ship to Wreck.opus";
    await db.insert(schema.libraryTracks).values({
      id: "trk_ship_hits",
      albumId: "alb_greatest",
      recordingMbid: SHIP_TO_WRECK,
      title: "Ship to Wreck",
      trackNumber: 1,
      path: third,
    });
    write(third);

    await scan();
    const open = await openItems("duplicate_recording");
    expect(open.map((item) => item.payload["subject"])).toContain(`recording:${SHIP_TO_WRECK}`);

    // …and the answer that covered two copies is still on file, untouched.
    expect(
      await dismissals.isDismissed(
        dismissals.duplicateSubject(SHIP_TO_WRECK, ["alb_ceremonials", "alb_compilation"]),
        db,
      ),
    ).toBe(true);

    // Put the library back for the tests below.
    await db.delete(schema.libraryTracks).where(eq(schema.libraryTracks.id, "trk_ship_hits"));
    await db.delete(schema.libraryAlbums).where(eq(schema.libraryAlbums.id, "alb_greatest"));
    rmSync(join(root, third));
    await scan();
  });

  it("un-hiding a subject brings the question back on the next scan", async () => {
    const subject = dismissals.duplicateSubject(SHIP_TO_WRECK, [
      "alb_ceremonials",
      "alb_compilation",
    ]);
    expect(await dismissals.forgetInboxDismissal(subject, db)).toBe(true);

    await scan();
    const open = await openItems("duplicate_recording");
    expect(open.map((item) => item.payload["subject"])).toContain(`recording:${SHIP_TO_WRECK}`);

    // Hide it again, so the orphan tests below start from the state the owner left behind.
    const [ship] = open.filter((item) => item.payload["subject"] === `recording:${SHIP_TO_WRECK}`);
    await keepBoth(ship!);
  });
});

describe.skipIf(unavailable !== null)("orphan files, remembered per path", () => {
  it("raises the stray file, and stops once it is answered", async () => {
    await scan();
    const [item] = await openItems("orphan_files");
    expect(item).toBeDefined();
    await resolveInboxItem(
      item!.id,
      { resolution: { action: "keep_all", accepted: true }, decidedBy: "user" },
      db,
    );

    await scan();
    expect(await openItems("orphan_files")).toHaveLength(0);
  });

  it("comes back for a *new* stray file, carrying only that one", async () => {
    write("Loose/unknown-b.opus");
    await scan();

    const [item] = await openItems("orphan_files");
    expect(item).toBeDefined();
    const orphans = item!.payload["orphans"];
    const paths = (Array.isArray(orphans) ? orphans : []).map(
      (orphan) => (orphan as { path: string }).path,
    );
    expect(paths).toEqual(["Loose/unknown-b.opus"]);
    expect(item!.title).toContain("1 file(s)");
  });

  it("keys each path on its own", async () => {
    const { rows } = await dismissals.listInboxDismissals({ type: "orphan_files" }, db);
    expect(rows.map((row) => row.subject)).toEqual([
      dismissals.orphanSubject("Loose/unknown-a.opus"),
    ]);
  });
});

/*
 * `verify_mismatch` is raised by `services/verify.ts` against a live OpenSubsonic server, which
 * an offline test has no business standing up. What is being asserted here is not Navidrome's
 * behaviour but the guard in front of the write — `openLibraryItem` consulting the memory —
 * driven with the very key `raiseOrClearInbox` computes.
 */
describe.skipIf(unavailable !== null)("a verify mismatch whose values moved", () => {
  const album = "alb_ceremonials";
  const first = [{ name: "albumartist", written: "Florence + The Machine", read: "Florence" }];
  const later = [{ name: "albumartist", written: "Florence + The Machine", read: "" }];

  const raise = async (fields: typeof first) =>
    await openLibraryItem(
      {
        type: "verify_mismatch",
        subject: album,
        dismissSubjects: [dismissals.verifyMismatchSubject(album, fields)],
        title: `Ceremonials: ${String(fields.length)} required field(s) read back wrong`,
        payload: { libraryAlbumId: album, fields },
      },
      db,
    );

  it("is silent when the same values are read back again", async () => {
    const item = await raise(first);
    expect(item).not.toBeNull();
    await resolveInboxItem(
      item!.id,
      { resolution: { action: "accept_navidrome", accepted: true }, decidedBy: "user" },
      db,
    );

    expect(await raise(first)).toBeNull();
  });

  it("comes back when what the server reports changes", async () => {
    expect(await raise(later)).not.toBeNull();
  });
});

describe.skipIf(unavailable !== null)("“Later” is not “stop asking”", () => {
  it("leaves no memory behind, so the scan raises the question again", async () => {
    const before = (await dismissals.listInboxDismissals({}, db)).total;
    const [delilah] = (await openItems("duplicate_recording")).filter(
      (item) => item.payload["subject"] === `recording:${DELILAH}`,
    );
    expect(delilah).toBeDefined();
    await resolveInboxItem(
      delilah!.id,
      { resolution: { action: "snooze" }, decidedBy: "user", status: "dismissed" },
      db,
    );

    expect((await dismissals.listInboxDismissals({}, db)).total).toBe(before);

    await scan();
    const open = await openItems("duplicate_recording");
    expect(open.map((item) => item.payload["subject"])).toContain(`recording:${DELILAH}`);
  });
});
