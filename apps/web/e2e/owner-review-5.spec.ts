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
    /*
     * `?slow=400`, and it is the only reason this test can exist.
     *
     * The suite paces fixture downloads at ten milliseconds a slice so a run is minutes rather
     * than hours; at that speed a whole track is three slices and thirty milliseconds. That is
     * a perfectly good download and an impossible thing to observe from a browser — the DOM
     * state this test is about would exist for less than one poll. The switch is a scenario
     * switch like `?fp=mismatch` and `?mb=503`: a recorded URL carrying the condition it is
     * meant to exercise, here *duration*, and only for the import that asks.
     */
    const importId = await resolveSource(page, "fixture://discovery?slow=400");

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
     * for as long as its bytes are moving. `waitFor` polls **inside the page**, which is the
     * difference between catching that window and asking about it once a second from outside.
     */
    await page
      .locator('[data-testid="track-progress"][data-downloading="yes"]')
      .first()
      .waitFor({ state: "attached", timeout: 120_000 });

    /*
     * One read of the whole column, in one evaluation, so the numbers below describe **one
     * instant** rather than three of them: the download slot is single and moves on, and a
     * three-round-trip assertion would be comparing a bar that has already finished with a
     * row that has already started.
     */
    const midRun = await page.getByTestId("track-status").evaluateAll((cells) =>
      cells.map((cell) => {
        const bar = cell.querySelector('[role="progressbar"]');
        return {
          height: Math.round(cell.getBoundingClientRect().height),
          bar: bar !== null,
          value: bar === null ? null : Number(bar.getAttribute("aria-valuenow")),
          spacer: cell.querySelector('[data-testid="track-progress-spacer"]') !== null,
        };
      }),
    );

    const withBar = midRun.filter((cell) => cell.bar);
    // A bar was drawn, and only for what is downloading — never one per row, which is G2.
    expect(withBar.length, JSON.stringify(midRun)).toBeGreaterThan(0);
    expect(withBar.length).toBeLessThan(midRun.length);
    // Every row without a bar still holds the line, at the bar's own height.
    for (const cell of midRun) expect(cell.bar === cell.spacer).toBe(false);
    // The value is yt-dlp's own percentage, not a placeholder.
    for (const cell of withBar) {
      expect(cell.value).toBeGreaterThanOrEqual(0);
      expect(cell.value).toBeLessThanOrEqual(100);
    }
    const midRunHeights = new Set(midRun.map((cell) => cell.height));

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
    // bar's own `h-1.5`, so swapping one for the other cannot move a single row. A failed row
    // is taller on purpose (it carries the error line), so only the agreeing heights count.
    expect(
      midRunHeights.has(finished[0] ?? -1),
      `mid-run heights ${[...midRunHeights].join()} vs finished ${String(finished[0])}`,
    ).toBe(true);
  });
});

/** The rendered height of every Status cell, in device pixels. */
async function heightsOfStatusCells(page: Page): Promise<number[]> {
  return await page
    .getByTestId("track-status")
    .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().height)));
}
