import { expect, test } from "@playwright/test";
import { resolveSource, signIn, waitForStatus } from "./helpers.ts";

/**
 * The reference scenario of `docs/phases/P06-web-coeur.md`:
 *
 *   login → paste `fixture://discovery` → step 1 shows 15 videos → step 2 shows the
 *   preselection at ~0.95 and opens "why?" → step 3 shows 14 bound and 1 extra → step 4
 *   starts → the job page receives SSE events → status `done` → the Inbox is empty.
 *
 * It runs entirely offline: the toolbox answers from its recorded fixtures and the matcher
 * replays the `discovery` cassette, because both follow the `fixture://` URL rather than a
 * mode switch.
 */
test.describe("importing an album", () => {
  test("the whole wizard, from a pasted URL to a finished job", async ({ page }) => {
    await signIn(page);

    /* ---- step 1: the source ---------------------------------------------- */

    const importId = await resolveSource(page, "fixture://discovery");
    await expect(page.getByTestId("source-count")).toContainText("15 videos");
    await expect(page.getByTestId("source-videos").locator("tbody tr")).toHaveCount(15);
    // The description parser is what found the label and the ℗ year.
    await expect(page.getByText("Daft Punk", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("“Provided to YouTube by”")).toBeVisible();

    /* ---- step 2: the candidates ------------------------------------------ */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=2/, { timeout: 120_000 });
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 120_000 });

    // The URL carries the choice, so a reload keeps it.
    await page.waitForURL(/release=/, { timeout: 120_000 });

    const preselected = page.getByTestId("candidate").filter({ hasText: "preselected" }).first();
    await expect(preselected).toBeVisible();
    const score = await preselected.getByTestId("candidate-score").innerText();
    const percent = Number.parseInt(score.replace("%", ""), 10);
    expect(percent, `the preselected candidate scored ${score}`).toBeGreaterThanOrEqual(90);

    // "why?" is decision 002 made visible: the reasons behind the number.
    const other = page.getByTestId("candidate").filter({ hasNotText: "preselected" }).first();
    await expect(other.getByTestId("candidate-why")).toBeHidden();
    await other.getByTestId("why-toggle").click();
    await expect(other.getByTestId("candidate-why")).toBeVisible();

    /* ---- step 3: the mapping --------------------------------------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=3/, { timeout: 120_000 });
    await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("bound-count")).toHaveText("14");
    await expect(page.getByTestId("extra-count")).toHaveText("1");
    await expect(page.getByTestId("uncovered-count")).toHaveText("0");
    await expect(page.getByTestId("mapping-row")).toHaveCount(15);
    await expect(page.getByTestId("extras-callout")).toBeVisible();

    /* ---- step 4: options and start ---------------------------------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=4/, { timeout: 120_000 });
    await expect(page.getByTestId("summary-tracks")).toHaveText(
      "14 bound, 1 extra skipped, 0 uncovered",
    );
    await expect(page.getByTestId("option-fingerprint")).toHaveAttribute("aria-checked", "true");

    await page.getByTestId("wizard-start").click();
    await page.waitForURL(new RegExp(`/imports/${importId}`), { timeout: 120_000 });

    /* ---- the job page, live ----------------------------------------------- */

    // The journal is fed by `GET /api/events`; the page must be reading it.
    await expect(page.getByTestId("log-viewer")).toBeVisible();
    await expect(page.getByTestId("log-viewer")).toContainText(/match|confirm|download/, {
      timeout: 120_000,
    });

    await waitForStatus(page, "Done");
    await expect(page.getByTestId("job-tracks")).toBeVisible();

    /* ---- and nothing was left to decide ------------------------------------ */

    await page.goto("/review");
    const open = page.getByTestId("review-list").getByRole("link");
    const forThisJob = page.getByTestId("review-list").filter({ hasText: importId });
    expect(await forThisJob.count(), "this import left nothing in the Inbox").toBe(0);
    // The extra video was shown in step 3 and accepted by pressing Start, so it is not a
    // question anybody has to answer twice.
    for (let index = 0; index < (await open.count()); index += 1) {
      await expect(open.nth(index)).not.toContainText(importId);
    }
  });

  test("a second import of the same URL is reported, not refused", async ({ page }) => {
    await signIn(page);
    await resolveSource(page, "fixture://discovery");
    await expect(page.getByText(/imported before/)).toBeVisible();
  });
});
