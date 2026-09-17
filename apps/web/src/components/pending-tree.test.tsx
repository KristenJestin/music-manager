// @vitest-environment happy-dom
/**
 * A page's two trees, in one document, sharing nothing.
 *
 * Since the toolbars stopped being drawn as grey blocks, a route's `pendingComponent` and its
 * `component` render the *same* controls, and React keeps both mounted for the length of a
 * re-suspend — the second navigation inside one route, `/library?filter=all` →
 * `?filter=untagged`, which is a click on a preset. Two copies of `library-search` in the
 * document is two focusable boxes with one accessible name, and every query for "the search
 * box" resolving to a thing that is on screen and a thing that is not.
 *
 * So this renders the settled toolbar and the pending one together, exactly as the transition
 * does, and asserts that **no `data-testid` occurs twice**. The suffix is not spelled out in
 * the assertion on purpose: the property is the disjointness, and `pending-tree.tsx` owns how
 * it is obtained.
 *
 * It fails in the obvious way a future change breaks it. Write `data-testid="filter-add"` as a
 * literal anywhere under `FilterToolbar` — which is how `filter-bar.tsx` had it — and the two
 * trees collide here before anything reaches a browser.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FilterToolbar } from "#/components/library/filter-toolbar.tsx";
import { PENDING_TEST_ID_SUFFIX } from "#/components/pending-tree.tsx";
import { SkeletonPage, SkeletonTable } from "#/components/skeleton.tsx";
import { Toggle } from "#/components/settings/controls.tsx";
import { ALBUM_FILTER_FIELDS } from "#/lib/filters/index.ts";

afterEach(cleanup);

/** Two conditions, so the chips, the join and the clear button are all in the tree. */
const CONDITIONS = "year:gte:2000;hasCover:is:true";

/**
 * `/library`'s toolbar, to the identifier.
 *
 * Not the route's own function — importing a route module would drag `server/**` into a unit
 * test, which `client-boundary.guard.test.ts` exists to forbid — but every component it is
 * built from, with the identifiers that page really uses. The per-page ids the route writes
 * itself (`library-sort`, `quality-profile`, `source-url`) are covered by the source-level
 * half of this guard, in `route-skeletons.guard.test.ts`.
 */
function Toolbar({ counts }: { readonly counts: number | null }) {
  return (
    <FilterToolbar
      search={{
        value: "",
        onSubmit: () => undefined,
        label: "Search albums",
        testId: "library-search",
      }}
      conditions={{
        fields: ALBUM_FILTER_FIELDS,
        value: CONDITIONS,
        onChange: () => undefined,
        testId: "album-filter-bar",
      }}
      presets={{
        chips: [
          { value: "all", label: "All", count: counts },
          { value: "untagged", label: "Untagged", count: counts },
        ],
        active: "all",
        testId: "library-filters",
        link: () => ({ to: "/" }),
      }}
    >
      <Toggle
        testId="library-toggle"
        label="A trailing control"
        checked={false}
        onChange={() => undefined}
      />
    </FilterToolbar>
  );
}

/** The settled page, and the pending tree of the same page, at the same instant. */
function Overlap() {
  return (
    <>
      <Toolbar counts={12} />
      <SkeletonPage name="guard" label="Loading the guard's page…">
        <Toolbar counts={null} />
        <SkeletonTable columns={["w-1/3", "w-20"]} rows={2} />
      </SkeletonPage>
    </>
  );
}

/**
 * A router, because the presets are `<Link>`s and a link needs one.
 *
 * A two-route memory tree of its own rather than the app's: `routeTree.gen.ts` is generated
 * and gitignored, and loading it here would pull every route — and therefore every server
 * function — into a unit test.
 */
async function renderOverlap(): Promise<void> {
  const root = createRootRoute({});
  const index = createRoute({ getParentRoute: () => root, path: "/", component: Overlap });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render((<RouterProvider router={router} />) as ReactNode);
  await screen.findByTestId("page-skeleton");
}

/** Every `data-testid` in the document, in order, duplicates included. */
function testIds(): readonly string[] {
  return Array.from(document.querySelectorAll("[data-testid]"), (node) =>
    node.getAttribute("data-testid"),
  ).filter((id): id is string => id !== null);
}

describe("a route's pending tree and its settled tree", () => {
  it("renders both, so the assertion below has two trees to compare", async () => {
    await renderOverlap();
    expect(screen.getByTestId("page-skeleton")).toBeDefined();
    // The settled copy keeps the plain id. That is the property that makes a browser spec
    // stable under load: it never has to know a pending state exists.
    expect(screen.getByTestId("library-search")).toBeDefined();
    expect(screen.getByTestId("filter-add")).toBeDefined();
    expect(screen.getByTestId("library-filters-untagged")).toBeDefined();
  });

  it("shares no data-testid between them", async () => {
    await renderOverlap();
    const ids = testIds();
    const twice = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    expect(
      twice,
      "these identifiers name two elements at once during a pending→settled transition",
    ).toEqual([]);
  });

  it("carries every one of the settled identifiers into the pending tree", async () => {
    await renderOverlap();
    const ids = testIds();
    const pending = ids.filter((id) => id.endsWith(PENDING_TEST_ID_SUFFIX));
    const settled = ids.filter((id) => !id.endsWith(PENDING_TEST_ID_SUFFIX));

    // Disjointness is cheap to get by dropping the ids altogether, and that would be the wrong
    // answer: the pending toolbar is the copy a person types into while the loader runs, and
    // `e2e/route-skeletons.spec.ts` has to be able to name it. So the pending tree must hold
    // the same set, suffixed — plus `page-skeleton`, which exists in that tree and no other.
    expect(new Set(pending.map((id) => id.slice(0, -PENDING_TEST_ID_SUFFIX.length)))).toEqual(
      new Set(settled.filter((id) => id !== "page-skeleton")),
    );
    expect(pending.length).toBeGreaterThan(5);
  });
});
