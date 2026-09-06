/**
 * The Inbox: the list, one item, and answering it.
 *
 * Decision 002 in one screen — every item carries a preselected answer and its alternatives,
 * and Enter takes the preselection. The options a card offers are derived here rather than in
 * the component, because what "accept" means depends on the item's *type*, and that is
 * server knowledge: for `uncovered_tracks` it is "import what we have", for `ambiguous_release`
 * it is a release MBID, for `fingerprint_mismatch` it is which of two recordings to believe.
 *
 * Answering an item also puts the job back on the queue when the job was parked on it. An
 * Inbox you can answer without the job resuming is a to-do list, not a gate.
 */
import { z } from "zod";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { INBOX_TYPES, type InboxType } from "#/server/db/schema/enums.ts";
import type { Import, InboxItem } from "#/server/db/schema/index.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { enqueue } from "#/server/services/queue.ts";
import { getImport } from "#/server/services/imports.ts";
import {
  getInboxItem,
  hasOpenItems,
  listInbox,
  resolveInboxItem,
} from "#/server/services/inbox.ts";
import { resumeStepOf } from "#/server/services/jobs/index.ts";

/** One answer a card offers. `value` is what is written to `decisions.choice`. */
export interface InboxOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly score?: number;
  readonly preselected: boolean;
  readonly value: Record<string, unknown>;
  /** `dismissed` rather than `resolved` — "not now" is not an answer. */
  readonly dismiss?: boolean;
}

export interface InboxCard {
  readonly item: InboxItem;
  readonly job: Import | null;
  readonly options: readonly InboxOption[];
}

/**
 * The answers for one item.
 *
 * The first option is always the preselection, and it is always the one that lets the job
 * carry on: an Inbox whose default answer stops your import would be a worse place to press
 * Enter quickly.
 */
export function optionsFor(item: InboxItem): InboxOption[] {
  const payload = item.payload;
  const preselected = item.preselected ?? {};

  /**
   * How many tracks an `uncovered_tracks` item is about.
   *
   * The step writes this payload two ways, because two code paths raise the item: the matcher's
   * own proposal carries the whole tracks (`tracks: [{position, title, …}]`), and a supplied
   * mapping — which is what the wizard sends — only knows the positions it did not cover
   * (`positions: [6, 9]`). Reading only one of them is how a card ends up saying "0 missing
   * track(s)" next to a list of two.
   */
  function uncoveredCount(source: Record<string, unknown>): number {
    if (Array.isArray(source["tracks"])) return source["tracks"].length;
    if (Array.isArray(source["positions"])) return source["positions"].length;
    return 0;
  }

  switch (item.type) {
    case "uncovered_tracks": {
      const count = uncoveredCount(payload);
      return [
        {
          id: "partial",
          label: "Accept as partial",
          detail: `Import the ${String(count)} missing track(s) later; place what we have now.`,
          preselected: true,
          value: { action: "import anyway", accepted: true },
        },
        {
          id: "cancel",
          label: "Cancel this import",
          detail: "Nothing is written to the library.",
          preselected: false,
          value: { action: "cancel" },
        },
        {
          id: "later",
          label: "Later",
          detail: "Leave the question open and come back to it.",
          preselected: false,
          dismiss: true,
          value: { action: "snooze" },
        },
      ];
    }
    case "extra_videos": {
      const videos = Array.isArray(payload["videos"]) ? payload["videos"] : [];
      return [
        {
          id: "ignore",
          label: "Skip the extra video(s)",
          detail: `${String(videos.length)} video(s) are not on this release and will not be downloaded.`,
          preselected: true,
          value: { action: "ignore", accepted: true },
        },
        {
          id: "later",
          label: "Later",
          preselected: false,
          dismiss: true,
          value: { action: "snooze" },
        },
      ];
    }
    case "ambiguous_release": {
      const candidates = Array.isArray(payload["candidates"]) ? payload["candidates"] : [];
      const pinned =
        typeof preselected["releaseMbid"] === "string" ? preselected["releaseMbid"] : null;
      const options = candidates.slice(0, 5).map((raw, index) => {
        const candidate = raw as Record<string, unknown>;
        const id = String(candidate["id"] ?? `candidate-${String(index)}`);
        return {
          id,
          label: String(candidate["title"] ?? "Unknown release"),
          detail: [candidate["date"], candidate["country"], candidate["format"], candidate["label"]]
            .filter((part) => typeof part === "string" && part !== "")
            .join(" · "),
          score: typeof candidate["score"] === "number" ? candidate["score"] : undefined,
          preselected: pinned === null ? index === 0 : id === pinned,
          value: { releaseMbid: id },
        } satisfies InboxOption;
      });
      if (options.length > 0) return options;
      return [
        {
          id: "cancel",
          label: "Cancel this import",
          detail: "The search found nothing usable.",
          preselected: true,
          value: { action: "cancel" },
        },
      ];
    }
    case "ambiguous_recording": {
      const candidates = Array.isArray(payload["candidates"]) ? payload["candidates"] : [];
      const options = candidates.slice(0, 5).map((raw, index) => {
        const candidate = raw as Record<string, unknown>;
        const id = String(candidate["id"] ?? `candidate-${String(index)}`);
        return {
          id,
          label: `${String(candidate["title"] ?? "Unknown recording")} — ${String(candidate["artist"] ?? "")}`,
          detail:
            typeof candidate["disambiguation"] === "string" ? candidate["disambiguation"] : "",
          score: typeof candidate["score"] === "number" ? candidate["score"] : undefined,
          preselected: index === 0,
          value: { recordingMbid: id },
        } satisfies InboxOption;
      });
      return options.length > 0
        ? options
        : [
            {
              id: "cancel",
              label: "Cancel this import",
              preselected: true,
              value: { action: "cancel" },
            },
          ];
    }
    case "fingerprint_mismatch": {
      return [
        {
          id: "keep",
          label: "Keep the mapping I confirmed",
          detail: "The fingerprint disagrees, but the durations and titles do not.",
          preselected: true,
          value: { action: "keep-mapping", accepted: true },
        },
        {
          id: "acoustid",
          label: "Believe AcoustID instead",
          detail: "Re-bind the track to the recording the fingerprint names.",
          preselected: false,
          value: { action: "use-acoustid" },
        },
        {
          id: "skip",
          label: "Skip this track",
          preselected: false,
          value: { action: "skip-track" },
        },
      ];
    }
    default: {
      return [
        {
          id: "accept",
          label: "Accept the proposed answer",
          preselected: true,
          value: { ...preselected, accepted: true },
        },
        {
          id: "later",
          label: "Later",
          preselected: false,
          dismiss: true,
          value: { action: "snooze" },
        },
      ];
    }
  }
}

