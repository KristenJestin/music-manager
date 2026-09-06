/**
 * The stack an end-to-end run belongs to — one answer, shared by the four runners.
 *
 * `e2e-web`, `e2e-fixture`, `e2e-verify` and `e2e-migrate` each used to read `process.env`
 * directly and fall back to `v2/`'s own addresses: `postgres://mm:mm@localhost:5432/mm` and
 * `http://localhost:8100`. Bun only loads `.env` from the current directory and `.env` lives
 * in `v2/` alone, so from a worktree those fallbacks were not a fallback at all — they were
 * the answer, and every run reached for **the owner's** toolbox instead of its own.
 *
 * Two consequences, one merely wrong and one destructive:
 *
 *  - `mm-dev-toolbox-1` runs with `fixtures:false`, so the preflight of `e2e-web` failed on a
 *    perfectly good worktree with a message about the toolbox not being in fixtures mode;
 *  - worse, `e2e-fixture` and `e2e-verify` called `docker compose` with the two `-f` files and
 *    **no `-p`**. `docker-compose.dev.yml` declares `name: mm-dev` and bind-mounts
 *    `./.local/library` relative to the file that was read, so that command finds the shared
 *    container *by name* and recreates it mounting the worktree's library — the incident of
 *    `orchestration/reports/P07-verify-1.md` §9, which `CLAUDE.md` names as the one thing a
 *    worktree must never do. It was one `bun run e2e-fixture` away from happening again.
 *
 * So the runners ask here instead, and here asks `checkout.ts`, which is already the single
 * place that knows what this directory resolves to. From `v2/` every value below is what it
 * always was; from a worktree they are that worktree's own, and the compose calls carry `-p`.
 */
import { composeArgs, composeEnv, devEnv } from "./checkout.ts";
import type { Checkout } from "./checkout.ts";

/** Where a database can be created: the server, on a database that certainly exists. */
const FALLBACK_DATABASE_URL = "postgres://mm:mm@localhost:5432/mm";

/**
 * A scratch name no other run on this machine can produce — the process id **and** six random
 * characters.
 *
 * The process id alone was the name, and `mm_web_e2e_<pid>` is a shape another agent can
 * recognise and act on. One did: a sibling verification run tidied up by dropping databases
 * *by pattern* and took this suite's live one with it, mid-run
 * (`../orchestration/reports/P08-P11-verify-1.md` §8; `CLAUDE.md` now forbids deleting
 * anything by pattern). What that looked like from inside was
 * `PostgresError: database "mm_web_e2e_36456" does not exist`, reported through Better Auth as
 * a plain *"Sign-in failed."* on the login page, sixty tests away from its cause.
 *
 * The rule against pattern deletion is the real fix and it belongs in `CLAUDE.md`. This is the
 * belt to go with it, and it also closes a second door: Windows recycles process ids quickly,
 * so a run that ends and one that starts can genuinely claim the same name. Six random
 * characters cost nothing.
 *
 * Lowercase alphanumerics only, because this ends up inside an unquoted SQL identifier and in
 * a directory name.
 */
export const RUN_TAG = `${String(process.pid)}_${Math.random().toString(36).slice(2, 8)}`;

export interface E2EStack {
  readonly checkout: Checkout;
  /**
   * Everything a child process needs, `.env` included, resolved for this checkout. Runners
   * build their own environment **on top of** this rather than on top of `process.env`, so a
   * worktree gets the owner's credentials without inheriting the owner's database.
   */
  readonly env: Record<string, string>;
  /** The postgres server, on a database that exists — used only to `create database`. */
  readonly adminDatabaseUrl: string;
  readonly toolboxUrl: string;
  readonly navidromeUrl: string;
  /** `compose -p <project> -f docker-compose.dev.yml -f docker-compose.fixtures.yml`. */
  readonly compose: readonly string[];
  /** The published ports `docker-compose.dev.yml` interpolates for this checkout. */
  readonly composeEnv: Record<string, string>;
  /**
   * The services this checkout may bring up, out of the ones asked for.
   *
   * Postgres is shared on purpose (`CLAUDE.md`): one server, one database per checkout. A
   * worktree that started `postgres` under its own project would publish a second server on a
   * second port, hold a gigabyte, and contain none of the data its own `DATABASE_URL` names.
   */
  readonly services: (...wanted: readonly string[]) => string[];
}

export function e2eStack(): E2EStack {
  const resolved = devEnv();
  const info = resolved.checkout;
  const admin =
    resolved.adminDatabaseUrl === "" ? FALLBACK_DATABASE_URL : resolved.adminDatabaseUrl;

  return {
    checkout: info,
    env: resolved.env,
    adminDatabaseUrl: admin,
    toolboxUrl: resolved.env["MM_TOOLBOX_URL"] ?? `http://localhost:${String(info.toolboxPort)}`,
    navidromeUrl:
      resolved.env["MM_NAVIDROME_URL"] ?? `http://localhost:${String(info.navidromePort)}`,
    compose: [...composeArgs(info), "-f", "docker-compose.fixtures.yml"],
    composeEnv: composeEnv(info),
    services: (...wanted) => wanted.filter((name) => info.isPrimary || name !== "postgres"),
  };
}

/** One line naming what a run is about to touch, printed before it touches it. */
export function describeStack(stack: E2EStack): string {
  const info = stack.checkout;
  return [
    `checkout ${info.root}${info.isPrimary ? " (primary)" : ""}`,
    `compose project ${info.composeProject}`,
    `toolbox ${stack.toolboxUrl}`,
    `postgres ${stack.adminDatabaseUrl.replace(/:[^:@/]*@/, ":***@")}`,
  ].join("\n  ");
}
