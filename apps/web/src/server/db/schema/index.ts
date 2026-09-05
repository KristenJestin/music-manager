import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Drizzle is the single owner of the database schema (see ../../../../../docs/06-stack.md).
 * P00 ships one placeholder table so that a real migration exists and `db:migrate` is proved.
 * The business tables arrive in P03.
 */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppMeta = typeof appMeta.$inferSelect;
export type NewAppMeta = typeof appMeta.$inferInsert;