export interface InboxListPayload {
  readonly items: readonly InboxItem[];
  readonly card: InboxCard | null;
}

const typeFilter = z.enum(INBOX_TYPES);

export const fetchInbox = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().optional(), type: typeFilter.optional() }).default({}))
  .handler(async ({ data }): Promise<InboxListPayload> => {
    try {
      const items = await listInbox(
        { status: "open", ...(data.type === undefined ? {} : { type: data.type }) },
        db(),
      );
      const wanted = data.id === undefined ? items[0] : items.find((item) => item.id === data.id);
      const item = wanted ?? (data.id === undefined ? undefined : await lookup(data.id));
      if (item === undefined || item === null) return { items, card: null };
      const job = item.importId === null ? null : await getImport(item.importId, db());
      return { items, card: { item, job, options: optionsFor(item) } };
    } catch (error) {
      return toFailure(error);
    }
  });

async function lookup(id: string): Promise<InboxItem | null> {
  return await getInboxItem(id, db());
}

const resolveInput = z.object({
  id: z.string().min(1),
  /** The chosen option's `value`, verbatim. */
  choice: z.record(z.string(), z.unknown()),
  dismiss: z.boolean().default(false),
});

export interface ResolveResult {
  readonly id: string;
  readonly importId: string | null;
  /** True when answering it let the job carry on. */
  readonly resumed: boolean;
  /** The next open item, so the page can move to it without a round trip. */
  readonly nextId: string | null;
}

/**
 * Answer an item, then resume the job if that was the last thing holding it.
 *
 * The resume is conditional on there being nothing else open for that import: a job parked on
 * two questions must not restart after the first one is answered, only to park again.
 */
export const resolveItem = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(resolveInput)
  .handler(async ({ data }): Promise<ResolveResult> => {
    try {
      const item = await getInboxItem(data.id, db());
      if (item === null) {
        throw new MMError("NOT_FOUND", `No Inbox item with id ${data.id}.`, { status: 404 });
      }
      await resolveInboxItem(
        data.id,
        {
          resolution: data.choice,
          decidedBy: "user",
          status: data.dismiss ? "dismissed" : "resolved",
        },
        db(),
      );

      let resumed = false;
      if (item.importId !== null && !(await hasOpenItems(item.importId, db()))) {
        const job = await getImport(item.importId, db());
        if (
          job !== null &&
          ["awaiting_review", "awaiting_confirm", "paused"].includes(job.status)
        ) {
          const step = await resumeStepOf(item.importId, db());
          await enqueue(item.importId, "inbox resolved", step);
          resumed = true;
        }
      }

      const rest = await listInbox({ status: "open" }, db());
      return {
        id: data.id,
        importId: item.importId,
        resumed,
        nextId: rest[0]?.id ?? null,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export type { InboxType };
