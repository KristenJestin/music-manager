/**
 * The owner's second review, in a browser.
 *
 * `orchestration/feedback/2026-09-07-owner-review-2.md`, the four points that can be observed
 * from the outside:
 *
 *  - **C5** — the job detail must keep itself current *without a reload*, and Retry must be
 *    disabled while the worker owns the job ("j'ai le temps de cliquer plein de fois sur
 *    Retry"). Asserted by never calling `reload()` and watching the rows change.
 *  - **C6** — a placed file that disappears must be **downloaded again**, not turned into
 *    `STEP_FAILED — Missing …`. The spec deletes one of the files the import just placed, which
 *    is exactly what happened to the owner's `04 My Enemy.opus`, and then presses Retry.
 *  - **C9** — the toast is shadcn's Base UI toast, not the hand-rolled div.
 *  - **C11** — the Quality checkbox is a real component, not `<input type="checkbox">`.
 *
 * Offline like every other spec here: `fixture://discovery` is answered by the toolbox's
 * recorded fixtures and the matcher's `discovery` cassette.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { join } from "node:path";
import { expect, test, reloadUntil, resolveSource, signIn, waitForStatus } from "./helpers.ts";

/** The library this run writes to; `scripts/e2e-web.ts` puts it in the environment. */
const LIBRARY = process.env["MM_LIBRARY_ROOT"] ?? "";

/**
 * Drive the wizard from a pasted URL to a started job, and return its id.
 *
 * Each step is waited for by what it *produces*, not by its number: step 2 has to have scored
 * the candidates (`preselection`, and the chosen release in the URL) and step 3 to have built
 * the mapping before *Next* means anything. `import-album.spec.ts` waits the same way, and for
 * the same reason — clicking earlier leaves the wizard where it was.
 */
async function startDiscovery(page: Page): Promise<string> {
  const importId = await resolveSource(page, "fixture://discovery");

  await page.getByTestId("wizard-next").click();
  await page.waitForURL(/step=2/, { timeout: 120_000 });
  await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 150_000 });
  await page.waitForURL(/release=/, { timeout: 120_000 });

  await page.getByTestId("wizard-next").click();
  await page.waitForURL(/step=3/, { timeout: 120_000 });
  await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 150_000 });

  await page.getByTestId("wizard-next").click();
  await page.waitForURL(/step=4/, { timeout: 120_000 });

  await page.getByTestId("wizard-start").click();
  await page.waitForURL(new RegExp(`/imports/${importId}`), { timeout: 120_000 });
  return importId;
}

