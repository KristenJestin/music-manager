/**
 * `bun run db:generate | db:migrate | db:reset`
 *
 * Drizzle owns the schema. `reset` drops and recreates the public schema, then re-applies
 * every migration — it never destroys the Docker volume, so Navidrome and the library are
 * untouched.
 *
 * The database is resolved from the checkout (`scripts/checkout.ts`), exactly like `dev`,
 * `worker` and `mm`: a worktree gets `mm_<slug>`, never the primary's database. There is no
 * hard-coded fallback on purpose — the one that used to be here
 * (`postgres://mm:mm@localhost:5432/mm`) is how a `db:reset` run from a worktree without
 * `DATABASE_URL` wiped the owner's database on 2026-09-07 (`orchestration/reports/DRIVE-FIX-1.md` §6).
 * With nothing resolvable the command refuses; it never guesses.
 */
import { bunRun, bunx, runSequence, webDir } from "./lib.ts";
import { describeCheckout, devEnv } from "./checkout.ts";

type Command = "generate" | "migrate" | "reset";

const command = process.argv[2] as Command | undefined;

function resolveDatabaseUrl(): string {
  const resolved = devEnv();
  if (resolved.databaseUrl === "") {
    console.error(
      "No DATABASE_URL could be resolved for this checkout. In a worktree it is derived from " +
        "the primary checkout's .env, which is gitignored — make sure it exists. Refusing to " +
        "guess a database.",
    );
    process.exit(1);
  }
  const { checkout } = resolved;
  if (!checkout.isPrimary) {
    const expected = `mm_${checkout.slug.replace(/-/g, "_")}`;
    if (!resolved.databaseUrl.endsWith(`/${expected}`)) {
      console.error(
        `This is worktree "${checkout.slug}", whose database is "${expected}", but DATABASE_URL ` +
          `points elsewhere. Refusing: a worktree never touches another checkout's database. ` +
          `Unset DATABASE_URL, or pin it to ${expected} on purpose.`,
      );
      process.exit(1);
    }
  }
  console.log(describeCheckout(resolved));
  return resolved.databaseUrl;
}

async function migrate(): Promise<void> {
  await runSequence([
    {
      label: "drizzle migrate",
      cmd: bunRun(webDir, "db:migrate"),
      env: { DATABASE_URL: resolveDatabaseUrl() },
    },
  ]);
}

switch (command) {
  case "generate":
    await runSequence([
      { label: "drizzle-kit generate", cmd: bunx("drizzle-kit", "generate"), cwd: webDir },
    ]);
    break;

  case "migrate":
    await migrate();
    break;

  case "reset":
    await runSequence([
      {
        label: "drizzle reset",
        cmd: bunRun(webDir, "db:reset"),
        env: { DATABASE_URL: resolveDatabaseUrl() },
      },
    ]);
    break;

  default:
    console.error("usage: bun run scripts/db.ts <generate|migrate|reset>");
    process.exit(2);
}
