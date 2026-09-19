import { useState, type FormEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Music4, UserPlus } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { Callout } from "#/components/callout.tsx";
import { signIn } from "#/lib/auth-client.ts";
import { completeSetup, setupState } from "#/server/functions/session.ts";

/**
 * `/setup` — the one page a fresh installation serves.
 *
 * It exists only while the `user` table is empty, and it redirects to `/login` the moment it
 * is not. That window is the whole of its security model, and it is the same one every
 * self-hosted application with a first-run wizard uses: a database nobody has claimed yet is
 * claimed by whoever reaches it first, and the operator who just ran `docker compose up` is
 * that person. Setting `MM_ADMIN_EMAIL` and `MM_ADMIN_PASSWORD` closes the window before it
 * ever opens.
 */
export const Route = createFileRoute("/setup")({
  beforeLoad: async () => {
    if (!(await setupState()).needsSetup)
      throw redirect({ to: "/login", search: { redirect: "/" } });
  },
  component: Setup,
});

function Setup() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the *button* waits for hydration; see the hook, and the note in login.tsx about why
  // these fields are uncontrolled.
  const hydrated = useHydrated();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completeSetup({ data: { email, password, name: "Administrator" } });
      await signIn.email({ email, password, rememberMe: true });
      window.location.href = "/";
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not create the account.");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-form">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Music4 className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Set up Music Manager</h1>
            <p className="text-xs text-fg-2">Create the single administrator account.</p>
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
              data-testid="setup-email"
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
              data-testid="setup-password"
              type="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="bg-background text-sm"
            />
            <span className="text-2xs text-fg-3">At least 8 characters.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium text-fg-2">Confirm password</span>
            <Input
              data-testid="setup-confirm"
              type="password"
              name="confirm"
              autoComplete="new-password"
              required
              className="bg-background text-sm"
            />
          </label>

          {error === null ? null : (
            <Callout tone="danger" role="alert" data-testid="setup-error">
              {error}
            </Callout>
          )}

          <Button
            type="submit"
            disabled={busy || !hydrated}
            data-testid="setup-submit"
            className="mt-1"
          >
            <UserPlus className="size-4" aria-hidden="true" />
            {busy ? "Creating…" : "Create account"}
          </Button>
        </form>
      </div>
    </main>
  );
}
