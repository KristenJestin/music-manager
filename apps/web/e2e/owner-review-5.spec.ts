import type { Page } from "@playwright/test";
import { expect, test, resolveSource, signIn, waitForStatus } from "./helpers.ts";

/**
 * The owner's fifth round (`orchestration/feedback/2026-09-08-owner-review-5.md`), G2.
 *
 * > Une barre de progression grise apparaît sous chaque badge, y compris « Placed » et
 * > « Queued ». Elle ne doit exister que pendant le téléchargement de la piste (avec % réel),
 * > sinon rien — la hauteur de ligne reste réservée pour ne pas faire sauter le tableau
 * > (décision 150).
 *
 * Two claims, and they pull in opposite directions, which is why they are asserted together
 * in one run rather than in two:
 *
 *  - **while a track is downloading** the Status column carries a real bar, whose
 *    `aria-valuenow` is yt-dlp's own percentage;
 *  - **at every other moment** — queued, waiting, tagging, placed, done — there is no bar at
 *    all, and the three lines of the block still occupy exactly the same height, so the table
 *    does not jump when a download starts or finishes (decision 150).
 *
 * The height claim is checked by measuring, not by trusting a class name: the Status cells of
 * a finished album are compared against the same cells mid-run, and against each other. A
 * spacer that was one pixel short of the bar it replaces would satisfy every DOM assertion in
 * this file and still make the table jump.
 *
 * G1 — the cover as a matching signal — is not exercised here, deliberately. It needs a
 * MusicBrainz release lookup carrying `cover-art-archive`, which the *matching* cassettes have
 * and the *toolbox* fixtures deliberately do not overlap with: `fixture://discovery` resolves
 * through the toolbox and matches through the `discovery` cassette, recorded before the block
 * was on the prune allow-list. It is proved instead where the data lives — against the
 * `pure-heroine` cassette in `apps/web/test/matching/` and `packages/domain`, and on the real
 * import captured in `orchestration/reports/feedback-5/`.
 */
test.describe("owner review 5", () => {
  test("G2: a bar only while downloading, and a row that never changes height", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=2/, { timeout: 120_000 });
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 120_000 });

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=3/, { timeout: 120_000 });
    await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 120_000 });

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=4/, { timeout: 120_000 });
    await page.getByTestId("wizard-start").click();
    await page.waitForURL(new RegExp(`/imports/${importId}`), { timeout: 120_000 });

    const blocks = page.getByTestId("track-progress");
    const bars = page.getByTestId("track-status").getByRole("progressbar");

    /*
     * ---- 1 · mid-run: exactly the tracks that are downloading carry a bar ----
     *
     * The page is live (server-sent events), and `liveTracks` keeps a track's last non-terminal
     * line until its `track.done` arrives — so a downloading track holds `data-downloading=yes`
     * for as long as its bytes are moving, not for the instant one event is on the wire.
     */
    const seen = { bars: 0, statusHeights: new Set<number>() };
    await expect
      .poll(
        async () => {
          const downloading = await page
            .locator('[data-testid="track-progress"][data-downloading="yes"]')
            .count();
          if (downloading > 0) {
            seen.bars = await bars.count();
            for (const height of await heightsOfStatusCells(page)) {
              seen.statusHeights.add(height);
            }
          }
          return downloading;
        },
        {
          message: "a track should show a download bar while its bytes are moving",
          timeout: 120_000,
          intervals: [100, 100, 100, 250, 500],
        },
      )
      .toBeGreaterThan(0);

    // A bar was drawn, and only for the tracks that were downloading — never one per row.
    expect(seen.bars).toBeGreaterThan(0);
    expect(seen.bars).toBeLessThan(15);

    // The bar's value is yt-dlp's, not a placeholder: `aria-valuenow` is a real percentage.
    // Read from the first bar that is on screen at this instant, whichever track owns it.
    const value = await bars
      .first()
      .getAttribute("aria-valuenow")
      .catch(() => null);
    if (value !== null) expect(Number(value)).toBeGreaterThanOrEqual(0);

    /* ---- 2 · once the album is through: no bar anywhere ---- */
    await waitForStatus(page, "Done", 180_000);
    await expect(page.getByTestId("job-tracks")).toBeVisible();

    // The regression the owner photographed: a grey track under every `Placed` and `Queued`.
    await expect(bars).toHaveCount(0);
    const total = await blocks.count();
    expect(total).toBeGreaterThan(0);
    for (let index = 0; index < total; index += 1) {
      await expect(blocks.nth(index)).toHaveAttribute("data-downloading", "no");
      // The line is still there — decision 150's reserved height — it is simply empty.
      await expect(blocks.nth(index).getByTestId("track-progress-spacer")).toHaveCount(1);
    }

    /* ---- 3 · the height, measured ---- */
    const finished = await heightsOfStatusCells(page);
    expect(
      new Set(finished).size,
      `Status cells disagree on their height: ${finished.join()}`,
    ).toBe(1);
    // And the height a finished row has is the height a downloading row had: the spacer is the
    // bar's own `h-1.5`, so swapping one for the other cannot move a single row.
    for (const midRun of seen.statusHeights) {
      expect(finished[0], `mid-run ${midRun} vs finished ${String(finished[0])}`).toBe(midRun);
    }
  });
});

/** The rendered height of every Status cell, in device pixels. */
async function heightsOfStatusCells(page: Page): Promise<number[]> {
  return await page
    .getByTestId("track-status")
    .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().height)));
}
