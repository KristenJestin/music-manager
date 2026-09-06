import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

/**
 * Settings: the round trip, and the two things this page must not get wrong.
 *
 * The round trip is the point — a value typed here has to survive a reload, because a settings
 * page that appears to save is worse than one that refuses to. The two hazards are the path
 * template (a preview that disagreed with `place` would be decoration) and the credentials (a
 * masked key echoed back must be read as "leave it alone", or opening the page and pressing
 * Save would wipe your keys).
 */
test.describe("settings", () => {
  test("Library & files: the template preview is live, and a value survives a reload", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/settings/library");
    await expect(page.getByTestId("settings-library")).toBeVisible({ timeout: 60_000 });

    /* ---- the preview follows the template, computed by the real renderer ---- */

    const preview = page.getByTestId("template-preview");
    await expect(preview).toContainText("Daft Punk/Discovery (2001)/01 One More Time.opus");

    await page
      .getByTestId("setting-pathTemplate")
      .fill("{albumArtist}/{album}/{track:03} {title}.{ext}");
    await expect(preview).toContainText("Daft Punk/Discovery/001 One More Time.opus", {
      timeout: 30_000,
    });

    // A template with a typo is refused with a reason, and Save is blocked rather than
    // writing a literal `{albumartist}` into every folder name.
    await page.getByTestId("setting-pathTemplate").fill("{albumartist}/{title}.{ext}");
    await expect(page.getByTestId("template-error")).toContainText("unknown token", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("settings-save")).toBeDisabled();

    // A template that would give every track of an album the same name is refused too.
    await page.getByTestId("setting-pathTemplate").fill("{album}/{track:02}.{ext}");
    await expect(page.getByTestId("template-error")).toContainText("{title}", { timeout: 30_000 });

    /* ---- the round trip ---------------------------------------------------- */

    await page
      .getByTestId("setting-pathTemplate")
      .fill("{albumArtist}/{album} ({year})/{disc-}{track:02} {title}.{ext}");
    await expect(page.getByTestId("template-error")).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId("setting-maxSegmentLength").fill("180");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId("setting-maxSegmentLength")).toHaveValue("180");

    // Put it back, so the rest of the suite files things where it expects to find them.
    await page.getByTestId("setting-maxSegmentLength").fill("200");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });
  });

  test("Metadata & matching: the tag map, the schema, and a value that round-trips", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/settings/metadata");
    await expect(page.getByTestId("settings-metadata")).toBeVisible({ timeout: 60_000 });

    /* ---- the tag map is the domain's table, filtered ----------------------- */

    const tagMap = page.getByTestId("settings-tag-map");
    await expect(tagMap).toBeVisible();
    const superset = await tagMap.locator("tbody tr[data-testid^='tag-row-']").count();
    expect(superset).toBeGreaterThan(50);

    // The format switcher changes the key column, not the rows.
    await expect(tagMap.getByRole("columnheader", { name: "Vorbis" })).toBeVisible();
    await page.getByTestId("tagmap-format").getByRole("button", { name: "ID3v2.4" }).click();
    await expect(tagMap.getByRole("columnheader", { name: "ID3v2.4" })).toBeVisible();
    expect(await tagMap.locator("tbody tr[data-testid^='tag-row-']").count()).toBe(superset);

    // A consumer profile is a strict subset, and says so above the table.
    await page
      .getByTestId("tagmap-profile")
      .getByRole("button", { name: /Navidrome/ })
      .click();
    const filtered = await tagMap.locator("tbody tr[data-testid^='tag-row-']").count();
    expect(filtered).toBeLessThan(superset);
    await expect(page.getByText("This filter changes the view, not the files.")).toBeVisible();

    /* ---- the round trip ---------------------------------------------------- */

    await page.getByTestId("setting-maxGenres").fill("4");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });
    await page.reload();
    await expect(page.getByTestId("setting-maxGenres")).toHaveValue("4");

    await page.getByTestId("setting-maxGenres").fill("3");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });
  });
});
