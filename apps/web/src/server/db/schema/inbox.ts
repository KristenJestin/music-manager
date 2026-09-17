/**
 * The Inbox and the decision log (`docs/04-pipeline-et-matching.md` § Inbox, § Modèle).
 *
 * An Inbox item is a question the pipeline could not answer alone. It always carries a
 * **preselected answer** and its alternatives, because decision 002 is that the algorithm
 * proposes and explains but never chooses. Resolving one writes a `decisions` row, which is
 * what P05 will learn preferences from — visibly, in Settings, never opaquely.
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { decisionKindEnum, inboxStatusEnum, inboxTypeEnum } from "./enums.ts";
import { imports, importTracks } from "./imports.ts";

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    type: inboxTypeEnum("type").notNull(),
    status: inboxStatusEnum("status").notNull().default("open"),
    importId: text("import_id").references(() => imports.id, { onDelete: "cascade" }),
    trackId: text("track_id").references(() => importTracks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary"),
    /** Everything the UI needs to render the question, including the alternatives. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** The answer the algorithm would take if you pressed Enter. */
    preselected: jsonb("preselected").$type<Record<string, unknown>>(),
    resolution: jsonb("resolution").$type<Record<string, unknown>>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inbox_items_status_idx").on(table.status),
    index("inbox_items_type_idx").on(table.type),
    index("inbox_items_import_idx").on(table.importId),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    kind: decisionKindEnum("kind").notNull(),
    importId: text("import_id").references(() => imports.id, { onDelete: "cascade" }),
    inboxItemId: text("inbox_item_id").references(() => inboxItems.id, { onDelete: "set null" }),
    /** What the decision was about: a release MBID, a video id, a setting name. */
    subject: text("subject"),
    choice: jsonb("choice").$type<Record<string, unknown>>().notNull(),
    /** `user`, `cli`, `fixtures`, `auto` — who decided, for the preference learning of P05. */
    decidedBy: text("decided_by").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("decisions_import_idx").on(table.importId),
    index("decisions_kind_idx").on(table.kind),
  ],
);

export type InboxItem = typeof inboxItems.$inferSelect;
export type NewInboxItem = typeof inboxItems.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;

/**
 * "Stop asking about this", remembered on the **subject** rather than on the item.
 *
 * This is the same decision `discover_dismissals` already made, made a second time, and the
 * reasoning transfers verbatim: the memory has to survive a run that no longer proposes the
 * thing at all, and it has to be consultable *before* an item is written. Storing it as a
 * status on the item would make it exactly as durable as the proposal — which is to say, not
 * at all.
 *
 * The Inbox learnt that the hard way. Eleven legitimate duplicates — one recording on an
 * album and on a compilation — were answered "keep both copies" one at a time; the next scan
 * built eleven new `inbox_items` rows, under new ids, asking the same eleven questions. The
 * dismissal had been written on the item, and the item is rebuilt by every scan.
 *
 * `subject` is the stable identity of a *question*, not of a row, and it is deliberately not
 * the same string as `inbox_items.payload.subject`: an item aggregates (two hundred orphan
 * files are one card) while a dismissal is per decision (one path). What goes into the key
 * per type — and therefore what makes a dismissal expire, because a key that no longer
 * matches is a question that comes back — lives in `services/inbox-dismissals.ts`.
 */
export const inboxDismissals = pgTable(
  "inbox_dismissals",
  {
    subject: text("subject").primaryKey(),
    type: inboxTypeEnum("type").notNull(),
    /** What it was, in words, so the Console can list what you have hidden without a scan. */
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("inbox_dismissals_type_idx").on(table.type)],
);

export type InboxDismissal = typeof inboxDismissals.$inferSelect;
export type NewInboxDismissal = typeof inboxDismissals.$inferInsert;
