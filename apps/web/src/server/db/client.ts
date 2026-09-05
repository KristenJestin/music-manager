import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "#/server/env.ts";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDatabase>;

/** Build a Drizzle client over a postgres-js connection. */
export function createDatabase(url: string = serverEnv().DATABASE_URL, max = 10) {
  return drizzle(postgres(url, { max }), { schema });
}

let cached: Database | undefined;

/**
 * Process-wide client. Lazy so that importing this module never opens a socket —
 * unit tests import the schema without a database.
 */
export function db(): Database {
  cached ??= createDatabase();
  return cached;
}

export { schema };
