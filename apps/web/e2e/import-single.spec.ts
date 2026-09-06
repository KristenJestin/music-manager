import { expect, test, resolveSource, signIn, waitForStatus } from "./helpers.ts";

/**
 * The single path of the wizard, end to end — DRIVE-1 §A1.
 *
 * That report's blocking finding was that a *single* could not be started from the Console at
 * all: the Start button was disabled because `bound` counted mapping lines a single does not
 * have, step 3 was skipped, and `start` had two branches (album, and "without MusicBrainz")
 * and no third. `bun run mm -- import` started singles perfectly well, which is what made the
 * gap invisible from every test that existed.
 *
 * So this walks the four steps a person walks, and asserts the three things the wizard was
 * missing: **recording** candidates with a **borrow release selector** on the chosen one, a
 * step 3 that shows the one binding rather than being skipped, and a Start that queues a job.
 *
 * Offline: `fixture://skinny-love` is answered by the toolbox's fixtures and the matcher
 * replays the `skinny-love` cassette, both chosen by the URL rather than by a mode switch.
 */
test.describe("importing a single", () => {
  test("recording, borrow release, one binding, and a job that runs", async ({ page }) => {
    await signIn(page);

    /* ---- step 1: one video ------------------------------------------------ */

    const importId = await resolveSource(page, "fixture://skinny-love");
    await expect(page.getByTestId("source-count")).toContainText("1 video");
    // The wizard says what it is looking at, and it is not an album.
    await expect(page.getByText("One video, one recording")).toBeVisible();

    /* ---- step 2: recordings, and where the track gets filed ---------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=2/, { timeout: 120_000 });
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 120_000 });
    await page.waitForURL(/release=/, { timeout: 120_000 });

    const preselected = page.getByTestId("candidate").filter({ hasText: "preselected" }).first();
    await expect(preselected).toBeVisible();
    await expect(preselected).toContainText("Skinny Love");

    /*
     * The borrow release selector (`docs/04` § Recording, and the prototype's `wizStep2Single`).
     * It exists only on the selected card, because it is that recording's own list of releases
     * — and it is the thing that decides the folder, the album tags and the track number.
     */
    const borrow = preselected.getByTestId("borrow-select");
    await expect(borrow).toBeVisible();
    const unselected = page.getByTestId("candidate").filter({ hasNotText: "preselected" }).first();
    await expect(unselected.getByTestId("borrow-select")).toHaveCount(0);

    // The search box is wired to *recordings* here, not to releases (DRIVE-1 §B2).
    await expect(page.getByTestId("mb-search")).toHaveAttribute("placeholder", /Search recordings/);

    /* ---- step 3: one video, one recording ---------------------------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=3/, { timeout: 120_000 });
    await expect(page.getByTestId("single-mapping")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("bound-count")).toHaveText("1");
    await expect(page.getByTestId("single-borrow")).toContainText("album tags from here");

    /* ---- step 4: a destination that is not "…" ----------------------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=4/, { timeout: 120_000 });
    await expect(page.getByTestId("summary-tracks")).toHaveText(
      "1 bound, 0 extra skipped, 0 uncovered",
    );
    // The preview named `01 - ….opus` under a folder named after the recording before the fix.
    await expect(page.getByTestId("destination-preview")).toContainText("Skinny Love");

    const start = page.getByTestId("wizard-start");
    await expect(start).toBeEnabled();
    await start.click();
    await page.waitForURL(new RegExp(`/imports/${importId}`), { timeout: 120_000 });

    /* ---- and the job actually runs ----------------------------------------- */

    await expect(page.getByTestId("log-viewer")).toContainText(/match|confirm|download/, {
      timeout: 120_000,
    });
    await waitForStatus(page, "Done");
  });
});
