/**
 * The single administrator (`docs/phases/P06-web-coeur.md`).
 *
 * There is exactly one account. It comes from `MM_ADMIN_EMAIL` / `MM_ADMIN_PASSWORD` on first
 * boot, and when those are absent the app serves `/setup` once so the first person to reach
 * the port can create it — a self-hosted app that refuses to start because an environment
 * variable is missing is a worse experience than one that asks.
 *
 * The properties that make this safe to run on every boot:
 *
 *  - **It is idempotent.** Once any user exists, `ensureAdmin()` does nothing at all. It never
 *    resets a password from the environment, because a `docker-compose.yml` that still holds
 *    the original password would otherwise silently undo a password change.
 *  - **The window closes.** `/setup` answers only while the table is empty; afterwards it
 *    redirects to `/login`. There is no moment where an empty database is reachable *and* the
 *    rest of the app is.
 *  - **Sign-up stays disabled either way.** Both paths create the account through Better
 *    Auth's internal adapter rather than through the public endpoint, so the endpoint can
 *    remain closed (`emailAndPassword.disableSignUp`).
 */
import { count } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { user } from "#/server/db/schema/auth.ts";
import { serverEnv } from "#/server/env.ts";
import { buildAuth, type Auth } from "#/server/auth/auth.ts";

/**
 * A private instance with sign-up open, used only here.
 *
 * The alternative would be to reimplement password hashing and the `account` row against the
 * schema — a second, worse copy of the only security-critical code in the app. This way the
 * library still owns it, and the endpoint the browser can actually reach stays closed.
 */
let signUpAuth: Auth | undefined;
function bootstrapAuth(database: Database): Auth {
  signUpAuth ??= buildAuth({ db: database, allowSignUp: true });
  return signUpAuth;
}

/** How many accounts exist. Zero means the setup page is the only page. */
export async function countUsers(database: Database = defaultDb()): Promise<number> {
  const [row] = await database.select({ total: count() }).from(user);
  return row?.total ?? 0;
}

/** True when nobody has an account yet. */
export async function needsSetup(database: Database = defaultDb()): Promise<boolean> {
  return (await countUsers(database)) === 0;
}

export interface CreateAdminInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

/**
 * Create the administrator.
 *
 * Goes through `auth.api.signUpEmail` with `disableSignUp` bypassed internally — Better Auth
 * owns password hashing, the `account` row and its `issuer`, and reimplementing any of that
 * here would be a second, worse implementation of the only security-critical code in the app.
 */
export async function createAdmin(
  input: CreateAdminInput,
  database: Database = defaultDb(),
): Promise<{ userId: string }> {
  if (!(await needsSetup(database))) {
    throw new MMError("INVALID_INPUT", "An account already exists.", {
      hint: "Sign in instead, or reset the database.",
      action: "Sign in",
      status: 409,
    });
  }
  if (input.password.length < 8) {
    throw new MMError("INVALID_INPUT", "The password must be at least 8 characters.", {
      action: "Choose a longer password",
      status: 400,
    });
  }

  const created = await bootstrapAuth(database).api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.name ?? "Administrator",
    },
  });
  return { userId: created.user.id };
}

/**
 * The bootstrap, memoised as a **promise** rather than as a boolean.
 *
 * A flag set before the insert completes is a race, and a race with a visible symptom: the
 * first page load of a fresh container is several `beforeLoad`s at once, the first one starts
 * creating the administrator, the others see "already bootstrapped", ask `needsSetup()` while
 * the row is still being written, get `true`, and redirect to `/setup` — on an installation
 * that is being set up as they ask. Holding the promise makes every concurrent caller wait for
 * the same answer, which is what "once per process" was always supposed to mean.
 */
let bootstrapping: Promise<void> | undefined;

/**
 * Create the administrator from the environment, once per process.
 *
 * Called from a server function rather than from a module top level: it needs the database,
 * and importing a module must never open a socket (`db/client.ts`).
 */
export async function ensureAdmin(database: Database = defaultDb()): Promise<void> {
  bootstrapping ??= bootstrap(database);
  await bootstrapping;
}

async function bootstrap(database: Database): Promise<void> {
  const env = serverEnv();
  if (env.MM_ADMIN_EMAIL === "" || env.MM_ADMIN_PASSWORD === "") return;
  if (!(await needsSetup(database))) return;

  try {
    await createAdmin(
      { email: env.MM_ADMIN_EMAIL, password: env.MM_ADMIN_PASSWORD, name: "Administrator" },
      database,
    );
    console.info(`auth: created the administrator account ${env.MM_ADMIN_EMAIL}.`);
  } catch (error) {
    // A racing second process, or a bad value. Neither should stop the server from booting;
    // `/setup` and `/login` both still say something useful.
    console.warn(
      `auth: could not bootstrap the administrator (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** Test helper: allow `ensureAdmin` to run again. */
export function resetBootstrap(): void {
  bootstrapping = undefined;
  signUpAuth = undefined;
}
