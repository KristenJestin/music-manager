/**
 * Every Console page draws itself while it loads.
 *
 * The rule this keeps is the one that is easy to *almost* hold: `pendingComponent` is per
 * route in TanStack Router, exactly like `errorComponent` (see `router.tsx`), so a page added
 * next month inherits `defaultPendingComponent` — the generic net — rather than a skeleton of
 * its own shape, and nobody notices until the owner clicks it.
 *
 * Reading the source rather than the route tree on purpose: `routeTree.gen.ts` is gitignored
 * and importing a route module here would drag `server/**` into a unit test, which
 * `client-boundary.guard.test.ts` exists to forbid. A regex over the file is enough for the
 * property being checked, which is "did somebody write it down".
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES = join(import.meta.dirname, "routes");

/** The `_app` route files that have a component at all — API routes have none. */
function pages(): readonly { readonly file: string; readonly source: string }[] {
  return readdirSync(ROUTES)
    .filter((file) => file.startsWith("_app") && file.endsWith(".tsx"))
    .map((file) => ({ file, source: readFileSync(join(ROUTES, file), "utf8") }))
    .filter((entry) => /^\s*component:/m.test(entry.source));
}

describe("every /_app route paints itself while it loads", () => {
  it("finds the pages", () => {
    // A guard whose subject has moved is a guard that passes by accident. The count is a
    // floor, not an equality: adding a page must not have to come here to be allowed.
    expect(pages().length).toBeGreaterThanOrEqual(24);
  });

  it.each(pages().map((entry) => entry.file))("%s declares a pendingComponent", (file) => {
    const source = readFileSync(join(ROUTES, file), "utf8");
    expect(source, `${file} would fall back to the router's generic skeleton`).toMatch(
      /^\s*pendingComponent:/m,
    );
  });

  it("builds each one out of the shared vocabulary", () => {
    // `components/skeleton.tsx` is what sets `role="status"`, `aria-busy`, `data-testid` and
    // the reduced-motion variant, so a pending component that hand-rolls its own markup would
    // silently lose all four. Checked as "names something from that module", which is as far
    // as reading one file can go; the E2E spec checks the contract itself.
    //
    // The wizard is the one exception, and it says why in its own comment: it reports
    // MusicBrainz's request-by-request progress rather than the shape of a page.
    for (const { file, source } of pages()) {
      if (file === "_app.import.new.tsx") continue;
      expect(
        source,
        `${file}'s pending component should come from components/skeleton.tsx`,
      ).toMatch(/Skeleton\w*/);
    }
  });
});
