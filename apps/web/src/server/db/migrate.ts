/**
 * Apply pending Drizzle migrations, then exit. Run with `bun run db:migrate` from the
 * repository root, or `bun run src/server/db/migrate.ts` from `apps/web`.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "#/server/env.ts";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../../drizzle");

const { DATABASE_URL } = serverEnv();
// A migration run is single-shot: one connection, no pooling, closed at the end.
const sql = postgres(DATABASE_URL, { max: 1 });

try {
  await migrate(drizzle(sql), { migrationsFolder });
  console.log(`migrations applied from ${migrationsFolder}`);
} finally {
  await sql.end();
}
