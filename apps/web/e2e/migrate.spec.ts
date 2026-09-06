import { expect, test } from "@playwright/test";
import { signIn, typeInto } from "./helpers.ts";

/**
 * Tools › Migrate from v1 — the Console side of P11.
 *
 * The *migration* itself is proved by `bun run e2e-migrate`, which builds a whole v1
 * installation out of fixtures and takes it over. What this spec is for is the half that only
 * a browser can check, and all three of its properties are ones a user would notice:
 *
 *  - **the gate holds.** "Migrate" cannot be pressed until somebody has said they have a
 *    backup. A migration rewrites the tags of every file in a library; the confirmation is the
 *    only thing standing between a mis-click and that;
 *  - **the warning appears with the flag that earns it.** `--rename-to-template` loses
 *    Navidrome's play counts, and the card says so at the moment the box is ticked, not in a
 *    document nobody read;
 *  - **the secret never comes back.** The connection string goes to the server and what the
 *    page shows afterwards is the redacted label. This spec queues a run with a password in the
 *    URL and then asserts the password is nowhere in the page — which is the sort of thing that
 *    is easy to get right once and lose in the next refactor.
 *
 * The queued run is deliberately pointed at a database that does not exist. It fails, and a
 * failure is the cheapest way to exercise the whole chain — server function, pg-boss, the
 * worker's handler, the run row, the report — without a v1 database in the browser stack.
 */

/** A connection string with an unmistakable password, to a database that is not there. */
const V1_URL = "postgres://mm:s3cr3t-not-a-real-password@localhost:5432/mm_v1_does_not_exist";
const PASSWORD = "s3cr3t-not-a-real-password";

test.describe("migrate from v1", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/tools");
    await expect(page.getByRole("heading", { name: /Tools/ })).toBeVisible({ timeout: 60_000 });
  });

  test("the card is on the Tools page, with its form", async ({ page }) => {
    const card = page.getByTestId("tools-migrate");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText("Migrate from v1");
    await expect(page.getByTestId("migrate-db")).toBeVisible();
    await expect(page.getByTestId("migrate-library")).toBeVisible();
    // The library defaults to the v2 root, because keeping the v1 paths means the two are the
    // same directory.
    await expect(page.getByTestId("migrate-library")).not.toHaveValue("");
  });

  test("the connection string is a password field, not a visible one", async ({ page }) => {
    await expect(page.getByTestId("tools-migrate")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("migrate-db")).toHaveAttribute("type", "password");
  });

  test("Migrate stays disabled until a backup is confirmed", async ({ page }) => {
    await expect(page.getByTestId("tools-migrate")).toBeVisible({ timeout: 60_000 });
    await typeInto(page.getByTestId("migrate-db"), V1_URL);

    const run = page.getByTestId("migrate-run");
    const preview = page.getByTestId("migrate-preview");

    // A dry run writes nothing, so it never needs the confirmation.
    await expect(preview).toBeEnabled();
    await expect(run).toBeDisabled();

    await page.getByTestId("migrate-backup").check();
    await expect(run).toBeEnabled();
  });

  test("ticking rename shows what renaming costs", async ({ page }) => {
    await expect(page.getByTestId("tools-migrate")).toBeVisible({ timeout: 60_000 });
    const card = page.getByTestId("tools-migrate");
    await expect(card).not.toContainText("Replay the migration on a copy");

    await page.getByTestId("migrate-rename").check();
    await expect(card).toContainText("play counts");
    await expect(card).toContainText("Replay the migration on a copy");
  });

  test("a queued preview reaches the worker, and the password never comes back", async ({
    page,
  }) => {
    await expect(page.getByTestId("tools-migrate")).toBeVisible({ timeout: 60_000 });
    await typeInto(page.getByTestId("migrate-db"), V1_URL);
    await page.getByTestId("migrate-preview").click();

    // The worker picks the job up, fails to reach a database that is not there, and records
    // the run. The card polls itself when the stream says the run is over.
    const report = page.getByTestId("migrate-report");
    await expect(report).toBeVisible({ timeout: 120_000 });
    await expect(report).toContainText("Last preview");

    // The whole point: the label is redacted, and the real password is nowhere on the page.
    await expect(report).toContainText("***");
    await expect(report).not.toContainText(PASSWORD);
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body.includes(PASSWORD.toLowerCase())).toBe(false);
  });
});
