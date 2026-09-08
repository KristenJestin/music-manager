import type { ReactNode } from "react";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { ErrorScreen, NotFoundScreen } from "#/components/error-screen.tsx";

import appCss from "../styles.css?url";

/**
 * The document, and the last boundary before the router's own.
 *
 * `_app.tsx` catches everything inside the Console shell; this catches the rest — `/login`,
 * `/setup`, and any failure of `_app`'s own `beforeLoad`, which runs *above* its
 * `errorComponent` and would therefore escape it. Without both, one of the two halves still
 * ends on TanStack's default panel, which is a blank page with a sentence on it.
 *
 * There is no shell to render here (that is what `_app` is), so the panel gets the page to
 * itself, centred, with the same Retry and the same journal link.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "dark" },
      { title: "Music Manager" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  errorComponent: RootError,
  notFoundComponent: RootNotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Centred({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl items-center px-4">
      <div className="w-full">{children}</div>
    </main>
  );
}

function RootError({ error }: { readonly error: unknown }) {
  return (
    <Centred>
      <ErrorScreen error={error} testId="root-error-screen" />
    </Centred>
  );
}

function RootNotFound() {
  return (
    <Centred>
      <NotFoundScreen />
    </Centred>
  );
}
