import { expect, test, reloadUntil, signIn } from "./helpers.ts";

/**
 * A failed job is a question — DRIVE-1 §A3.
 *
 * `job_failed` was in the enum, in `docs/04` § Inbox and in the options test, and no producer
 * existed: two failed jobs left `/review` saying "Nothing to decide" and the NEEDS YOU tile at
 * zero. A failure was discoverable only by walking the Jobs list, which is the one place a
 * person does not look when they are not already suspicious.
 *
 * The failure is provoked honestly: a `fixture://` URL that names nothing. The toolbox refuses
 * it, `resolve` fails with a decoded error, and everything after that is the Console's.
 */
test.describe("a job that fails", () => {
  test("lands in the Inbox with Retry and Cancel, and Cancel cancels it", async ({ page }) => {
    await signIn(page);

    const url = `fixture://no-such-fixture-${String(Date.now())}`;
    await page.goto(`/import/new?url=${encodeURIComponent(url)}`);
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    const importId = new URL(page.url()).searchParams.get("importId") ?? "";
    expect(importId).not.toBe("");

    /* ---- the Inbox knows, without anybody opening the Jobs list ----------- */

    await reloadUntil(page, "/review", async () => {
      await expect(page.getByTestId("review-list")).toContainText("job failed");
    });

    const card = page.getByTestId("review-card");
    await expect(card).toContainText("resolve");
    // The decoded code, not "UNKNOWN" over a developer's sentence (the C2 bug of the drive).
    await expect(card).toContainText(/[A-Z_]{4,}/);

    // The two answers a failure has, and "Later" — never "Accept the proposed answer".
    await expect(card.getByTestId("review-option")).toHaveCount(3);
    await expect(card.locator('[data-option-id="retry"]')).toContainText("Retry");

    /* ---- Cancel actually cancels ----------------------------------------- */

    await card.locator('[data-option-id="cancel"]').click();
    await page.getByTestId("review-confirm").click();
    await expect(page.getByTestId("review-empty")).toBeVisible({ timeout: 60_000 });

    await reloadUntil(page, `/imports/${importId}`, async () => {
      await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    });
  });
});
