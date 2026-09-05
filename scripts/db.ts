/**
 * `bun run db:generate | db:migrate | db:reset`
 *
 * Drizzle owns the schema. `reset` drops and recreates the public schema, then re-applies
 * every migration — it never destroys the Docker volume, so Navidrome and the library are
 * untouched.
 */
import { bunRun, bunx, runSequence, webDir } from "./lib.ts";

type Command = "generate" | "migrate" | "reset";

const command = process.argv[2] as Command | undefined;

const DEFAULT_DATABASE_URL = "postgres://mm:mm@localhost:5432/mm";

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

async function migrate(): Promise<void> {
  await runSequence([
    {
      label: "drizzle migrate",
      cmd: bunRun(webDir, "db:migrate"),
      env: { DATABASE_URL: databaseUrl() },
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
        env: { DATABASE_URL: databaseUrl() },
      },
    ]);
    break;

  default:
    console.error("usage: bun run scripts/db.ts <generate|migrate|reset>");
    process.exit(2);
}
