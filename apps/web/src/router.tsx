import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { ErrorScreen, NotFoundScreen } from "#/components/error-screen.tsx";
import { routeTree } from "./routeTree.gen";

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
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
