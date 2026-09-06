/**
 * Webhooks and their deliveries (`docs/phases/P08-api-agents.md` § Webhooks et notifications).
 *
 * Two tables rather than one, for the same reason `job_steps` is separate from `imports`: an
 * endpoint is a *configuration* that lives for months, and a delivery is an *event* that
 * happens hundreds of times and has to be inspectable when somebody says "it never fired".
 * Collapsing them into a `last_error` column on the endpoint answers "is it broken now?" and
 * nothing else.
 *
 * The secret is stored in clear. That is deliberate and it is the only honest option: an HMAC
 * signature requires the sending side to hold the key material, so there is nothing to hash
 * it with — unlike a password, which is only ever compared. It is treated as a secret
 * everywhere it is *read* instead: `GET /api/v1/settings` masks it, the Settings page shows
 * it once at creation, and `webhookView()` never selects it.
 */
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** `NotifiableEvent[]` from `@mm/contracts`. Empty means "every event". */
    events: jsonb("events").$type<string[]>().notNull().default([]),
    /** The HMAC-SHA256 key. See the note above on why this is not hashed. */
    secret: text("secret").notNull(),
    enabled: text("enabled").notNull().default("true"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** The last attempt's HTTP status, or `null` when it never got that far. */
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    /** Consecutive failures. Reset by a success; shown as a warning past three. */
    failureCount: integer("failure_count").notNull().default(0),
  },
  (table) => [index("webhooks_enabled_idx").on(table.enabled)],
);

/**
 * One attempt to hand one event to one endpoint.
 *
 * Written before the request goes out, so a delivery that never returns is visible as a row
 * stuck in `pending` rather than as nothing at all.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    /** The `WebhookPayload` sent, verbatim, so a replay sends exactly what failed. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** `pending` | `delivered` | `failed`. */
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    responseStatus: integer("response_status"),
    /** The first 500 characters of the response, which is where the reason usually is. */
    responseBody: text("response_body"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    index("webhook_deliveries_webhook_idx").on(table.webhookId, table.createdAt),
    index("webhook_deliveries_status_idx").on(table.status),
  ],
);

export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
