/**
 * The journal and its live tail (`docs/06-stack.md`: SSE, no websocket).
 *
 * Every interesting thing a job does is written to `job_events` **first**, then announced on
 * a Postgres `NOTIFY` channel. That order matters: the database is the record and the
 * notification is only a nudge, so a subscriber that reconnects — or that was not listening
 * when the line was written — catches up by reading rows, never by hoping a broadcast is
 * replayed. It is also why `Last-Event-ID` works for free.
 *
 * The notification payload is deliberately tiny (`{id, importId}`): `NOTIFY` truncates above
 * 8 000 bytes, and an event carrying a 50 KB document would silently stop arriving.
 */
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { JobEventPayload } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { jobEvents, type EventLevel, type StepName } from "#/server/db/schema/index.ts";
import { announceJournal, notifiableFor } from "#/server/services/announce.ts";

/** The channel every orchestrator process notifies and every SSE stream listens on. */
export const EVENT_CHANNEL = "mm_job_events";

export interface EmitOptions {
  readonly importId?: string | null;
  readonly trackId?: string | null;
  readonly step?: StepName | null;
  readonly level?: EventLevel;
  /** Dotted name: `step.started`, `track.progress`… */
  readonly type: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

/** What travels on the `NOTIFY` channel: enough to know there is something new to read. */
interface Nudge {
  readonly id: number;
  readonly importId: string | null;
}

/** Write one journal line and announce it. Never throws into the caller's step. */
export async function emit(options: EmitOptions, db: Database = defaultDb()): Promise<number> {
  const [row] = await db
    .insert(jobEvents)
    .values({
      importId: options.importId ?? null,
      trackId: options.trackId ?? null,
      step: options.step ?? null,
      level: options.level ?? "info",
      type: options.type,
      message: options.message,
      data: options.data ?? null,
    })
    .returning({ id: jobEvents.id });

  const id = row?.id ?? 0;
  const nudge: Nudge = { id, importId: options.importId ?? null };
  // `pg_notify` rather than `NOTIFY`: the channel name is a literal and the payload is bound.
  await db.execute(sql`select pg_notify(${EVENT_CHANNEL}, ${JSON.stringify(nudge)})`);

  /*
   * Three of these lines are also worth telling a human or a third party about (P08).
   *
   * Deliberately **not awaited**: `emit()` is on the hot path of every step, and a webhook
   * subscriber that takes ten seconds to answer must not add ten seconds to an import. The row
   * is already written and already announced on the channel, so nothing here can be lost by
   * letting it finish on its own — and `announceJournal` never throws, so there is nothing to
   * catch either. `void` says that is on purpose rather than a forgotten `await`.
   */
  if (notifiableFor(options.type) !== null) {
    void announceJournal(
      {
        type: options.type,
        message: options.message,
        importId: options.importId ?? null,
        step: options.step ?? null,
        data: options.data,
      },
      db,
    );
  }
  return id;
}

/** Rows of one import (or of everything), oldest first, after `since`. */
export async function readEvents(
  options: { importId?: string; since?: number; limit?: number } = {},
  db: Database = defaultDb(),
): Promise<JobEventPayload[]> {
  const filters = [
    ...(options.importId === undefined ? [] : [eq(jobEvents.importId, options.importId)]),
    ...(options.since === undefined ? [] : [gt(jobEvents.id, options.since)]),
  ];
  const rows = await db
    .select()
    .from(jobEvents)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(asc(jobEvents.id))
    .limit(options.limit ?? 500);
  return rows.map(toPayload);
}

function toPayload(row: typeof jobEvents.$inferSelect): JobEventPayload {
  return {
    id: row.id,
    importId: row.importId,
    trackId: row.trackId,
    step: row.step,
    level: row.level,
    type: row.type,
    message: row.message,
    data: row.data,
    at: row.at.toISOString(),
  };
}

/** The id of the newest event, or 0. The starting point of a stream that wants no history. */
export async function latestEventId(
  options: { importId?: string } = {},
  db: Database = defaultDb(),
): Promise<number> {
  const rows = await db
    .select({ id: jobEvents.id })
    .from(jobEvents)
    .where(options.importId === undefined ? undefined : eq(jobEvents.importId, options.importId))
    .orderBy(desc(jobEvents.id))
    .limit(1);
  return rows[0]?.id ?? 0;
}

export interface Subscription {
  /** Stop listening and give the connection back. */
  unsubscribe(): Promise<void>;
}

/**
 * Listen for new events, calling `onEvent` with the rows themselves.
 *
 * The nudge only carries an id, so the reader fetches everything after the last id it saw.
 * That single mechanism covers three cases at once: a burst of events collapsing into one
 * wake-up, a notification lost while reconnecting, and a client resuming with `Last-Event-ID`.
 */
export async function subscribe(
  options: {
    importId?: string;
    since?: number;
    onEvent: (event: JobEventPayload) => void | Promise<void>;
  },
  db: Database = defaultDb(),
): Promise<Subscription> {
  let cursor = options.since ?? 0;
  let draining = false;
  let again = false;

  const drain = async (): Promise<void> => {
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      do {
        again = false;
        const rows = await readEvents(
          {
            ...(options.importId === undefined ? {} : { importId: options.importId }),
            since: cursor,
          },
          db,
        );
        for (const row of rows) {
          cursor = Math.max(cursor, row.id);
          await options.onEvent(row);
        }
      } while (again);
    } finally {
      draining = false;
    }
  };

