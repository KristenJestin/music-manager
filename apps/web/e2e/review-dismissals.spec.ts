import { expect, test, signIn } from "./helpers.ts";
import {
  clearInboxDismissals,
  clearSeededInbox,
  readDismissals,
  seedInbox,
  SEED_PREFIX,
} from "./seed.ts";

/**
 * "Stop asking about this" — and the way back from it — through the Console alone.
 *
 * The owner dismissed eleven legitimate duplicates one at a time and the next scan raised all
 * eleven again. The fix keeps the answer in `inbox_dismissals`, keyed on the subject rather
 * than on the row, which creates the second problem this spec is really about: a memory
 * nobody can see is a memory nobody can correct. So the page has to **list** what has been
 * hidden and **take it back**, the way Discover's "N suggestion(s) hidden for good · Show them
 * again" does.
 *
 * Two duplicates are seeded rather than scanned, for the reason `seed.ts` gives: the situation
 * is a library holding one recording twice on two albums, and no amount of clicking produces
 * one in a suite with a single download slot. Every assertion after that goes through the
 * Console — the card is answered by pressing its own preselected button, and the un-hiding is
 * a button on the page, not a database write.
 */

const SHIP = `${SEED_PREFIX}dup_ship`;
const DELILAH = `${SEED_PREFIX}dup_delilah`;

const CEREMONIALS = "alb_e2e_ceremonials";
const COMPILATION = "alb_e2e_compilation";

/** The subjects the resolver will derive: the recording, plus both albums, sorted. */
const SHIP_SUBJECT = `duplicate:rec-e2e-ship|${CEREMONIALS},${COMPILATION}`;
const DELILAH_SUBJECT = `duplicate:rec-e2e-delilah|${CEREMONIALS},${COMPILATION}`;

function duplicate(id: string, recording: string, title: string) {
  return {
    id,
    type: "duplicate_recording",
    title: `“${title}” is in the library 2 times`,
    summary: `Florence + The Machine/Ceremonials/${title}.opus`,
    payload: {
      recordingMbid: recording,
      title,
      files: [
        {
          trackId: `${id}_a`,
          path: `Florence + The Machine/Ceremonials (2011)/${title}.opus`,
          albumId: CEREMONIALS,
        },
        {
          trackId: `${id}_b`,
          path: `Various Artists/Under Heaven Over Hell (2015)/${title}.opus`,
          albumId: COMPILATION,
        },
      ],
    },
    preselected: { action: "keep_all" },
  };
}

test.describe.configure({ mode: "serial" });

test.describe("dismissals the Console can see and undo", () => {
  test.beforeAll(async () => {
    await clearInboxDismissals();
    await seedInbox([
      duplicate(SHIP, "rec-e2e-ship", "Ship to Wreck"),
      duplicate(DELILAH, "rec-e2e-delilah", "Delilah"),
    ]);
  });

  test.afterAll(async () => {
    await clearSeededInbox();
    await clearInboxDismissals();
  });

  test("answering “keep both copies” hides the subject, and the page says so", async ({ page }) => {
    await signIn(page);
    await page.goto(`/review/${SHIP}?type=duplicate_recording`);

    const card = page.getByTestId("review-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Ship to Wreck");

    // Nothing is hidden yet, so the panel is not on the page at all.
    await expect(page.getByTestId("review-dismissals")).toHaveCount(0);

    // The preselected answer, pressed the way a person presses it.
    await page.getByTestId("review-option").filter({ hasText: "Keep both copies" }).click();
    await page.getByTestId("review-confirm").click();

    const panel = page.getByTestId("review-dismissals");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("hidden for good");

    // And the memory is on the subject, not on the row that carried the question.
    expect(await readDismissals()).toEqual([
      { subject: SHIP_SUBJECT, label: "“Ship to Wreck” is in the library 2 times" },
    ]);
  });

  test("the list names what is hidden, and only what is hidden", async ({ page }) => {
    await signIn(page);
    await page.goto("/review?type=duplicate_recording");

    await page.getByTestId("review-dismissals-toggle").click();
    const rows = page.getByTestId("review-dismissal");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Ship to Wreck");
    await expect(rows.first()).toContainText(SHIP_SUBJECT);

    // The pair nobody answered is still a question, and it is still in the queue.
    await expect(page.getByTestId("review-list")).toContainText("Delilah");
  });

  test("“Ask again” takes back one dismissal and leaves the rest alone", async ({ page }) => {
    await signIn(page);

    // Hide the second pair too, so undoing one is distinguishable from undoing everything.
    await page.goto(`/review/${DELILAH}?type=duplicate_recording`);
    await page.getByTestId("review-option").filter({ hasText: "Keep both copies" }).click();
    await page.getByTestId("review-confirm").click();

    await page.getByTestId("review-dismissals-toggle").click();
    await expect(page.getByTestId("review-dismissal")).toHaveCount(2);

    await page
      .getByTestId("review-dismissal")
      .filter({ hasText: "Ship to Wreck" })
      .getByTestId("review-dismissal-unhide")
      .click();

    // Eleven duplicates were dismissed here; putting all eleven back to correct one of them
    // would be the unrecoverable state wearing the other hat.
    await expect(page.getByTestId("review-dismissal")).toHaveCount(1);
    expect((await readDismissals()).map((row) => row.subject)).toEqual([DELILAH_SUBJECT]);
  });

  test("“Ask about all of them again” empties the memory in one press", async ({ page }) => {
    await signIn(page);
    await page.goto("/review?type=duplicate_recording");

    await page.getByTestId("review-dismissals-toggle").click();
    await page.getByTestId("review-dismissals-forget").click();

    // The panel goes because there is nothing left to list, which is the same sentence the
    // server tells: the next scan raises these questions again.
    await expect(page.getByTestId("review-dismissals")).toHaveCount(0);
    expect(await readDismissals()).toEqual([]);
  });
});
