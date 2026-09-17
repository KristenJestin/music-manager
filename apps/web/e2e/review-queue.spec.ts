import type { Page } from "@playwright/test";
import { expect, test, resolveSource, signIn, typeInto } from "./helpers.ts";
import {
  clearSeededInbox,
  readImport,
  seedInbox,
  setImportTitle,
  SEED_PREFIX,
  type SeededItem,
} from "./seed.ts";

/**
 * `/review` at the size that broke it.
 *
 * The queue worked fine at five items and was unusable at three hundred, which is the only
 * size worth testing: with 168 verification mismatches on top, the 40 edition decisions were
 * unreachable by any means the page offered. So the queue is seeded to that shape and the
 * assertions are about *reaching a decision* —
 *
 *  - the type filter brings the edition decisions to the top of the page;
 *  - the number on the chip, the number in the pager and the rows actually rendered are one
 *    number (the "filtered count lies" bug, twice in this codebase's history);
 *  - a card with no candidate takes a pasted MusicBrainz release id and relaunches the import
 *    pinned to it, which is what the owner was being sent to a terminal for;
 *  - every card links to the audio the question is about.
 *
 * The rows are written straight to `inbox_items` (`seed.ts` says why, and cleans up after
 * itself): three hundred imports cannot be produced by a suite with one download slot. Every
 * assertion still goes through the Console.
 */

/** The Japanese pressing on the Discovery cassette — deliberately *not* the one `match` picks. */
const PINNED_RELEASE = "51467269-3122-3d7e-92b2-0f0a694d30c1";
/** What the matcher chooses on its own, so "pinned" can be told apart from "unchanged". */
const DEFAULT_RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";

const COUNTS = {
  verify_mismatch: 168,
  uncovered_tracks: 47,
  extra_videos: 32,
  fingerprint_mismatch: 20,
  ambiguous_release: 40,
} as const;

function bulk(): SeededItem[] {
  const items: SeededItem[] = [];
  let n = 0;
  for (const [type, howMany] of Object.entries(COUNTS)) {
    for (let i = 0; i < howMany; i += 1) {
      n += 1;
      items.push({
        id: `${SEED_PREFIX}${String(n).padStart(4, "0")}`,
        type,
        title:
          type === "ambiguous_release"
            ? `No MusicBrainz release matches “Seeded Record ${String(i)} (Expanded Edition)”`
            : `Seeded ${type.replace("_", " ")} ${String(i)}`,
        summary: type === "ambiguous_release" ? "The search came back empty." : null,
        payload: type === "ambiguous_release" ? { candidates: [] } : {},
      });
    }
  }
  return items;
}

const TOTAL = Object.values(COUNTS).reduce((sum, n) => sum + n, 0);

/** Cancel the job on screen when it is still cancellable, and say nothing when it is not. */
async function stopIfRunning(page: Page): Promise<void> {
  const cancel = page.getByTestId("job-cancel");
  if ((await cancel.count()) > 0) await cancel.click();
}

