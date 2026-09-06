import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveSource, signIn } from "./helpers.ts";

/**
 * The wizard corrections of the owner's first real import (`orchestration/feedback/
 * 2026-09-06-owner-review-1.md`, lot A).
 *
 * Four of the twelve items are about what the screen *does* rather than what it says, so they
 * are checked in a browser rather than argued about:
 *
 *  - **A5** pressing "Find on MusicBrainz" shows a waiting screen on the first frame, with the
 *    MusicBrainz request counters on it — not ten seconds of nothing;
 *  - **A9** the Back/next bar is on screen at the top of step 3, not two screens below it;
 *  - **A10** the mapping selector is a listbox with "not on this release" first;
 *  - **A11** the "i" opens a real tooltip with the signals laid out, not a truncated `title`.
 *
 * A3 (real cover art) is checked here too, on the half of it that is deterministic offline: a
 * release card asks the Cover Art Archive for its own MBID. Whether the archive *answers* is
 * the network's business and the tile falls back to its gradient when it does not, which is
 * the whole point of the component.
 *
 * The screenshots are the report's evidence. They go to `orchestration/`, never into this
 * repository — `CLAUDE.md` is explicit that nothing but code, tests and configuration lives
 * here.
 */
const SHOTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "orchestration",
  "reports",
  "feedback-1-A",
);

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.describe("owner review, lot A", () => {
  test("the wizard waits out loud, keeps its actions in reach, and explains its bindings", async ({
    page,
  }) => {
    await signIn(page);

    const importId = await resolveSource(page, "fixture://discovery");
    await expect(page.getByTestId("source-count")).toContainText("15 videos");

    /* ---- A1: the source panel is written for a person, not for yt-dlp ------ */

    await expect(page.getByText("What we found on YouTube")).toBeVisible();
    await expect(page.getByText("yt-dlp")).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, "A1-A3-step1-source.png"), fullPage: true });

    /* ---- A5: the waiting screen, with real counters ------------------------ */

    await page.getByTestId("wizard-next").click();
    const pending = page.getByTestId("wizard-pending");
    await expect(pending).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pending-title")).toContainText("Searching MusicBrainz");
    await expect(page.getByTestId("pending-counters")).toContainText("searches");
    await page.screenshot({ path: join(SHOTS, "A5-pending-musicbrainz.png") });

    await page.waitForURL(/step=2/, { timeout: 150_000 });
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 150_000 });

    /* ---- A3: a release card asks the archive for its own front ------------- */

    const preselected = page.getByTestId("candidate").filter({ hasText: "preselected" }).first();
    const mbid = await preselected.getAttribute("data-candidate-id");
    expect(mbid).toBeTruthy();
    await expect(preselected.getByTestId("cover-image")).toHaveAttribute(
      "src",
      `https://coverartarchive.org/release/${mbid ?? ""}/front-250`,
    );
    // Whether the archive answers is not this test's business, but giving it a moment makes the
    // screenshot show the real sleeves rather than the gradients they fall back to.
    await page.waitForLoadState("networkidle").catch(() => undefined);

    /* ---- A6/A7/A8: the flag, the buttons and the tracklist fit ------------- */

    await expect(page.getByTestId("fit-explainer")).toContainText("separates two pressings");
    await preselected.getByTestId("fit-toggle").click();
    await expect(preselected.getByTestId("candidate-fit")).toBeVisible();
    await expect(preselected.getByTestId("candidate-fit")).toContainText("One More Time");
    await page.screenshot({ path: join(SHOTS, "A6-A7-A8-candidates.png"), fullPage: true });
    await preselected.getByTestId("fit-toggle").click();

    /* ---- step 3 --------------------------------------------------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=3/, { timeout: 150_000 });
    await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 150_000 });

    /* ---- A9: the action bar is on screen without scrolling ---------------- */

    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await expect(page.getByTestId("wizard-actions")).toBeInViewport();
    await expect(page.getByTestId("wizard-next")).toBeInViewport();
    await page.screenshot({ path: join(SHOTS, "A9-sticky-actions.png") });

    /* ---- A10: a listbox, with the escape hatch first ---------------------- */

    const row = page.getByTestId("mapping-row").first();
    const select = row.getByTestId("mapping-select");
    // A real listbox trigger, not a native <select>: nothing in the DOM until it opens.
    await expect(page.getByRole("option")).toHaveCount(0);
    await select.click();
    const options = page.getByRole("option");
    await expect(options.first()).toContainText("not on this release");
    await page.screenshot({ path: join(SHOTS, "A10-mapping-select.png") });
    await page.keyboard.press("Escape");

    /* ---- A11: a real tooltip, not a truncated `title` --------------------- */

    const info = row.getByTestId("mapping-signals");
    await expect(info).not.toHaveAttribute("title", /./);
    await info.hover();
    const tooltip = page.locator("[data-slot=tooltip-content]");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Why this binding");
    await page.screenshot({ path: join(SHOTS, "A11-signals-tooltip.png") });

    /* ---- A12: the destination preview uses the new template --------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=4/, { timeout: 150_000 });
    await expect(page.getByText(/01 - One More Time/)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "A12-destination-preview.png"), fullPage: true });
  });
});