  // postgres-js keeps one dedicated connection per LISTEN, which is exactly what we want:
  // a long-lived stream must not hold a pooled connection hostage.
  const client = db.$client;
  const listener = await client.listen(EVENT_CHANNEL, (payload: string) => {
    let nudge: Nudge | null = null;
    try {
      nudge = JSON.parse(payload) as Nudge;
    } catch {
      nudge = null;
    }
    if (nudge !== null && options.importId !== undefined && nudge.importId !== options.importId) {
      return;
    }
    void drain();
  });

  // Catch up on whatever happened before the listener was in place.
  await drain();

  return {
    async unsubscribe() {
      await listener.unlisten();
    },
  };
}

/** Render one event as an SSE frame. `id:` is what makes `Last-Event-ID` work. */
export function toServerSentEvent(event: JobEventPayload): string {
  return `id: ${String(event.id)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The body of `GET /api/events`.
 *
 * Framework-agnostic on purpose: the TanStack Start route is three lines around this, and the
 * E2E can exercise the same code without booting Vite.
 */
export function eventStream(
  options: { importId?: string; since?: number; heartbeatMs?: number },
  db: Database = defaultDb(),
): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let subscription: Subscription | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Without `since` (or `Last-Event-ID`) a stream starts *now*. Replaying the whole
      // journal to every new subscriber would flood the Console on connect; a client that
      // wants the history asks for it with `?since=0`, and one that is reconnecting sends the
      // id it last saw, which is the case that actually has to be lossless.
      const from =
        options.since ??
        (await latestEventId(
          options.importId === undefined ? {} : { importId: options.importId },
          db,
        ));
      const send = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client hung up between the read and the enqueue; `cancel` will clean up.
        }
      };
      // A comment line opens the stream immediately, so a proxy cannot sit on the headers.
      send(`: subscribed${options.importId === undefined ? "" : ` to ${options.importId}`}\n\n`);
      subscription = await subscribe(
        {
          ...(options.importId === undefined ? {} : { importId: options.importId }),
          since: from,
          onEvent: (event) => send(toServerSentEvent(event)),
        },
        db,
      );
      heartbeat = setInterval(() => send(`: heartbeat\n\n`), heartbeatMs);
    },
    async cancel() {
      if (heartbeat !== null) clearInterval(heartbeat);
      await subscription?.unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Nitro and nginx both buffer by default, which would defeat the whole endpoint.
      "x-accel-buffering": "no",
    },
  });
}
