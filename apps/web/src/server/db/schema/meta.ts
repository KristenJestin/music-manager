/**
 * P00's placeholder table, kept as it was.
 *
 * It exists so that a real migration existed before there was a real schema. P03 leaves it
 * alone rather than dropping another phase's table: it costs one row of DDL and it keeps
 * `drizzle/0000_*.sql` an honest description of what was shipped.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppMeta = typeof appMeta.$inferSelect;
export type NewAppMeta = typeof appMeta.$inferInsert;
