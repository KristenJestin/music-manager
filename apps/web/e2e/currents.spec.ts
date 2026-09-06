import { expect, test } from "@playwright/test";
import { mappingRow, resolveSource, signIn } from "./helpers.ts";

/**
 * `fixture://currents`, the fixture the phase specification names.
 *
 * It goes as far as this scenario *can* go offline, and stops there on purpose. Currents has
 * no rows in the raw source cache — `bun run cache:seed-fixtures` seeds Discovery and Skinny
 * Love — so its `tag` step cannot build a metadata document without the network and the job
 * cannot reach `done`. Running it to completion here would be a test that needs MusicBrainz,
 * which `CLAUDE.md` forbids outright.
 *
 * What it does prove is everything up to that boundary, and it is not little: a second album
 * resolves, the matcher replays a different cassette, the wizard scores a different release,
 * and the mapping editor turns thirteen bound videos into eleven bound and two uncovered. The
 * Inbox half of the story is proven end to end by `review.spec.ts`, on a fixture that can
 * finish.
 */
test.describe("fixture://currents", () => {
  test("resolves, matches and maps, and the editor drives the counts", async ({ page }) => {
    await signIn(page);

    const importId = await resolveSource(page, "fixture://currents");
    await expect(page.getByTestId("source-count")).toContainText("13 videos");
    await expect(page.getByText("Tame Impala", { exact: false }).first()).toBeVisible();

    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 150_000 });
    const preselected = page.getByTestId("candidate").filter({ hasText: "preselected" }).first();
    await expect(preselected).toContainText("Currents");
    await expect(preselected).toContainText("13 tracks");

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=3/, { timeout: 150_000 });
    await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId("bound-count")).toHaveText("13");
    await expect(page.getByTestId("uncovered-count")).toHaveText("0");

    /*
     * The two the scenario is about. The cassette omits their videos deliberately; the toolbox
     * fixture includes them, so the situation is made here instead — which is the same
     * situation, and also the only way to check that the editor's arithmetic is right.
     */
    for (const title of ["Gossip", "Disciples"]) {
      await mappingRow(page, title).getByTestId("mapping-select").selectOption("");
    }
    await expect(page.getByTestId("bound-count")).toHaveText("11");
    await expect(page.getByTestId("extra-count")).toHaveText("2");
    await expect(page.getByTestId("uncovered-count")).toHaveText("2");
    await expect(page.getByTestId("uncovered-callout")).toContainText("no video");
  });
});
