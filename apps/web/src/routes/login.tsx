import { useState, type FormEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { LogIn, Music4 } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { Callout } from "#/components/callout.tsx";
import { signIn } from "#/lib/auth-client.ts";
import { currentSession, setupState } from "#/server/functions/session.ts";

/**
 * `/login`.
 *
 * The sign-in itself goes through the Better Auth *client*, not through a server function:
 * the library's own endpoint sets the cookie on its own response, which is one round trip and
 * no cookie-forwarding of our own. A server function would have to hand the `Set-Cookie` back
 * through the plugin, which works but is a second way of doing the same thing.
 *
 * The redirect target comes from the search string, so an expired session that interrupted you
 * on `/imports/imp_9f3a` puts you back on `/imports/imp_9f3a`.
 */
export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().default("/") }),
  beforeLoad: async ({ search }) => {
    // A fresh installation has nowhere to sign in to yet.
    if ((await setupState()).needsSetup) throw redirect({ to: "/setup" });
    if ((await currentSession()) !== null) throw redirect({ to: search.redirect });
  },
  component: Login,
});

function Login() {
  const { redirect: target } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the *button* waits for hydration; see the hook, and the note on the fields below.
  const hydrated = useHydrated();

  /*
   * The fields are uncontrolled, and read from the form on submit.
   *
   * A controlled input is bound to React state that starts empty, so anything typed into the
   * server-rendered HTML *before* hydration is wiped by the first client render. That is a
   * real if narrow bug for a person on a slow connection, and a reliable one for a test runner,
   * which types the instant the DOM exists. Uncontrolled inputs keep what was typed, and
   * `FormData` reads it back at the moment it is needed.
   */
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    setBusy(true);
    setError(null);
    const { error: failure } = await signIn.email({ email, password, rememberMe: true });
    setBusy(false);
    if (failure) {
      setError(failure.message ?? "Sign-in failed.");
      return;
    }
    // A full navigation rather than a client one: every loader above needs to run again with
    // the new cookie, and the router has cached "there is no session".
    window.location.href = target.startsWith("/") ? target : "/";
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-form">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Music4 className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Music Manager</h1>
            <p className="text-xs text-fg-2">Sign in to the Console.</p>
          </div>
        </div>

        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="flex flex-col gap-3.5 rounded-lg border border-line bg-surface-1 p-5"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium text-fg-2">Email</span>
            <Input
              data-testid="login-email"
              type="email"
              name="email"
              autoComplete="username"
              required
              className="bg-background text-sm"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium text-fg-2">Password</span>
            <Input
              data-testid="login-password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              className="bg-background text-sm"
            />
          </label>

          {error === null ? null : (
            <Callout tone="danger" data-testid="login-error">
              {error}
            </Callout>
          )}

          <Button
            type="submit"
            disabled={busy || !hydrated}
            data-testid="login-submit"
            className="mt-1"
          >
            <LogIn className="size-4" aria-hidden="true" />
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-2xs text-fg-3">
          One account per installation. Set <code>MM_ADMIN_EMAIL</code> and{" "}
          <code>MM_ADMIN_PASSWORD</code> to create it, or use the setup page on a fresh database.
        </p>
      </div>
    </main>
  );
}
