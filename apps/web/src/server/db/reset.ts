/**
 * Drop and recreate schema `public`, then re-apply every migration.
 * Run with `bun run db:reset` from the repository root.
 *
 * This never touches the Docker volume, so Navidrome and the music library are untouched.
 */
import postgres from "postgres";
import { serverEnv } from "#/server/env.ts";

const { DATABASE_URL } = serverEnv();
const sql = postgres(DATABASE_URL, { max: 1 });

try {
  // `drizzle` holds the migration journal and `pgboss` the queues. Dropping `public` alone
  // leaves the journal claiming every migration is applied, so the next `db:migrate` does
  // nothing and the database comes back empty — which looks exactly like a broken schema.
  await sql.unsafe(
    "DROP SCHEMA IF EXISTS public CASCADE;" +
      "DROP SCHEMA IF EXISTS drizzle CASCADE;" +
      "DROP SCHEMA IF EXISTS pgboss CASCADE;" +
      "CREATE SCHEMA public;",
  );
  console.log("schemas public, drizzle and pgboss dropped; public recreated");
} finally {
  await sql.end();
}

await import("./migrate.ts");
