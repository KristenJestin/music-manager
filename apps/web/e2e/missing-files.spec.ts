import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";
import { expect, test, reloadUntil, signIn } from "./helpers.ts";

/**
 * A file that has gone must be visible where the library is read — DRIVE-1 §B5.
 *
 * The previous drive deleted `13 - Wonderland.opus` by hand and the scan reported it
 * correctly; the album still said "13/13 tracks · 50.6 MB" and the track still sat in the list
 * with its `lrc` and `rg` badges and 99%. Only the album's "DB vs files" tab, one click deep on
 * one page, admitted that a file "could not be read". The scan knew; the views did not.
 *
 * The file is **put back** at the end and the library re-scanned, so the specs that run after
 * this one see the library they expect. That is not politeness: the suite is serial against one
 * database and one library directory, and a spec that leaves a hole in it is a spec that breaks
 * the next four.
 */
function libraryRoot(): string {
  const root = process.env["MM_LIBRARY_ROOT"];
  expect(root, "MM_LIBRARY_ROOT is set by scripts/e2e-web.ts").toBeTruthy();
  return root ?? "";
}

/** The first audio file in the library tree, or `null` when nothing has been imported yet. */
function firstAudioFile(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = firstAudioFile(full);
      if (found !== null) return found;
    } else if (entry.isFile() && entry.name.endsWith(".opus")) {
      return full;
    }
  }
  return null;
}

async function scanAndWait(page: Page): Promise<void> {
  await page.goto("/tools");
  await expect(page.getByTestId("tools-scan")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("scan-now").click();
  await expect(page.getByText(/Scan finished|Scan queued/)).toBeVisible({ timeout: 120_000 });
}

test.describe("a missing file", () => {
  test("is badged on the album, on the track, and filterable on Quality", async ({ page }) => {
    await signIn(page);

    const root = libraryRoot();
    const victim = existsSync(root) ? firstAudioFile(root) : null;
    expect(
      victim,
      `no .opus under ${root} (exists: ${String(existsSync(root))}, entries: ${
        existsSync(root) ? readdirSync(root).join(", ") : "-"
      }): import-album.spec.ts places the album this spec removes a file from, so run the whole suite rather than this file alone`,
    ).not.toBeNull();
    if (victim === null) return;

    const stash = join(mkdtempSync(join(tmpdir(), "mm-missing-")), basename(victim));
    copyFileSync(victim, stash);
    expect(statSync(stash).size).toBeGreaterThan(0);

    try {
      rmSync(victim);
      await scanAndWait(page);

      // Tools already knew this before the fix; it is the baseline the rest is measured against.
      await expect(page.getByTestId("scan-missing")).toContainText(basename(victim));

      /* ---- the grid ------------------------------------------------------- */

      await reloadUntil(page, "/library", async () => {
        await expect(page.getByTestId("album-missing").first()).toBeVisible({ timeout: 5_000 });
      });

      /* ---- the album, and the track inside it ------------------------------ */

      await page.getByTestId("album-card").first().click();
      await expect(page.getByTestId("album-title")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("album-missing")).toContainText("missing");
      await expect(page.getByTestId("track-missing").first()).toBeVisible();

      /* ---- and the Quality page can be worked down by it -------------------- */

      await reloadUntil(page, "/library/quality?filter=missing", async () => {
        await expect(page.getByTestId("quality-filters")).toContainText("Missing files");
        await expect(page.getByTestId("quality-row").first()).toBeVisible({ timeout: 5_000 });
      });
    } finally {
      copyFileSync(stash, victim);
      rmSync(stash, { force: true });
      await scanAndWait(page);
    }

    // The library is as it was found: no badge, and the filter counts nothing.
    await reloadUntil(page, "/library", async () => {
      await expect(page.getByTestId("album-missing")).toHaveCount(0);
    });
  });
});
