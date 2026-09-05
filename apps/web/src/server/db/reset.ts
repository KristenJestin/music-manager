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
  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  console.log("schema public dropped and recreated");
} finally {
  await sql.end();
}

await import("./migrate.ts");
