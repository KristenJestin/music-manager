/**
 * The Jobs page at the size the owner actually runs it.
 *
 * Measured on the production instance: 388 imports, 275 of them cancelled, 46 `running` and
 * only one of those genuinely holding the single download slot. Every defect this spec covers
 * is invisible at the twelve imports the rest of the suite creates, and obvious at four
 * hundred — which is why the rows are seeded rather than imported.
 *
 * **Seeded straight into the database, and cleaned up afterwards.** Sixty cancelled imports
 * through the wizard would take longer than the whole suite, and the pipeline has nothing to
 * do with what is being checked: this is a *presentation* test. The rows are terminal
 * (`cancelled`) or inert (`running`, with no pg-boss message naming them), so the worker
 * running beside the browser never touches them, and `afterAll` deletes exactly the ids this
 * file created — never by pattern across the table, which would take other specs' rows with
 * it.
 */
import postgres from "postgres";
import { expect, test, signIn } from "./helpers.ts";

/** The run's own database, as `scripts/e2e-web.ts` handed it to Playwright. */
const DATABASE_URL = process.env["DATABASE_URL"] ?? "";

/** Enough cancelled rows that page 2 is real: the page holds fifty. */
const CANCELLED = 60;
/** The one that holds the download slot, plus two waiting behind it. */
const RUNNING = 3;

const TAG = `e2ejobs${String(Date.now()).slice(-7)}`;
const cancelledId = (n: number): string => `imp_${TAG}c${String(n).padStart(3, "0")}`;
const runningId = (n: number): string => `imp_${TAG}r${String(n).padStart(3, "0")}`;
/** The import the worker is made to be on. */
const HOLDER = runningId(0);
const HOLDER_TITLE = `Slot holder ${TAG}`;

const seeded = [
  ...Array.from({ length: CANCELLED }, (_, n) => cancelledId(n)),
  ...Array.from({ length: RUNNING }, (_, n) => runningId(n)),
];

async function withDb<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

