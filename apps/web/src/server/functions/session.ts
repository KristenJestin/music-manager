/**
 * Session and first-run setup.
 *
 * The three public server functions of the app, and the only ones. Each is public for a
 * reason that has to be true before a session can exist:
 *
 *  - `currentSession` answers "am I signed in?", which is the question `/login` and the app
 *    shell both need *before* they know;
 *  - `setupState` says whether an account exists at all, which decides between `/setup` and
 *    `/login`;
 *  - `completeSetup` creates the one account, and refuses the moment there is one.
 */
import { z } from "zod";
import { createAdmin, ensureAdmin, needsSetup } from "#/server/auth/bootstrap.ts";
import { getSession, type AppSession } from "#/server/auth/session.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, toFailure } from "#/server/functions/base.ts";

export interface SetupState {
  readonly needsSetup: boolean;
}

/**
 * Is there an account yet?
 *
 * Runs the environment bootstrap first, so a container started with `MM_ADMIN_EMAIL` set has
 * its administrator by the time the first page renders — and one started without it lands on
 * `/setup` instead. Doing it here rather than at module load keeps "importing a module opens
 * no socket" true.
 */
export const setupState = createServerFn({ method: "GET", strict: STRICT }).handler(
  async (): Promise<SetupState> => {
    try {
      await ensureAdmin();
      return { needsSetup: await needsSetup() };
    } catch (error) {
      return toFailure(error);
    }
  },
);

/** The signed-in user, or `null`. Never throws for a missing session. */
export const currentSession = createServerFn({ method: "GET", strict: STRICT }).handler(
  async (): Promise<AppSession | null> => await getSession(),
);

const setupInput = z.object({
  email: z.email("That is not an email address."),
  password: z.string().min(8, "The password must be at least 8 characters."),
  name: z.string().trim().min(1).max(80).default("Administrator"),
});

/** Create the single administrator. Refuses once one exists. */
export const completeSetup = createServerFn({ method: "POST", strict: STRICT })
  .inputValidator(setupInput)
  .handler(async ({ data }): Promise<{ email: string }> => {
    try {
      await createAdmin({ email: data.email, password: data.password, name: data.name });
      return { email: data.email };
    } catch (error) {
      return toFailure(error);
    }
  });
