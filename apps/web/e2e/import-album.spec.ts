import { expect, test, resolveSource, signIn, uniqueSource, waitForStatus } from "./helpers.ts";

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

    /*
     * The list is release **groups** now (decision 151), and the best one is open with its
     * best pressing preselected inside it.
     */
    const groups = page.getByTestId("candidate-group");
    await expect(groups.first()).toHaveAttribute("data-state", "open");
    await expect(groups.first()).toHaveAttribute("data-preselected", "true");
    await expect(groups.first().getByTestId("group-score")).toBeVisible();

    const preselected = page.getByTestId("candidate").filter({ hasText: "preselected" }).first();
    await expect(preselected).toBeVisible();
    const score = await preselected.getByTestId("candidate-score").innerText();
    const percent = Number.parseInt(score.replace("%", ""), 10);
    expect(percent, `the preselected candidate scored ${score}`).toBeGreaterThanOrEqual(90);
    // Both directions of the fit, never only the flattering one (D3, decision 152).
    await expect(preselected.getByTestId("candidate-coverage")).toContainText("14/15");

    // "why?" is decision 002 made visible: the reasons behind the number, and — since D1 —
    // a control that says what it is about to do and folds rather than blinking.
    const other = page.getByTestId("candidate").filter({ hasNotText: "preselected" }).first();
    await expect(other.getByTestId("candidate-why")).toHaveAttribute("data-state", "closed");
    await expect(other.getByTestId("why-toggle")).toHaveText(/why\?/);
    await other.getByTestId("why-toggle").click();
    await expect(other.getByTestId("candidate-why")).toHaveAttribute("data-state", "open");
    await expect(other.getByTestId("why-toggle")).toHaveText(/hide why/);
    await other.getByTestId("why-toggle").click();
    await expect(other.getByTestId("candidate-why")).toHaveAttribute("data-state", "closed");

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

  /*
   * `docs/04` § Règles: a URL imported before is *reported*, not refused.
   *
   * It used to be observed by pasting `fixture://discovery` a second time and reading the
   * banner, which worked only because the wizard opened a new import every time — the defect
   * of `fix-wizard-reuse`. A second visit now re-enters the first import, so the second import
   * has to be asked for, which is the whole point: re-importing is legitimate and it is no
   * longer what happens by accident. The banner is what it has always been.
   */
  test("a second import of the same URL is asked for, then reported — not refused", async ({
    page,
  }) => {
    await signIn(page);
    const url = uniqueSource("fixture://discovery");

    await page.goto(`/import/new?url=${encodeURIComponent(url)}`);
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 60_000 });
    const first = new URL(page.url()).searchParams.get("importId") ?? "";

    // Coming back re-enters it, and says so instead of quietly opening a second.
    await page.goto(`/import/new?url=${encodeURIComponent(url)}`);
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("wizard-reused")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/imported before/)).toHaveCount(0);

    // And the escape hatch is a gesture: press it, and there are two, reported.
    await page.getByTestId("wizard-fresh").click();
    await expect(page.getByTestId("wizard-duplicates")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/imported before/)).toBeVisible();
    expect(new URL(page.url()).searchParams.get("importId")).not.toBe(first);
  });
});