test.describe("the Jobs list at four hundred imports", () => {
  test.beforeAll(async () => {
    expect(DATABASE_URL, "the runner must pass DATABASE_URL to Playwright").not.toBe("");
    await withDb(async (sql) => {
      /*
       * The cancelled ones never resolved: no title, no artist, a raw playlist URL. That is
       * exactly the row the page used to spend two lines on, and the bulk of what it showed.
       */
      for (let n = 0; n < CANCELLED; n += 1) {
        await sql`
          insert into imports (id, url, kind, status, step, title, artist, created_at, updated_at, finished_at)
          values (
            ${cancelledId(n)},
            ${`https://example.invalid/playlist?list=${TAG}-cancelled-${String(n)}`},
            'playlist', 'cancelled', 'resolve', null, null,
            now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour'
          )`;
      }

      for (let n = 0; n < RUNNING; n += 1) {
        const id = runningId(n);
        await sql`
          insert into imports (id, url, kind, status, step, title, artist, created_at, updated_at, started_at)
          values (
            ${id},
            ${`https://example.invalid/album?list=${TAG}-running-${String(n)}`},
            'album', 'running', 'download',
            ${n === 0 ? HOLDER_TITLE : `Waiting ${TAG} ${String(n)}`},
            ${n === 0 ? "Slot Holder Orchestra" : "Queue Ensemble"},
            now() - interval '30 minutes',
            ${n === 0 ? sql`now()` : sql`now() - interval '20 minutes'`},
            now() - interval '30 minutes'
          )`;
      }

      // Thirteen videos for the holder, three of them already filed: the numbers the card
      // shows, and the ones that stayed at 0/13 for an hour on the owner's instance.
      for (let n = 0; n < 13; n += 1) {
        await sql`
          insert into import_tracks (id, import_id, position, video_id, url, source_title, role, state)
          values (
            ${`itr_${TAG}_${String(n)}`}, ${HOLDER}, ${n + 1},
            ${`vid${String(n)}`}, ${`https://example.invalid/watch?v=${TAG}-${String(n)}`},
            ${`Track ${String(n + 1)}`}, 'mapped', ${n < 3 ? "placed" : "pending"}
          )`;
      }

      /*
       * The slot itself. `job_steps(download, running)` is what `beginStep` writes when the
       * worker picks a job up, and it is the only honest answer to "which of the forty-six
       * running imports is being worked". The other two get a `pending` row, so they are in
       * the line and not on the slot.
       */
      await sql`
        insert into job_steps (id, import_id, step, status, attempt, started_at)
        values (${`jst_${TAG}_slot`}, ${HOLDER}, 'download', 'running', 1, now())`;
      for (let n = 1; n < RUNNING; n += 1) {
        await sql`
          insert into job_steps (id, import_id, step, status, attempt)
          values (${`jst_${TAG}_q${String(n)}`}, ${runningId(n)}, 'download', 'pending', 0)`;
      }
    });
  });

  test.afterAll(async () => {
    // By the exact ids this file inserted. `import_tracks` and `job_steps` cascade.
    await withDb(async (sql) => {
      await sql`delete from imports where id in ${sql(seeded)}`;
    });
  });

  test("lands on Active, and the cancelled rows are not in the way", async ({ page }) => {
    await signIn(page);
    await page.goto("/imports");

    // The chip says which view this is, rather than the colour saying it.
    await expect(page.getByTestId("job-filters-active")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("job-filters-active")).toHaveAttribute("aria-current", "page");

    // Sixty cancelled rows exist and none of them is on this page.
    await expect(page.getByTestId("job-filters-cancelled")).toContainText(/\d+/);
    await expect(page.getByTestId("jobs-table")).not.toContainText(`${TAG}-cancelled-`);

    // What *is* on it: the import being worked, at the top, because it moved most recently.
    await expect(page.getByTestId("jobs-table")).toContainText(HOLDER_TITLE);

    // And the chips count the whole table, not the page: Active is smaller than All.
    const all = Number(
      (await page.getByTestId("job-filters-all").textContent())?.replace(/\D/g, ""),
    );
    const active = Number(
      (await page.getByTestId("job-filters-active").textContent())?.replace(/\D/g, ""),
    );
    expect(all).toBeGreaterThanOrEqual(CANCELLED + RUNNING);
    expect(active).toBeLessThan(all);
  });

  test("Cancelled reaches page 2, and the page survives a reload", async ({ page }) => {
    await signIn(page);
    await page.goto("/imports");
    await page.getByTestId("job-filters-cancelled").click();

    await expect(page.getByTestId("jobs-pager-range")).toContainText("1–50");
    await expect(page.getByTestId("jobs-table")).toContainText(`${TAG}-cancelled-`);

    await page.getByTestId("jobs-pager-next").click();
    await expect(page.getByTestId("jobs-pager-range")).toContainText("51–");
    await expect(page.getByTestId("jobs-pager")).toHaveAttribute("data-page", "1");

    // The page is in the URL, so a reload — or a link sent to someone — lands on page 2.
    await expect(page).toHaveURL(/page=1/);
    await page.reload();
    await expect(page.getByTestId("jobs-pager")).toHaveAttribute("data-page", "1");
    await expect(page.getByTestId("jobs-pager-range")).toContainText("51–");

    // Page 1 is one press back, and the first page disables the back arrow rather than
    // pretending there is a page 0.
    await page.getByTestId("jobs-pager-prev").click();
    await expect(page.getByTestId("jobs-pager")).toHaveAttribute("data-page", "0");
    await expect(page.getByTestId("jobs-pager-prev")).toBeDisabled();
  });

  test("the worker card names the import that holds the slot, and the real queue depth", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/imports");

    const card = page.getByTestId("worker-card");
    await expect(card.getByTestId("worker-current")).toHaveAttribute("data-import-id", HOLDER);
    await expect(card).toContainText(HOLDER_TITLE);
    await expect(card).toContainText("3/13 tracks");
    await expect(card).toContainText("downloading");

    // Two more imports are waiting behind the slot; "0 queued" was the old answer.
    const queued = Number(
      (await card.getByTestId("worker-queued").textContent())
        ?.replace(/^.*·\s*/, "")
        .replace(/\D/g, ""),
    );
    expect(queued).toBeGreaterThanOrEqual(RUNNING - 1);

    // The card is a link to the job it names, which is how the claim is checked rather than
    // taken on trust.
    await card.getByTestId("worker-current").click();
    await expect(page).toHaveURL(new RegExp(`/imports/${HOLDER}`));
  });

  test("a track finishing moves the row, without a reload", async ({ page }) => {
    await signIn(page);
    await page.goto("/imports");

    const row = page.getByTestId("jobs-table").locator("tr", { hasText: HOLDER_TITLE });
    await expect(row.getByTestId("job-progress")).toContainText("3/13");

    // The stream says so itself rather than the page claiming it: `data-stream` is what the
    // "Live / Reconnecting…" readout is rendered from.
    await expect(page.getByTestId("jobs-live")).toHaveAttribute("data-stream", "live");

    /*
     * A fourth track lands — written exactly the way the orchestrator writes it: the row
     * first, then the `NOTIFY`, because the journal is the record and the notification is only
     * a nudge (`services/events.ts`). No reload, no `router.invalidate()`, no fixture: if the
     * page has not learned this within a few seconds, the live path is broken.
     */
    await withDb(async (sql) => {
      await sql`update import_tracks set state = 'placed' where id = ${`itr_${TAG}_3`}`;
      const [event] = await sql`
        insert into job_events (import_id, track_id, step, level, type, message)
        values (${HOLDER}, ${`itr_${TAG}_3`}, 'download', 'info', 'track.done', 'Track 4: downloaded')
        returning id`;
      await sql`select pg_notify('mm_job_events', ${JSON.stringify({
        id: Number(event?.["id"] ?? 0),
        importId: HOLDER,
      })})`;
    });

    await expect(row.getByTestId("job-progress")).toContainText("4/13", { timeout: 20_000 });
  });
});
