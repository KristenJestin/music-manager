import { expect, test, resolveSource, signIn, waitForStatus } from "./helpers.ts";

/**
 * The owner's fourth round (`orchestration/feedback/2026-09-08-owner-review-4.md`), on the job
 * detail page:
 *
 *  - F1: the CONF and FP columns are gone (the confidence figure moved beside the recording
 *    title, the fingerprint result moved into Status), and the table no longer scrolls
 *    sideways at 1280 px;
 *  - F2: the FILE column truncates from the *start* — the album folder and file name stay
 *    visible, the earlier, less useful part of the path is what gets the ellipsis;
 *  - F3: the header stepper and the "Steps" card show a `done/total` count per pipelined step
 *    rather than pretending only one step ever runs at a time.
 *
 * One run, driven through the wizard exactly as `import-album.spec.ts` does — `resolveSource`
 * alone only creates the import and resolves its videos, it does not queue the job, and a job
 * that was never started has nothing to show at any of the three points above. `Discovery`
 * runs in ~10 s in this suite (`MM_TOOLBOX_FIXTURE_DELAY_MS=10`), so the mid-run overlap of
 * `download`/`fingerprint`/`tag`/`place` (decision 147) is too narrow a window for a reliable
 * assertion here — that is what the `agent-browser` captures against a deliberately slowed
 * fixture are for (`orchestration/reports/feedback-4/`). What this spec pins down holds once
 * the album is `Done`: the columns that were removed stay removed, the path truncates the
 * right way, and every pipelined step's counter reaches the full count.
 */
test.describe("owner review 4", () => {
  test("F1 + F2 + F3: columns, truncation and per-step counters on a finished job", async ({
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

    await waitForStatus(page, "Done", 180_000);
    await expect(page.getByTestId("job-tracks")).toBeVisible();

    // F1: the columns the owner asked removed are gone, by name.
    const headerText = await page.getByTestId("job-tracks").locator("thead").innerText();
    expect(headerText).not.toContain("Conf.");
    expect(headerText.split(/\s+/)).not.toContain("FP");

    // F1: no horizontal scrollbar on the tracks table, at the two widths the owner tested.
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      const overflow = await page.getByTestId("job-tracks").evaluate((table) => {
        const container = table.parentElement;
        return {
          scrollWidth: container?.scrollWidth ?? 0,
          clientWidth: container?.clientWidth ?? 0,
        };
      });
      expect(
        overflow.scrollWidth,
        `at ${viewport.width}px: scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`,
      ).toBeLessThanOrEqual(overflow.clientWidth);
    }

    // F2: the FILE cell truncates from the start (`dir="rtl"` on an LTR string), not the end.
    const fileCell = page
      .getByTestId("job-tracks")
      .locator("tbody tr")
      .first()
      .locator("td")
      .nth(3);
    await expect(fileCell.locator("span[dir='rtl']")).toHaveCount(1);

    // F3: the header stepper — `download`, `fingerprint`, `tag` and `place` all read the full
    // count once the album has gone through, one counter per step, not one shared number. 14
    // tracks bound, plus the one extra video the denominator (`tracks.length`) still counts.
    const counts = page.locator('[data-slot="pipeline-stepper"] [data-testid="step-count"]');
    await expect(counts).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      await expect(counts.nth(index)).toHaveText("14/15");
    }

    // F3: the "Steps" card — the same four steps show a `done/total track(s)` line beside
    // their badge (owner review: "compteurs + messages"). `dt`/`dd` are adjacent siblings, one
    // pair per step (`key-value.tsx`), so the count for `download` is the `dd` right after the
    // `dt` that says "download".
    const stepsCard = page.locator("section", {
      has: page.getByRole("heading", { name: "Steps" }),
    });
    await expect(stepsCard.getByTestId("step-count")).toHaveCount(4);
    for (const label of ["download", "fingerprint", "tag", "place"]) {
      const count = stepsCard.locator(`dt:text-is("${label}") + dd`).getByTestId("step-count");
      await expect(count).toHaveText("14/15 track(s)");
    }
  });
});
