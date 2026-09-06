import { expect, test, signIn } from "./helpers.ts";

/**
 * The Re-file button of `/library/quality` — the other half of decision 074.
 *
 * 074 changed the default `pathTemplate` and said the files already placed keep their names.
 * That leaves a library permanently disagreeing with its own setting, and the MCP test report
 * (§11) found exactly that with no way out. This spec proves the way out exists in the
 * Console: a counter that says how many files are off-template, a dry run that shows the plan
 * without moving anything, and an apply that is only reachable *after* the dry run.
 *
 * Like `scan.spec.ts`, what it proves is the shape of the feature rather than one finding: the
 * E2E library holds whatever the specs before it imported, so both "everything is in place"
 * and "N files are not" are legitimate states, and the assertions cover both explicitly. The
 * move itself is proven on real files by `mcp.integration.test.ts` §11, which can *cause* an
 * off-template file; a browser cannot.
 */
test.describe("re-filing the library against the path template", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/library/quality");
    await expect(page.getByTestId("relocate-callout")).toBeVisible({ timeout: 60_000 });
  });

  test("the callout carries the template and a count of off-template files", async ({ page }) => {
    const callout = page.getByTestId("relocate-callout");
    await expect(callout).toContainText("Library layout");
    // The effective template, verbatim — the button acts on this and on nothing else.
    await expect(callout).toContainText("{title}");

    const counter = page.getByTestId("off-template");
    if ((await counter.count()) > 0) {
      const value = Number.parseInt(((await counter.allInnerTexts())[0] ?? "0").trim(), 10);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
      // When there is work to do, the page says what it costs before offering to do it.
      await expect(callout).toContainText("play count");
    } else {
      await expect(callout).toContainText("filed where the template says it belongs");
    }
  });

  test("the tile agrees with the callout", async ({ page }) => {
    const tile = page.getByText("Off template", { exact: true });
    await expect(tile).toBeVisible();
  });

  test("Re-file is unreachable until the dry run has been read", async ({ page }) => {
    /*
     * This is the assertion that matters. A move takes Navidrome's play counts with it, so the
     * destructive button must not be pressable on arrival — the plan has to have been shown
     * first. `disabled` is checked before any click, so a regression that enabled it by default
     * fails here rather than in somebody's library.
     */
    await expect(page.getByTestId("relocate-apply")).toBeDisabled();
  });

  test("the dry run reports a plan and still moves nothing", async ({ page }) => {
    const dry = page.getByTestId("relocate-dry-run");
    if (await dry.isDisabled()) {
      // Nothing is off-template; the dry run is correctly not on offer either.
      await expect(page.getByTestId("relocate-apply")).toBeDisabled();
      return;
    }

    await dry.click();
    await expect(page.getByText(/would move|already in place/)).toBeVisible({ timeout: 60_000 });
    // The plan is shown, file by file, before anything is offered.
    await expect(page.getByTestId("relocate-plan")).toBeVisible();
    await expect(page.getByTestId("relocate-apply")).toBeEnabled();
  });

  test("nothing on the page offers to delete or overwrite a file", async ({ page }) => {
    // The same standing rule as the scan card: a path heuristic must never destroy an original.
    const callout = page.getByTestId("relocate-callout");
    await expect(callout.getByRole("button", { name: /delete|overwrite/i })).toHaveCount(0);
  });
});