test.describe("the review queue at three hundred items", () => {
  test.afterAll(async () => {
    await clearSeededInbox();
  });

  test("filters by type, and the chip, the pager and the rows say one number", async ({ page }) => {
    await seedInbox(bulk());
    await signIn(page);
    /*
     * Scoped to the seeded rows from the first navigation.
     *
     * The suite is serial and the specs before this one leave real Inbox items behind — an
     * `extra_videos` here, an `uncovered_tracks` there — so an unscoped queue is 307 plus
     * however many the run happened to produce, and every number below would be "about right".
     * `?q=Seeded` is a filter the page already has, every seeded title carries the word, and no
     * other spec's does; the counts are then exact, which is the only way a test about counts
     * agreeing is worth anything. It also exercises the search and the type filter *together*,
     * which is where a wrong predicate hides.
     */
    await page.goto("/review?q=Seeded");

    /* ---- the toolbar is there at all, which is the whole complaint ---------- */

    await expect(page.getByTestId("review-search")).toHaveValue("Seeded");
    await expect(page.getByTestId("review-status")).toBeVisible();
    await expect(page.getByTestId("review-sort")).toBeVisible();

    /*
     * The chips are the types the queue *holds*, not all fourteen. The counts are what makes
     * them worth the space: "Verify mismatch 168" next to "Ambiguous release 40" is the
     * sentence the owner could not get the page to say.
     */
    const editions = page.getByTestId("review-types-ambiguous_release");
    await expect(editions).toContainText("Ambiguous release");
    await expect(editions).toContainText(String(COUNTS.ambiguous_release));
    await expect(page.getByTestId("review-types-verify_mismatch")).toContainText(
      String(COUNTS.verify_mismatch),
    );
    await expect(page.getByTestId("review-types-all")).toContainText(String(TOTAL));

    /* ---- 307 items, 50 to a page ------------------------------------------- */

    await expect(page.getByTestId("review-pager-range")).toContainText(`1–50 of ${String(TOTAL)}`);
    expect(await page.getByTestId("review-list").getByRole("link").count()).toBe(50);

    /* ---- one click, and the edition decisions are the page ------------------ */

    await editions.click();
    await page.waitForURL(/type=ambiguous_release/);
    await expect(editions).toHaveAttribute("data-active", "true");

    /*
     * The count on the chip and the rows on screen are one number.
     *
     * Forty fits on a page, so the pager is gone — which is itself the assertion that the total
     * moved with the filter rather than staying at 307. That is the shape of both past
     * "filtered count lies" bugs: a count computed from a predicate the list did not use.
     */
    await expect(page.getByTestId("review-pager")).toHaveCount(0);
    const rows = page.getByTestId("review-list").getByRole("link");
    expect(await rows.count()).toBe(COUNTS.ambiguous_release);
    await expect(editions).toContainText(String(COUNTS.ambiguous_release));
    // Every row really is one, rather than the filter having been cosmetic.
    await expect(rows.first()).toContainText("No MusicBrainz release matches");

    /* ---- and the free text narrows it further, count and rows together ------ */

    await typeInto(page.getByTestId("review-search"), "Seeded Record 7 (");
    await page.keyboard.press("Enter");
    await page.waitForURL(/Seeded\+Record/);
    const narrowed = page.getByTestId("review-list").getByRole("link");
    await expect(narrowed).toHaveCount(1);
    await expect(page.getByTestId("review-types-ambiguous_release")).toContainText("1");
  });

  test("a card with no candidate takes a pasted release id and relaunches the import on it", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");

    // The situation `match` leaves behind when the search comes back empty: an item with no
    // candidate at all, on a real import. It used to offer "Cancel this import" and a sentence
    // telling the owner to go and run `mm import --release <mbid>`.
    await seedInbox([
      {
        id: `${SEED_PREFIX}pin`,
        type: "ambiguous_release",
        title: "No MusicBrainz release matches “Discovery (Expanded Edition)”",
        summary: "The search came back empty.",
        importId,
        payload: { candidates: [], url: "fixture://discovery" },
      },
    ]);

    await page.goto(`/review/${SEED_PREFIX}pin`);
    const card = page.getByTestId("review-card");
    await expect(card).toHaveAttribute("data-item-type", "ambiguous_release");

    /* ---- what the card offers now ------------------------------------------ */

    const panel = page.getByTestId("no-candidate-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("pin-release-input")).toBeVisible();
    // The fixture playlist is called "Discovery" and carries no qualifier, so the other button
    // says so rather than offering a search that would change nothing.
    await expect(page.getByTestId("drop-qualifier-absent")).toBeVisible();

    /* ---- a pasted address, not only a bare id ------------------------------ */

    await typeInto(
      page.getByTestId("pin-release-input"),
      `https://musicbrainz.org/release/${PINNED_RELEASE}`,
    );
    await page.getByTestId("pin-release-submit").click();
    await expect(page.getByTestId("toaster")).toContainText(/Pinned to/, { timeout: 120_000 });

    /* ---- and the import really is pinned to that release, not to the other -- */

    const job = await readImport(importId);
    expect(job?.options["releaseMbid"]).toBe(PINNED_RELEASE);
    expect(job?.releaseMbid).toBe(PINNED_RELEASE);
    expect(job?.releaseMbid).not.toBe(DEFAULT_RELEASE);

    // And the page says so, through the shared MusicBrainz link rather than as bare text.
    await page.goto(`/imports/${importId}`);
    await expect(page.getByTestId("job-release-mb")).toHaveAttribute(
      "href",
      `https://musicbrainz.org/release/${PINNED_RELEASE}`,
    );
    // The relaunch put the job back on the queue; stop it here rather than leave a download
    // running under the specs that follow. Tolerant of a job that already finished: the
    // fixture skips every recording the library already holds, so it often has.
    await stopIfRunning(page);
  });

  test("searches again without the edition qualifier, and says what it will search for", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");
    // The shape of the owner's 30 stuck imports: a playlist named after an edition MusicBrainz
    // never published. `Album - ` is the prefix a YouTube-generated release playlist carries,
    // and the matcher's own hints already strip it.
    await setImportTitle(importId, "Album - Discovery (Expanded Edition)");

    await seedInbox([
      {
        id: `${SEED_PREFIX}qual`,
        type: "ambiguous_release",
        title: "No MusicBrainz release matches “Discovery (Expanded Edition)”",
        summary: "The search came back empty.",
        importId,
        payload: { candidates: [] },
      },
    ]);

    await page.goto(`/review/${SEED_PREFIX}qual`);
    const button = page.getByTestId("drop-qualifier");
    await expect(button).toBeVisible();
    // It names the title it is about to search for, so pressing it is not a guess.
    await expect(page.getByTestId("no-candidate-panel")).toContainText("“Discovery”");

    await button.click();
    await expect(page.getByTestId("toaster")).toContainText(/Searching again for “Discovery”/, {
      timeout: 120_000,
    });

    const job = await readImport(importId);
    // The stated album title `match` prefers over the one it derives from the videos' tags.
    expect(job?.options["albumTitle"]).toBe("Discovery");

    await page.goto(`/imports/${importId}`);
    await stopIfRunning(page);
  });

  test("refuses something that is not a release id, in words, without leaving the card", async ({
    page,
  }) => {
    await signIn(page);
    // On a real import: the card only offers the box when it is about one, because relaunching
    // is what the box does.
    const importId = await resolveSource(page, "fixture://discovery");
    await seedInbox([
      {
        id: `${SEED_PREFIX}bad`,
        type: "ambiguous_release",
        title: "No MusicBrainz release matches “Whatever This Is”",
        importId,
        payload: { candidates: [] },
      },
    ]);

    await page.goto(`/review/${SEED_PREFIX}bad`);
    await typeInto(page.getByTestId("pin-release-input"), "the blue one");
    await page.getByTestId("pin-release-submit").click();
    await expect(page.getByTestId("toaster")).toContainText(
      /does not contain a MusicBrainz release id/i,
      { timeout: 60_000 },
    );
    // Still on the card, with what was typed still in the box.
    await expect(page.getByTestId("pin-release-input")).toHaveValue("the blue one");
  });

  test("links every card to the audio the question is about", async ({ page }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");

    await seedInbox([
      {
        id: `${SEED_PREFIX}link`,
        type: "uncovered_tracks",
        title: "2 track(s) of the release have no video",
        importId,
        payload: { positions: [6, 9] },
        preselected: { action: "import anyway" },
      },
    ]);

    await page.goto(`/review/${SEED_PREFIX}link`);
    const source = page.getByTestId("review-source");
    await expect(source).toBeVisible();
    // `fixture://discovery` is provenance, not a destination, so `lib/source-url.ts` falls
    // through to the first entry's own `webpage_url` — which is the video a person would open.
    await expect(source).toHaveAttribute("href", /^https:\/\/www\.youtube\.com\/watch\?v=/);
    await expect(source).toHaveAttribute("target", "_blank");
  });

  test("links each track of an import to its own video", async ({ page }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");

    await page.goto(`/imports/${importId}`);
    const first = page.getByTestId("track-source").first();
    await expect(first).toBeVisible({ timeout: 60_000 });
    // The playlist was the only link this page had; the address of each video was in
    // `import_tracks.raw.webpage_url` the whole time.
    await expect(first).toHaveAttribute("href", /^https:\/\/www\.youtube\.com\/watch\?v=/);
    await expect(first).toHaveAttribute("target", "_blank");
  });
});
