import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { ErrorScreen, NotFoundScreen } from "#/components/error-screen.tsx";
import { SkeletonFallback } from "#/components/skeleton.tsx";
import { routeTree } from "./routeTree.gen";

/**
 * How long the previous page is allowed to stay on the glass before its replacement is drawn
 * as a skeleton.
 *
 * TanStack's own default is **1000 ms**, and that is the whole of the complaint this pair of
 * numbers answers: a click on Library with 600 albums behind it left the page you were leaving
 * up for a second before anything acknowledged the click, and longer than that when the loader
 * was genuinely slow. 150 ms is past the ~100 ms at which a transition still reads as
 * instantaneous, so the many navigations this app already serves from `defaultPreload:
 * "intent"` or from a warm loader still swap straight to content and never flash a grey page;
 * anything slower than that has stopped feeling like a click and needs an answer.
 */
const PENDING_MS = 150;

/**
 * And how long it stays once it is up.
 *
 * `pendingMinMs` starts counting when the skeleton has actually rendered, so this is the floor
 * on *seeing* one. 400 ms is roughly the shortest flash that does not read as a glitch: below
 * it the eye catches a grey frame and loses the thread, which is worse than the wait it was
 * meant to explain. Together the two mean a loader is either invisible (under 150 ms) or
 * answered by a skeleton held long enough to be read as one — never a strobe in between.
 */
const PENDING_MIN_MS = 400;

/**
 * The router, and the defaults that stop a failed loader from taking the document with it.
 *
 * `errorComponent` is **per route** in TanStack Router: a route that does not declare one does
 * not fall back to its parent's, it falls back to `defaultErrorComponent` — and the built-in
 * default is the full-page *"Something went wrong!"* panel. That is the mechanism behind the
 * incident of 2026-09-08 (decision 165): thirty routes, none of them declaring anything, so a
 * transient MusicBrainz 503 in the wizard's loader replaced the whole Console.
 *
 * Setting it here is what makes the property hold for every route rather than for the ones
 * somebody remembered. The panel it renders is *inside* the failing route's own boundary, so
 * for anything under `/_app` it appears in the shell's `<Outlet />` with the sidebar, the top
 * bar and the breadcrumbs still there. `_app.tsx` and `__root.tsx` declare their own on top of
 * this, for the two cases a child's boundary cannot cover: their own loaders failing.
 */
export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: ({ error }: { error: unknown }) => <ErrorScreen error={error} />,
    defaultNotFoundComponent: NotFoundScreen,
    /*
     * The pending contract, set here for the same reason `defaultErrorComponent` is: a route
     * that declares nothing falls back to the *router's* default, never to its parent's. Every
     * `_app` route declares a skeleton of its own shape; `SkeletonFallback` is what a route
     * added later gets before anyone remembers to draw it one, which is strictly better than
     * the old behaviour of showing the previous page for a second and a half.
     *
     * Note that a route which already holds data does **not** go pending on a revisit: a stale
     * loader re-runs in the background (`defaultStaleReloadMode: "background"`), so the rows
     * you saw last time are on screen instantly and refresh under you. The skeleton is for the
     * navigation that genuinely has nothing to show.
     */
    defaultPendingComponent: SkeletonFallback,
    defaultPendingMs: PENDING_MS,
    defaultPendingMinMs: PENDING_MIN_MS,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
