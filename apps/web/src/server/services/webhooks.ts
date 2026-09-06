/**
 * Webhooks (`docs/phases/P08-api-agents.md` § Webhooks et notifications).
 *
 * A signed HTTP callback per event, delivered by the worker with exponential backoff. The
 * design has three load-bearing decisions:
 *
 *  - **Signing is Stripe's scheme**, `t=<unix>,v1=<hex>`, over `"<t>.<body>"` rather than over
 *    the body alone. Including the timestamp *inside* the signed material is what makes the
 *    signature useless to a replayer: with the body signed on its own, an attacker who
 *    captured one delivery could resend it verbatim for ever and every check would pass.
 *    `verifySignature` therefore also enforces a tolerance window.
 *  - **Dispatch fans out to rows, the queue carries one row.** `dispatch()` decides *who*
 *    wants an event and writes one `webhook_deliveries` row each; the `webhook.deliver` queue
 *    carries a single delivery id. A subscriber whose server is down must not delay the three
 *    that are up, and pg-boss's retry is per job.
 *  - **Retries are pg-boss's, not ours.** `retryLimit` with `retryBackoff` gives 5 attempts
 *    over roughly ten minutes, and the attempt count in the row is the *record* of that rather
 *    than a second, disagreeing counter.
 *
 * Nothing here throws at its callers. A webhook is an announcement; a subscriber's outage is
 * not the announcing import's problem.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  MMError,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type NotifiableEvent,
  type WebhookPayload,
  type WebhookView,
} from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { webhookDeliveries, webhooks, type Webhook } from "#/server/db/schema/webhooks.ts";
import { ulid } from "#/server/ids.ts";
import { serverEnv } from "#/server/env.ts";

/** How far out of date a signature may be and still be accepted, in seconds. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface WebhookDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly db?: Database;
  readonly now?: () => Date;
}

/* ------------------------------------------------------------------ */
/* signing                                                             */
/* ------------------------------------------------------------------ */

/**
 * `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`.
 *
 * Exported because the tests, the "Test send" button and any documentation example must all
 * compute it the same way — a signature scheme described in prose and implemented twice is a
 * signature scheme with two behaviours.
 */
export function signPayload(body: string, secret: string, at: Date = new Date()): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  const digest = createHmac("sha256", secret).update(`${String(timestamp)}.${body}`).digest("hex");
  return `t=${String(timestamp)},v1=${digest}`;
}

/**
 * The receiving side, for tests and for anyone implementing a subscriber.
 *
 * Compares in constant time and rejects anything outside the tolerance window. Both matter:
 * a `===` on hex digests leaks the digest a byte at a time, and a signature with no freshness
 * check is a bearer token that never expires.
 */
export function verifySignature(
  body: string,
  header: string,
  secret: string,
  options: { now?: Date; toleranceSeconds?: number } = {},
): boolean {
  const now = options.now ?? new Date();
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const parts = new Map(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
    }),
  );
  const timestamp = Number.parseInt(parts.get("t") ?? "", 10);
  const presented = parts.get("v1");
  if (Number.isNaN(timestamp) || presented === undefined) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > tolerance) return false;

  const expected = createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A fresh secret. 32 bytes of hex — long enough that nobody is tempted to memorise it. */
export function newSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

/* ------------------------------------------------------------------ */
/* the endpoints                                                       */
/* ------------------------------------------------------------------ */

export async function list(db: Database = defaultDb()): Promise<WebhookView[]> {
  const rows = await db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
  return rows.map(toView);
}

export async function get(id: string, db: Database = defaultDb()): Promise<Webhook | null> {
  const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id));
  return row ?? null;
}

export interface CreateWebhookInput {
  readonly name: string;
  readonly url: string;
  readonly events: readonly NotifiableEvent[];
}

/** Create one, returning the secret in clear — the only time the Console shows it. */
export async function create(
  input: CreateWebhookInput,
  db: Database = defaultDb(),
): Promise<{ view: WebhookView; secret: string }> {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new MMError("INVALID_INPUT", "A webhook URL must be http:// or https://.", {
      status: 400,
    });
  }
  const secret = newSecret();
  const [row] = await db
    .insert(webhooks)
    .values({
      id: `whk_${ulid()}`,
      name: input.name.trim() === "" ? url : input.name.trim(),
      url,
      events: [...input.events],
      secret,
    })
    .returning();
  if (row === undefined) throw new MMError("UNKNOWN", "The webhook was not created.");
  return { view: toView(row), secret };
}

