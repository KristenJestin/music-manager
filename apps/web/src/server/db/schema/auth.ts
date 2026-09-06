/**
 * Better Auth's four tables (`docs/06-stack.md`, `docs/phases/P06-web-coeur.md`).
 *
 * These are hand-written rather than produced by `npx auth generate`, for the same reason
 * every other table in this app is hand-written: **Drizzle is the sole owner of the schema**
 * (`CLAUDE.md`), and a generator that writes a second schema file would break that. What is
 * below is field-for-field what `@better-auth/core`'s `getAuthTables()` declares for the
 * default configuration with `emailAndPassword` — verified against the installed 1.7.2, not
 * transcribed from a tutorial. `advanced.database.validateSchema` re-checks it at boot, so a
 * drift between this file and the library is a startup error rather than a 500 in a month.
 *
 * Two things are easy to get wrong and worth stating:
 *
 *  - **The property names are Better Auth's field names, the column names are ours.** The
 *    Drizzle adapter looks a field up as `schema[model][fieldName]`, and its field names are
 *    camelCase; the SQL columns stay snake_case like every other table here.
 *  - **`account.issuer` is `NOT NULL` and part of a unique index with `accountId`.** It is new
 *    in 1.7 and it is what separates a local credential (`local:credential`) from a future
 *    OAuth account. Leaving it out makes every sign-up fail on insert.
 *
 * The table is called `user` — a reserved word in SQL, which Drizzle quotes. Keeping Better
 * Auth's default names is what lets the library's own migrator and diagnostics recognise it.
 */
import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** The single administrator of this installation, and whoever P08 adds after them. */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * One signed-in browser.
 *
 * `token` is what the cookie carries; the row is the authority, so signing out or deleting a
 * user really does end the session rather than merely asking the browser to forget it.
 */
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Better Auth supplies this on every write; the default is insurance, not decoration.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

/** How a user proves who they are. For email + password, one row with the scrypt hash. */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    /** `local:credential` for a password; `local:oauth:<provider>` when P08 adds one. */
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** The password hash. Never selected into anything that reaches the browser. */
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("account_issuer_account_id_idx").on(table.issuer, table.accountId),
    index("account_user_id_idx").on(table.userId),
  ],
);

/** Short-lived tokens: email verification, password reset. Unused today, required by the library. */
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export type AuthUser = typeof user.$inferSelect;
export type AuthSession = typeof session.$inferSelect;