test.describe("owner review 2", () => {
  test("C5 + C6: the job page follows itself, and a vanished file is downloaded again", async ({
    page,
  }) => {
    test.skip(LIBRARY === "", "MM_LIBRARY_ROOT is not in the environment");
    await signIn(page);

    /*
     * `import-album.spec.ts` runs before this file and has already filed Discovery, and
     * `download` skips a recording that is on disk — so the import below would place nothing
     * and there would be no file to make disappear. Clearing the folder puts the library back
     * to "this album is not here", which is the state this scenario is about. The files come
     * back at the same paths, so every spec that runs after this one sees what it expects.
     */
    const album = join(LIBRARY, "Daft Punk", "Discovery (2001)");
    rmSync(album, { recursive: true, force: true });

    const importId = await startDiscovery(page);

    /* ---- C5: it updates itself ------------------------------------------- */

    // Nothing below reloads the page. Before the fix the page only re-read its rows on a
    // `step.*` line, so during a download — which emits nothing but `track.*` — the Tracks
    // table and this counter stayed at whatever they said when the page opened.
    // Fifteen videos, fourteen of them bound to a track: the fifteenth is the extra, and it is
    // never placed. The counter therefore ends at 14/15, having started at 0/15.
    const placed = page.getByText(/^\d+\/\d+ placed$/);
    await expect(placed).toHaveText("0/15 placed", { timeout: 60_000 });
    await expect(placed).toHaveText("14/15 placed", { timeout: 300_000 });
    await waitForStatus(page, "Done");
    // Proof it was the stream and not a navigation: the URL never changed.
    expect(page.url()).toContain(`/imports/${importId}`);

    /* ---- C6: delete a placed file, press Retry ---------------------------- */

    const files = readdirSync(album).filter((name) => name.endsWith(".opus"));
    expect(files.length, "the import should have placed some files").toBeGreaterThan(0);
    const victim = join(album, files[0] ?? "");
    rmSync(victim, { force: true });
    expect(existsSync(victim)).toBe(false);

    // A finished job's page is static by design, so this is a fresh visit — the owner's own
    // gesture. Retry is enabled again now that nothing is running.
    await reloadUntil(page, `/imports/${importId}`, async () => {
      await expect(page.getByTestId("job-retry")).toBeEnabled({ timeout: 10_000 });
    });
    const retry = page.getByTestId("job-retry");
    await retry.click();

    // C5's other half, and the deterministic half: the very first click disables the button.
    // The owner's complaint was that he had "le temps de cliquer plein de fois sur Retry" —
    // and every one of those clicks used to start a step.
    await expect(retry).toBeDisabled();
    await expect(retry).toHaveText(/Queueing…|Running…/);

    // `verify` finds the hole, rewinds to `download`, and the file comes back on its own —
    // nothing else is pressed. Before the fix this ended at `STEP_FAILED — Missing: …` and
    // every further Retry re-ran `verify` and found the same hole.
    await expect
      .poll(() => existsSync(victim), {
        timeout: 300_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${victim} should have been downloaded again`,
      })
      .toBe(true);

    // And the job really finished, rather than parking on the failure.
    await reloadUntil(
      page,
      `/imports/${importId}`,
      async () => {
        await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 15_000 });
      },
      180_000,
    );
    await expect(page.getByText("STEP_FAILED")).toHaveCount(0);
  });

  test("C9: the toast is shadcn's Base UI toast", async ({ page }) => {
    await signIn(page);

    // Saving a setting is the one toast in the app that depends on nothing else running —
    // `settings.spec.ts` reads the same one.
    await page.goto("/settings/integrations");
    await page.getByTestId("integrations-save").click();

    const toaster = page.getByTestId("toaster");
    await expect(toaster).toBeVisible({ timeout: 60_000 });
    await expect(toaster).toContainText(/setting\(s\) saved/, { timeout: 60_000 });

    // The Base UI parts, which the hand-rolled div never had: the `data-slot` root and the
    // viewport, plus the swipe axis Base UI publishes on every toast it manages.
    await expect(toaster).toHaveAttribute("data-slot", "toast-viewport");
    const toast = toaster.locator('[data-slot="toast"]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("role", "status");
    await expect(toast.locator('[data-slot="toast-title"]')).toContainText(/setting\(s\) saved/);
    // Base UI's own stacking variable: the hand-rolled toast had no index and no animation.
    await expect(toast).toHaveAttribute("style", /--toast-index/);

    // It closes itself, which is the other half of "animé proprement".
    await expect(toaster).not.toContainText(/setting\(s\) saved/, { timeout: 30_000 });
  });

  test("C11: the Quality page has no native checkbox left", async ({ page }) => {
    await signIn(page);
    await reloadUntil(page, "/library/quality", async () => {
      await expect(page.getByTestId("quality-row").first()).toBeVisible({ timeout: 10_000 });
    });

    /*
     * The whole page, not just the row: the owner asked for a review of every native control.
     * `aria-hidden` matters — Base UI's `Checkbox` still renders a native `<input>` behind the
     * box so the control participates in a form, and marks it `aria-hidden`. What had to
     * disappear is the native box the owner photographed and the naked `<select>` next to it,
     * both of which were things he could see and click.
     */
    await expect(page.locator('input[type="checkbox"]:not([aria-hidden="true"])')).toHaveCount(0);
    await expect(page.locator("select:not([aria-hidden='true'])")).toHaveCount(0);

    const box = page.locator('[data-testid^="quality-select-"]').first();
    await expect(box).toHaveAttribute("role", "checkbox");
    await expect(box).toHaveAttribute("aria-checked", "false");
    await box.click();
    await expect(box).toHaveAttribute("aria-checked", "true");
  });
});
