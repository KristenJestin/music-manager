import { expect, test, reloadUntil, signIn, typeInto } from "./helpers.ts";
import { readDecisions, readImport } from "./seed.ts";

/**
 * Saying yes to an import that is waiting for one, from the Console.
 *
 * `confirm` is the one deliberately blocking step of the pipeline. Confirming it was possible
 * from `/api/v1`, from MCP and from `mm`, and from nowhere in the browser: the wizard opens the
 * gate inside its own flow, before the import ever reaches `awaiting_confirm`, so an import
 * that got there any other way sat on the job page with Retry, Cancel and no way to agree with
 * the mapping it was showing.
 *
 * **Driven through a watched source**, and that is not incidental. `confirmStep` treats
 * fixtures mode as an automatic yes — the offline run and the demo have nobody to ask — so the
 * ordinary blocking branch cannot be reached with `MM_FIXTURES=1` at all. The watched-source
 * branch is the one that blocks in *every* mode, by design and for the right reason: an import
 * nobody asked for by hand must be decided by the source's own policy, and auto-accept is off
 * unless somebody turns it on. That is the same gate, reached honestly.
 *
 * (`services/confirm.integration.test.ts` covers the ordinary branch, with fixtures off, and
 * the `awaiting_confirm` Inbox item it raises.)
 */

const SOURCE_URL = "fixture://watched?snapshot=1&spec=confirm";

test.describe("confirming an import from the Console", () => {
  test("a watched source's import waits, the job page says yes, and the decision is signed", async ({
    page,
  }) => {
    await signIn(page);

    /* ---- a watched source with auto-accept off, which is the default -------- */

    await reloadUntil(page, "/sources", async () => {
      await expect(page.getByTestId("source-add")).toBeVisible({ timeout: 15_000 });
    });
    await typeInto(page.getByTestId("source-url"), SOURCE_URL);
    await typeInto(page.getByTestId("source-label"), "Confirm spec");
    await page.getByTestId("source-add-submit").click();

    const row = page.getByTestId("sources-table").locator("tr").filter({ hasText: "Confirm spec" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Off unless somebody says otherwise — `docs/04` § Ce que l'algo ne fait jamais. It is what
    // makes the import below stop and ask.
    await expect(row).toContainText("off");

    await row.getByTestId(/^source-scan-/).click();
    await expect(page.getByTestId("toaster")).toContainText(/scan/i, { timeout: 120_000 });

    /* ---- the import it opened is parked, waiting for a person --------------- */

    // `/imports` is a loader page, and the worker needs a moment to match; re-navigate rather
    // than stare at a photograph (see `reloadUntil`).
    await reloadUntil(page, "/imports?status=awaiting_confirm", async () => {
      await expect(page.getByTestId("jobs-table")).toContainText("Needs confirm", {
        timeout: 8_000,
      });
    });
    await page.getByTestId("jobs-table").locator("tbody tr").first().click();
    await page.waitForURL(/\/imports\/imp_/, { timeout: 60_000 });
    const importId = /\/imports\/(imp_[^/?]+)/.exec(page.url())?.[1] ?? "";
    expect(importId).not.toBe("");

    await expect(page.getByTestId("job-status")).toContainText("Needs confirm");

    /* ---- what the page offers now ------------------------------------------ */

    // The callout says why it is stopped and puts the wizard one link away, so "the proposal is
    // wrong" has an answer that is not Cancel.
    const callout = page.getByTestId("awaiting-confirm");
    await expect(callout).toBeVisible();
    await expect(page.getByTestId("job-confirm-choose")).toHaveAttribute(
      "href",
      new RegExp(`importId=${importId}`),
    );

    /* ---- and the one that was missing entirely ------------------------------ */

    await page.getByTestId("job-confirm").click();
    await expect(page.getByTestId("toaster")).toContainText(/Confirmed/, { timeout: 120_000 });

    // It left the gate: the job is no longer waiting for anybody.
    await expect(page.getByTestId("job-status")).not.toContainText("Needs confirm", {
      timeout: 120_000,
    });

    const job = await readImport(importId);
    expect(job?.status).not.toBe("awaiting_confirm");
    // `assertSigned`: the gate cannot be opened anonymously, and the Console names itself.
    expect(job?.options["autoConfirm"]).toBe(true);
    expect(job?.options["confirmedBy"]).toBe("console");

    /* ---- the audit trail, which is what a confirmation *is* ----------------- */

    await expect(async () => {
      const decisions = await readDecisions(importId);
      const release = decisions.filter((entry) => entry.kind === "release");
      expect(release, "confirming wrote no decision").not.toHaveLength(0);
      // Never `user`, never `cli --yes (unsigned)`, never `watched-source`: the trail has to be
      // able to answer "which of my albums did nobody look at?" with one query.
      expect(release.map((entry) => entry.decidedBy)).toContain("console");
    }).toPass({ timeout: 120_000, intervals: [500, 1_000, 2_000] });
  });
});
