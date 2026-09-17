import { expect, test, signIn, uniqueSource } from "./helpers.ts";

/**
 * Coming back to the wizard with a URL it already has an import for.
 *
 * The defect, measured on the owner's instance: **204 imports parked at "Waiting for the import
 * wizard" for 7 URLs** — 80 for one album — because every entrance to the wizard opened a new
 * import for a URL that already had one, and every one of them cost a full yt-dlp extraction.
 *
 * Two behaviours are asserted here, and they are the two halves of the fix:
 *
 *  - re-entering by `?url=` lands on the **same** import, and the screen says so;
 *  - "Re-fetch" re-reads the source **into that import** instead of opening a sibling.
 *
 * This is the one spec that deliberately pastes the same URL twice, so it does not use the
 * `resolveSource` helper — that helper hands every caller a source of its own precisely
 * because the wizard now re-enters.
 */
test.describe("re-entering the wizard for a URL it already has", () => {
  test("a second entry picks up the first import and names it", async ({ page }) => {
    await signIn(page);
    const url = uniqueSource("fixture://discovery");

    /* ---- first entry: an import is opened --------------------------------- */

    await page.goto(`/import/new?url=${encodeURIComponent(url)}`);
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 60_000 });
    const first = new URL(page.url()).searchParams.get("importId") ?? "";
    expect(first).not.toBe("");
    // Nothing to report yet: this URL had no import before.
    await expect(page.getByTestId("wizard-reused")).toHaveCount(0);
    await expect(page.getByTestId("wizard-duplicates")).toHaveCount(0);

    /* ---- second entry: the same import, and the screen says so ------------- */

    await page.goto(`/import/new?url=${encodeURIComponent(url)}`);
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 60_000 });

    const second = new URL(page.url()).searchParams.get("importId") ?? "";
    expect(second, "the second entry must re-enter the first import").toBe(first);

    const notice = page.getByTestId("wizard-reused");
    await expect(notice).toBeVisible();
    // It names the import and when it was opened — the two facts that make a silent switch
    // into a reported one.
    await expect(notice).toContainText(first);
    await expect(notice).toContainText(/Picked up the import opened/);
    // And there is no sibling to report, because none was made.
    await expect(page.getByTestId("wizard-duplicates")).toHaveCount(0);

    /* ---- and the flag survives a reload, like everything else in this URL --- */

    await page.reload();
    await expect(page.getByTestId("wizard-reused")).toBeVisible({ timeout: 60_000 });
  });

  /**
   * The cause the owner found, in a browser: a source that takes its time.
   *
   * He watched four identical imports of one playlist arrive at once, all `Paused` at `0/13`,
   * all created "just now", without refreshing anything. The wizard's `?url=` loader creates,
   * and it only swaps the address bar for `?importId=` *after* `resolveSource` returns — a
   * minute on his playlist. For that whole minute anything that re-enters the loader is another
   * creation: the match poll's `router.invalidate()`, a second tab, an impatient Enter.
   *
   * `?extractslow=6000` makes the toolbox hold `/extract` open for six seconds, so the window
   * is real rather than assumed, and two tabs go into it together. A test on an instant fixture
   * would pass whatever the service did, which is the whole reason this one asks for a slow one.
   */
  test("two tabs entering one slow URL together still open one import", async ({ context }) => {
    const first = await context.newPage();
    await signIn(first);
    const url = `${uniqueSource("fixture://discovery")}&extractslow=6000`;
    const target = `/import/new?url=${encodeURIComponent(url)}`;

    const second = await context.newPage();
    // Both loaders enter the creating branch before either can have finished resolving.
    await Promise.all([first.goto(target), second.goto(target)]);
    await first.waitForURL(/importId=/, { timeout: 180_000 });
    await second.waitForURL(/importId=/, { timeout: 180_000 });

    const left = new URL(first.url()).searchParams.get("importId");
    const right = new URL(second.url()).searchParams.get("importId");
    expect(left, "the first tab must have landed on an import").toBeTruthy();
    expect(right, "two tabs must not become two imports").toBe(left);

    // Both were handed a resolved source, not an empty shell of one.
    await expect(first.getByTestId("source-count")).toContainText("15 videos", { timeout: 60_000 });
    await expect(second.getByTestId("source-count")).toContainText("15 videos", {
      timeout: 60_000,
    });
    // One of them re-entered, and says so.
    expect(
      (await first.getByTestId("wizard-reused").count()) +
        (await second.getByTestId("wizard-reused").count()),
      "exactly one of the two tabs re-entered the other's import",
    ).toBe(1);

    await first.close();
    await second.close();
  });

  test("Re-fetch re-reads the source into this import instead of opening a sibling", async ({
    page,
  }) => {
    await signIn(page);
    const url = uniqueSource("fixture://discovery");

    await page.goto(`/import/new?url=${encodeURIComponent(url)}`);
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 60_000 });
    const importId = new URL(page.url()).searchParams.get("importId") ?? "";
    expect(importId).not.toBe("");

    // The box still holds this import's URL, so the button means "re-fetch", and says so.
    const button = page.getByTestId("wizard-resolve");
    await expect(button).toContainText("Re-fetch");
    await expect(button).toHaveAttribute("data-action", "refetch");

    await button.click();
    await expect(page.getByText(/Read again from the source/)).toBeVisible({ timeout: 120_000 });

    // Same import, same videos, and — the point — no second import of this URL to report.
    expect(new URL(page.url()).searchParams.get("importId")).toBe(importId);
    await expect(page.getByTestId("source-count")).toContainText("15 videos");
    await expect(page.getByTestId("wizard-duplicates")).toHaveCount(0);

    // Changing the box changes what the button means: a different URL is a different import.
    await page.getByTestId("wizard-url").fill(uniqueSource("fixture://currents"));
    await expect(button).toContainText("Resolve");
    await expect(button).toHaveAttribute("data-action", "resolve");
  });
});