export async function update(
  id: string,
  patch: { name?: string; url?: string; events?: readonly NotifiableEvent[]; enabled?: boolean },
  db: Database = defaultDb(),
): Promise<WebhookView> {
  const [row] = await db
    .update(webhooks)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.url === undefined ? {} : { url: patch.url }),
      ...(patch.events === undefined ? {} : { events: [...patch.events] }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled ? "true" : "false" }),
    })
    .where(eq(webhooks.id, id))
    .returning();
  if (row === undefined) {
    throw new MMError("NOT_FOUND", `No webhook with id ${id}.`, { status: 404 });
  }
  return toView(row);
}

export async function remove(id: string, db: Database = defaultDb()): Promise<void> {
  await db.delete(webhooks).where(eq(webhooks.id, id));
}

/** The recent attempts for one endpoint, newest first. What the Settings row expands into. */
export async function deliveries(id: string, limit = 20, db: Database = defaultDb()) {
  return await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, id))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

/** Build the body. Its own function because the signature is computed over exactly this. */
export function buildPayload(
  event: NotifiableEvent,
  data: Record<string, unknown>,
  options: { id?: string; at?: Date } = {},
): WebhookPayload {
  return {
    id: options.id ?? `evt_${ulid()}`,
    event,
    at: (options.at ?? new Date()).toISOString(),
    source: serverEnv().MM_WEB_URL,
    data,
  };
}

/**
 * Queue one delivery per interested, enabled endpoint.
 *
 * An endpoint with an empty `events` array wants everything: that is the shape a "just tell me
 * what happens" subscriber takes, and making them tick five boxes to say it would mean
 * silently missing the sixth event when it is added.
 */
export async function dispatch(
  event: NotifiableEvent,
  data: Record<string, unknown>,
  deps: WebhookDeps = {},
): Promise<{ queued: number }> {
  const db = deps.db ?? defaultDb();
  try {
    const rows = await db.select().from(webhooks).where(eq(webhooks.enabled, "true"));
    const interested = rows.filter(
      (row) => row.events.length === 0 || row.events.includes(event),
    );
    if (interested.length === 0) return { queued: 0 };

    const payload = buildPayload(event, data, { at: deps.now?.() });
    const ids: string[] = [];
    for (const row of interested) {
      const id = `whd_${ulid()}`;
      await db.insert(webhookDeliveries).values({
        id,
        webhookId: row.id,
        event,
        payload: { ...payload },
        // `attempt` counts attempts *made*, and none has been yet. The column's default is 1
        // — the count you would want if the row were written after the request rather than
        // before it — so a first success recorded `2`. Set explicitly rather than changed in
        // the schema, because 0005 is already applied.
        attempt: 0,
      });
      ids.push(id);
    }

    // Imported here rather than at the top of the module: `queue.ts` pulls in pg-boss, and
    // this module is also imported by the REST layer, where a webhook may never be dispatched.
    const { enqueueWebhook } = await import("#/server/services/queue.ts");
    for (const id of ids) await enqueueWebhook(id);
    return { queued: ids.length };
  } catch (error) {
    console.warn(`[webhooks] could not dispatch ${event}:`, MMError.from(error).message);
    return { queued: 0 };
  }
}

export interface DeliveryResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
  readonly durationMs: number;
}

/**
 * Perform one delivery and record it. Called by the worker's `webhook.deliver` handler.
 *
 * **Throws on failure, on purpose.** That is what tells pg-boss to retry, and pg-boss owns the
 * backoff. The row is updated with the outcome *before* the throw, so a delivery that is still
 * being retried is visible as `failed` with a rising `attempt` rather than as nothing.
 */
