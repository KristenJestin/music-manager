/**
 * Typed key/value settings.
 *
 * One row per key, the value as JSONB. The *types* live in
 * `src/server/services/settings.ts`, where a zod schema and a default are declared per key —
 * the database only stores what survived that parse, so a hand-edited row can never make the
 * worker crash somewhere far away.
 */
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  /** Who last wrote it: `default`, `user`, `cli`. */
  setBy: text("set_by").notNull().default("user"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
