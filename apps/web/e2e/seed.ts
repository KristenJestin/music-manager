/**
 * Rows a browser test needs and no page can create.
 *
 * Everything in `helpers.ts` drives the product: it signs in, pastes a URL, presses buttons.
 * That is the right default and it stays the default. But the review queue's whole problem is
 * its **size** — 307 open items is where the page stops working, and no amount of clicking
 * produces three hundred imports in a suite that runs one download at a time. So this writes
 * `inbox_items` directly, through the same `postgres` driver the app uses, against the
 * database `scripts/e2e-web.ts` created for this run and handed to Playwright in `DATABASE_URL`.
 *
 * Two rules keep that from becoming a habit:
 *
 *  - **only rows nothing else reads.** The seeded items carry a recognisable id prefix and are
 *    deleted again in `afterAll`, so the specs that follow — the suite is serial and runs in
 *    file-name order — see the queue they would have seen;
 *  - **never a shortcut around a page.** What is seeded is the *situation*; every assertion
 *    still goes through the Console.
 */
import postgres from "postgres";
import type { JSONValue, Sql } from "postgres";

/** The id prefix every seeded item carries, so cleaning up cannot take anything else. */
export const SEED_PREFIX = "ibx_e2e_seed_";

function connect(): Sql {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is not set. `bun run e2e` hands it to Playwright; running `playwright test` by hand does not.",
    );
  }
  return postgres(url, { max: 1, onnotice: () => undefined });
}

export interface SeededItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly importId?: string | null;
  /** `JSONValue` rather than `Record<string, unknown>`: it is what `sql.json` accepts. */
  readonly payload?: JSONValue;
  readonly preselected?: JSONValue | null;
}

/** Insert the items, oldest first, one minute apart so every sort has something to order. */
export async function seedInbox(items: readonly SeededItem[]): Promise<void> {
  const sql = connect();
  try {
    const base = Date.UTC(2026, 0, 1);
    for (const [index, item] of items.entries()) {
      const at = new Date(base + index * 60_000);
      await sql`
        insert into inbox_items
          (id, type, status, import_id, title, summary, payload, preselected, created_at, updated_at)
        values (
          ${item.id},
          ${item.type}::inbox_type,
          'open',
          ${item.importId ?? null},
          ${item.title},
          ${item.summary ?? null},
          ${sql.json(item.payload ?? {})},
          ${item.preselected === undefined || item.preselected === null ? null : sql.json(item.preselected)},
          ${at},
          ${at}
        )
        on conflict (id) do nothing
      `;
    }
  } finally {
    await sql.end();
  }
}

/** Remove every row this file created, and nothing else. */
export async function clearSeededInbox(): Promise<void> {
  const sql = connect();
  try {
    await sql`delete from decisions where inbox_item_id like ${SEED_PREFIX + "%"}`;
    await sql`delete from inbox_items where id like ${SEED_PREFIX + "%"}`;
  } finally {
    await sql.end();
  }
}

/**
 * Rename an import, so a card that keys off the title can be driven.
 *
 * The fixture playlist is called "Discovery" and carries no edition qualifier, so the button
 * that searches without one has nothing to strip. Renaming the row is the situation — the
 * owner's 30 stuck imports are *called* "… (Expanded Edition)" — and every assertion after it
 * still goes through the page.
 */
export async function setImportTitle(id: string, title: string): Promise<void> {
  const sql = connect();
  try {
    await sql`update imports set title = ${title} where id = ${id}`;
  } finally {
    await sql.end();
  }
}

/** Read one import's row back, for an assertion about what a button wrote. */
export async function readImport(id: string): Promise<{
  status: string;
  releaseMbid: string | null;
  options: Record<string, unknown>;
} | null> {
  const sql = connect();
  try {
    const rows = await sql<
      { status: string; release_mbid: string | null; options: Record<string, unknown> }[]
    >`select status, release_mbid, options from imports where id = ${id}`;
    const row = rows[0];
    return row === undefined
      ? null
      : { status: row.status, releaseMbid: row.release_mbid, options: row.options };
  } finally {
    await sql.end();
  }
}

/** The `decisions` rows of one import — the audit trail a confirmation has to leave. */
export async function readDecisions(
  importId: string,
): Promise<{ kind: string; decidedBy: string; subject: string | null }[]> {
  const sql = connect();
  try {
    const rows = await sql<
      { kind: string; decided_by: string; subject: string | null }[]
    >`select kind, decided_by, subject from decisions where import_id = ${importId}`;
    return rows.map((row) => ({
      kind: row.kind,
      decidedBy: row.decided_by,
      subject: row.subject,
    }));
  } finally {
    await sql.end();
  }
}

/* ------------------------------------------------------------------ */
/* the projection invariant                                            */
/* ------------------------------------------------------------------ */

/**
 * Make an album's files disagree with the database, and undo it.
 *
 * The situation, not a shortcut: these are the two columns `applySupplied` writes when a
 * different edition is confirmed for an album whose files are already placed, and nothing
 * else. The page is then read, and the button pressed, through the Console like everything
 * else here. Swapping two bindings is its own inverse, so the same call restores the album.
 */
export async function swapTrackBindings(albumId: string): Promise<number> {
  const sql = connect();
  try {
    const rows = await sql<{ n: string }[]>`
      with tracks as (
        select it.id, it.import_id, it.track_position, it.track_mbid, it.recording_mbid,
               it.track_title
          from import_tracks it
          join library_tracks lt on lt.import_track_id = it.id
         where lt.album_id = ${albumId} and it.track_position in (1, 2)
      )
      update import_tracks a
         set track_position = b.track_position,
             track_mbid     = b.track_mbid,
             recording_mbid = b.recording_mbid,
             track_title    = b.track_title
        from tracks b
       where a.id in (select id from tracks)
         and a.import_id = b.import_id
         and a.track_position <> b.track_position
      returning a.id::text as n`;
    return rows.length;
  } finally {
    await sql.end();
  }
}

/** The album the Discovery import placed, for a spec that needs one with files on disk. */
export async function firstAlbumId(): Promise<string | null> {
  const sql = connect();
  try {
    const rows = await sql<{ id: string }[]>`
      select a.id
        from library_albums a
        join library_tracks t on t.album_id = a.id
       where t.import_track_id is not null
       group by a.id
      having count(*) >= 2
       limit 1`;
    return rows[0]?.id ?? null;
  } finally {
    await sql.end();
  }
}

/**
 * Empty `inbox_dismissals`.
 *
 * `clearSeededInbox` cannot reach it, and that is the whole point of the table: the memory is
 * keyed on the *subject*, so deleting the row that asked the question is precisely what does
 * not delete the answer. The whole table goes rather than a prefix of it, because the counter
 * on the page counts everything hidden and a spec that asserts on it has to start from a
 * number it knows — and because this runs against `mm_web_e2e_<run>`, a database
 * `scripts/e2e-web.ts` creates for this run alone and drops again after it.
 */
export async function clearInboxDismissals(): Promise<void> {
  const sql = connect();
  try {
    await sql`delete from inbox_dismissals`;
  } finally {
    await sql.end();
  }
}

/** What is hidden right now, so a spec can assert on the memory as well as on the page. */
export async function readDismissals(): Promise<{ subject: string; label: string }[]> {
  const sql = connect();
  try {
    const rows = await sql<{ subject: string; label: string }[]>`
      select subject, label from inbox_dismissals order by subject
    `;
    return rows.map((row) => ({ subject: row.subject, label: row.label }));
  } finally {
    await sql.end();
  }
}