export async function deliver(deliveryId: string, deps: WebhookDeps = {}): Promise<DeliveryResult> {
  const db = deps.db ?? defaultDb();
  const doFetch = deps.fetch ?? globalThis.fetch;

  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId));
  if (delivery === undefined) {
    throw new MMError("NOT_FOUND", `No webhook delivery with id ${deliveryId}.`);
  }
  if (delivery.status === "delivered") {
    return { ok: true, status: delivery.responseStatus, error: null, durationMs: 0 };
  }

  const endpoint = await get(delivery.webhookId, db);
  if (endpoint === null) {
    await db
      .update(webhookDeliveries)
      .set({ status: "failed", error: "The endpoint was deleted." })
      .where(eq(webhookDeliveries.id, deliveryId));
    return { ok: false, status: null, error: "The endpoint was deleted.", durationMs: 0 };
  }

  const body = JSON.stringify(delivery.payload);
  const started = Date.now();
  const result = await attempt(endpoint, body, delivery.event, delivery.id, doFetch);
  const durationMs = Date.now() - started;

  await db
    .update(webhookDeliveries)
    .set({
      status: result.ok ? "delivered" : "failed",
      attempt: delivery.attempt + 1,
      responseStatus: result.status,
      responseBody: result.body,
      error: result.error,
      durationMs,
      ...(result.ok ? { deliveredAt: new Date() } : {}),
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  await db
    .update(webhooks)
    .set({
      lastStatus: result.status,
      lastError: result.error,
      lastDeliveryAt: new Date(),
      failureCount: result.ok ? 0 : endpoint.failureCount + 1,
    })
    .where(eq(webhooks.id, endpoint.id));

  if (!result.ok) {
    // Let pg-boss retry. The row above already records why.
    throw new MMError("UNKNOWN", result.error ?? `Endpoint answered ${String(result.status)}.`, {
      retryable: true,
    });
  }
  return { ok: true, status: result.status, error: null, durationMs };
}

/**
 * Send once, to a URL somebody typed into a form.
 *
 * `redirect: "manual"` because following a redirect would re-send a signed body to a host the
 * operator never approved, and a 10-second timeout because a hung subscriber must not hold a
 * worker slot open.
 */
async function attempt(
  endpoint: Webhook,
  body: string,
  event: string,
  deliveryId: string,
  doFetch: typeof globalThis.fetch,
): Promise<{ ok: boolean; status: number | null; body: string | null; error: string | null }> {
  try {
    const response = await doFetch(endpoint.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "user-agent": "music-manager-webhooks/1",
        [WEBHOOK_SIGNATURE_HEADER]: signPayload(body, endpoint.secret),
        [WEBHOOK_EVENT_HEADER]: event,
        [WEBHOOK_DELIVERY_HEADER]: deliveryId,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = (await response.text().catch(() => "")).slice(0, 500);
    return {
      ok: response.ok,
      status: response.status,
      body: text === "" ? null : text,
      error: response.ok ? null : `Endpoint answered ${String(response.status)}.`,
    };
  } catch (error) {
    return { ok: false, status: null, body: null, error: MMError.from(error).message };
  }
}

/**
 * The "Test" button: one synchronous delivery, reported back rather than queued.
 *
 * It sends a real `import.done` with obviously fake data, because the useful question is
 * "does my receiver accept a signed body from you?" and a bespoke `test` event would exercise
 * a code path the subscriber does not have.
 */
export async function testSend(
  id: string,
  deps: WebhookDeps = {},
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const db = deps.db ?? defaultDb();
  const endpoint = await get(id, db);
  if (endpoint === null) {
    throw new MMError("NOT_FOUND", `No webhook with id ${id}.`, { status: 404 });
  }
  const payload = buildPayload("import.done", {
    test: true,
    importId: "imp_TEST",
    title: "A test delivery from Music Manager",
    tracks: 14,
  });
  const body = JSON.stringify(payload);
  const result = await attempt(
    endpoint,
    body,
    "import.done",
    payload.id,
    deps.fetch ?? globalThis.fetch,
  );
  await db
    .update(webhooks)
    .set({ lastStatus: result.status, lastError: result.error, lastDeliveryAt: new Date() })
    .where(eq(webhooks.id, id));
  return { ok: result.ok, status: result.status, error: result.error };
}

/** The endpoint as the API and the Console show it: everything except the secret. */
function toView(row: Webhook): WebhookView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events as NotifiableEvent[],
    enabled: row.enabled === "true",
    createdAt: row.createdAt.toISOString(),
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    failureCount: row.failureCount,
  };
}

/** Used by the tests to assert a dispatch reached exactly the right endpoints. */
export async function pendingFor(
  event: NotifiableEvent,
  db: Database = defaultDb(),
): Promise<number> {
  const rows = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.event, event), eq(webhookDeliveries.status, "pending")));
  return rows.length;
}
