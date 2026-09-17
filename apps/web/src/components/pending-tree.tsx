/**
 * Which of a route's **two** trees a control is rendering in.
 *
 * ## The defect this exists to remove
 *
 * A route in TanStack Router has a `component` and a `pendingComponent`, and the second is
 * handed to React as a `Suspense` *fallback* (`@tanstack/react-router`'s `Match`). Since the
 * toolbars stopped being drawn as grey blocks, both trees render the *same* real controls —
 * the search box, the `+ Filter` popover, the preset links, the sort and profile selects, the
 * "watch a URL" card — because none of them depends on the loader and all of them are built
 * from the URL.
 *
 * React's rule for a boundary that re-suspends after it has already shown content is that the
 * settled children stay mounted and are hidden with `display: none` while the fallback is on
 * screen. So for the length of a *second* navigation inside the same route —
 * `/library?filter=all` → `/library?filter=untagged`, which changes the loader's deps and
 * therefore goes pending — **both trees are in the document**. Measured, not assumed: the
 * sequence of states is `settled visible` → `settled hidden + pending visible` → `settled
 * visible`.
 *
 * One of them is invisible, so only one is clickable and only one is in the accessibility
 * tree. What `display: none` does *not* do is remove an element from a query: every
 * `document.querySelector`, every `getByTestId`, every "the page's search box" anyone writes
 * resolves to two elements, half of them stale. That is a duplicated control with a duplicated
 * accessible name sitting in the document, and the browser tests were simply the first reader
 * to trip over it (`strict mode violation: resolved to 2 elements`).
 *
 * ## The rule
 *
 * **The settled copy keeps the plain `data-testid`; the pending copy is suffixed.** A page's
 * search box is `library-search` when it is the page, and `library-search-pending` while it is
 * the fallback. Nothing outside this module has to know a pending state exists, which is the
 * property that makes a spec stable under load: `getByTestId("library-search")` names one
 * element at every instant of the transition, and it is always the live one.
 *
 * It is a suffix rather than a removal because the pending toolbar is *real* and has to stay
 * testable: it is the copy a person actually types into while the data is in flight, and
 * `e2e/route-skeletons.spec.ts` asserts exactly that. Dropping the ids would have made the one
 * behaviour the split exists for the one behaviour nothing could check.
 *
 * ## Why a context and not a prop
 *
 * Because the ids are not all at the top. `components/library/filter-bar.tsx` writes
 * `filter-add`, `filter-chip-0`, `filter-join` and `filter-clear` three components below the
 * toolbar, and the `+ Filter` popover renders `filter-fields` and `filter-apply` into a portal
 * — out of the pending region's DOM subtree entirely, and still part of its React tree. A prop
 * would have to be threaded through every one of those; a context follows the tree the
 * elements actually belong to, including through the portal, and is read where the attribute
 * is written.
 *
 * ## Two mechanisms that were tried and rejected
 *
 * **`inert` plus `aria-hidden` on the pending copy.** It reads as the obvious answer and it is
 * backwards: while a route is pending the fallback is the *only* tree on screen, so making it
 * inert would disable the very controls the split exists to keep usable, and would do it for
 * the whole of every slow navigation rather than for the overlap. The copy that is stale
 * during the overlap is the settled one, and React has already hidden it.
 *
 * **Rewriting the attributes from the DOM**, with a layout effect or a `MutationObserver` on
 * the pending region. Genuinely one place, and it covers ids nobody remembered to route
 * through a helper — but it cannot cover the portal without following it, it fights React for
 * ownership of an attribute React also writes, and above all it does not exist during SSR: the
 * server streams the fallback's HTML with the plain ids in it, and the swap to the settled
 * content is the one moment where a duplicate is most likely. The suffix has to be part of the
 * render, on both sides of the wire.
 */
import { createContext, useContext, type ReactNode } from "react";

/** What a pending copy's `data-testid` ends with. One spelling, used by the guards too. */
export const PENDING_TEST_ID_SUFFIX = "-pending";

const PendingTreeContext = createContext(false);

/**
 * Marks everything below as a route's pending tree.
 *
 * `SkeletonPage` already wraps every skeleton in one, so a `pendingComponent` built from the
 * shared vocabulary gets this for free; the two pending components that do not use
 * `SkeletonPage` — the shell's and the wizard's — render it themselves.
 */
export function PendingTree({ children }: { readonly children: ReactNode }) {
  return <PendingTreeContext.Provider value={true}>{children}</PendingTreeContext.Provider>;
}

/** Whether this subtree is a route's pending tree rather than its settled one. */
export function useIsPending(): boolean {
  return useContext(PendingTreeContext);
}

/**
 * The `data-testid` to write, given the one the settled page uses.
 *
 * ```tsx
 * const testId = useTestId();
 * <button data-testid={testId("filter-add")} />
 * ```
 *
 * Outside a pending tree it is the identity, so a component that always goes through it is
 * correct in both trees and the call site never has to ask which one it is in.
 *
 * It suffixes at most once. A page hands `Toggle` the plain `source-auto-accept` and `Toggle`
 * is what writes the attribute, but a caller that scopes the id it passes down is making a
 * reasonable mistake — and `source-auto-accept-pending-pending` is a worse failure than the
 * one this module exists to fix, because nothing would ever find it.
 */
export function useTestId(): (id: string | undefined) => string | undefined {
  const pending = useContext(PendingTreeContext);
  return (id) => {
    if (id === undefined || !pending || id.endsWith(PENDING_TEST_ID_SUFFIX)) return id;
    return `${id}${PENDING_TEST_ID_SUFFIX}`;
  };
}
