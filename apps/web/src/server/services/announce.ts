/**
 * The seam between the job journal and the outside world (P08).
 *
 * `job_events` records everything the pipeline does — dozens of lines per import. Webhooks and
 * notifications carry **five** events, because they are for a person's phone and a third
 * party's endpoint, not for a log. This module is the mapping between the two, and it lives on
 * its own for one structural reason: `events.ts` must not import the webhook and notification
 * services. It is imported by the CLI, by the SSE route and by every step; dragging pg-boss and
 * three HTTP transports in behind it would put them in places that have no use for them.
 *
 * So `emit()` calls `announce()` and `announce()` decides. The rules are:
 *
 *  - `import.done` and `import.failed` map one-to-one;
 *  - `inbox.created` becomes **`review.needed`**, because "the Inbox has a new question" is
 *    what a person actually wants to be told, and the Inbox's own type names
 *    (`ambiguous_release`, `fingerprint_mismatch`…) are pipeline vocabulary;
 *  - everything else is journal, and is not announced.
 *
 * `ytdlp.updated` and `cookies.expiring` do not pass through the journal at all — they are
 * raised by the Tools routes and by the downloader's cron — so those call `announce()` directly.
 *
 * **It never throws and never blocks the caller.** A step that finished must not be undone by
 * a webhook subscriber being down, so failures are logged and swallowed, exactly as they are
 * inside `notifications.notify()` and `webhooks.dispatch()`.
 */
import type { NotifiableEvent } from "@mm/contracts";
import type { Database } from "#/server/db/client.ts";

/** Journal event type → the notifiable event it deserves, or nothing. */
const FROM_JOURNAL: Record<string, NotifiableEvent> = {
  "import.done": "import.done",
  "import.failed": "import.failed",
  "inbox.created": "review.needed",
};

/** True when this journal line is worth telling somebody about. */
export function notifiableFor(type: string): NotifiableEvent | null {
  return FROM_JOURNAL[type] ?? null;
}

/**
 * Fan one event out to the webhooks and to the notification channel.
 *
 * The two services are imported dynamically and only when there is something to send: this
 * function is called from `emit()`, which is on the hot path of every step, and `webhooks.ts`
 * reaches `queue.ts` and therefore pg-boss.
 */
export async function announce(
  event: NotifiableEvent,
  data: Record<string, unknown>,
  options: { db?: Database } = {},
): Promise<void> {
  try {
    const [{ dispatch }, { describe, notify }] = await Promise.all([
      import("#/server/services/webhooks.ts"),
      import("#/server/services/notifications.ts"),
    ]);
    await Promise.all([
      dispatch(event, data, { ...(options.db === undefined ? {} : { db: options.db }) }),
      notify(describe(event, data), { ...(options.db === undefined ? {} : { db: options.db }) }),
    ]);
  } catch (error) {
    console.warn(
      `[announce] ${event} was not announced:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Announce a journal line, if it is one of the three that deserve it.
 *
 * Called by `emit()` after the row is written, so a subscriber that reacts by calling the API
 * always finds the event already recorded.
 */
export async function announceJournal(
  entry: {
    type: string;
    message: string;
    importId?: string | null;
    step?: string | null;
    data?: Record<string, unknown> | undefined;
  },
  db?: Database,
): Promise<void> {
  const event = notifiableFor(entry.type);
  if (event === null) return;
  await announce(
    event,
    {
      ...(entry.data ?? {}),
      ...(entry.importId == null ? {} : { importId: entry.importId }),
      ...(entry.step == null ? {} : { step: entry.step }),
      message: entry.message,
    },
    { ...(db === undefined ? {} : { db }) },
  );
}
