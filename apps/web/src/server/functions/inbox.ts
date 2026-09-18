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
import { eq } from "drizzle-orm";
import { z } from "zod";
import { MMError } from "@mm/contracts";
import { parseMbRef } from "@mm/domain";
import { db } from "#/server/db/client.ts";
import { INBOX_TYPES, type InboxType } from "#/server/db/schema/enums.ts";
import {
  importTracks,
  type Import,
  type InboxDismissal,
  type InboxItem,
  type InboxStatus,
} from "#/server/db/schema/index.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { enqueue } from "#/server/services/queue.ts";
import { getImport } from "#/server/services/imports.ts";
import {
  countInbox,
  countInboxByStatus,
  countInboxByType,
  getInboxItem,
  hasOpenItems,
  listInbox,
  resolveInboxItem,
  type InboxFilter,
} from "#/server/services/inbox.ts";
import {
  forgetInboxDismissal,
  forgetInboxDismissals,
  listInboxDismissals,
} from "#/server/services/inbox-dismissals.ts";
import { setImportOptions } from "#/server/services/console.queries.ts";
import { pinnedRelease } from "#/server/services/matching.queries.ts";
import { resolveMbRef } from "#/server/services/mb-resolve.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { resumeStepOf } from "#/server/services/jobs/index.ts";
import { editionBaseTitle } from "#/lib/edition-qualifier.ts";
import { INBOX_PAGE_SIZE, INBOX_SORTS, INBOX_STATUS_FILTERS } from "#/lib/inbox-filters.ts";
import { albumSourceLink, webpageUrlOf, type AlbumSourceLink } from "#/lib/source-url.ts";

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
  /**
   * Where the audio this question is about can be heard — the YouTube video when the item is
   * about one track, the playlist otherwise.
   *
   * Computed here rather than in the component because the addresses are in two different
   * rows (`imports.url` and `import_tracks.raw.webpage_url`) and the judgement between them is
   * `lib/source-url.ts`'s, which the album page already uses. `null` when neither row knows a
   * web address — a `fixture://` import has none, and inventing one would be worse than the
   * button not being there.
   */
  readonly source: AlbumSourceLink | null;
  /**
   * True on the one card the matcher could offer nothing to choose between.
   *
   * It is the card that used to say "Cancel this import" and nothing else, and it is the only
   * one that accepts a pasted release id or a qualifier-free search. Decided here, from the
   * payload, so the component does not have to infer "no candidate" from the shape of the
   * options list.
   */
  readonly noCandidate: boolean;
  /**
   * The album title with its edition qualifier removed, when it has one.
   *
   * Only ever set on a candidateless `ambiguous_release`, which is the one card that offers to
   * search again without it. `null` everywhere else, and `null` for a title that carries no
   * qualifier — the button is then not offered at all rather than offered and useless.
   */
  readonly editionBaseTitle: string | null;
}

/**
 * "Import it from the source's own tags", the way out of a record MusicBrainz does not have.
 *
 * Declared once, beside the card that offers it, and worded as what it *does* rather than as
 * what it is called: the album is built from the YouTube listing's own title, artist and track
 * order, no MusicBrainz identifier is written, and the library flags it `untagged` so it can be
 * found again and identified later. That sentence is on the card because this is a lesser
 * outcome somebody is choosing deliberately.
 *
 * The value is the shape `applyResolution` already carries out for the two buttons beside it —
 * rewind to `match`, run it again — with `untaggedFallback` riding along.
 */
const UNTAGGED_ANSWER: InboxOption = {
  id: "untagged",
  label: "Import it from the YouTube tags instead",
  detail:
    "Builds the album from the source's own title, artist, year and track order. No identifiers, " +
    "no credits, no archive cover: the library flags it untagged, with its own filter on the " +
    "Quality page, and picking a release later re-tags it without re-downloading a byte.",
  preselected: false,
  value: { action: "retry", step: "match", untaggedFallback: true },
};

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
      /*
       * Nothing to choose between — and, until now, nothing to do but give up.
       *
       * The escape has existed since P03 and was unreachable from here: `match` builds the
       * album from the source's own tags when `options.untaggedFallback` is true, which is on
       * by default for a folder and off for a URL (`steps/match.ts`, `wantsUntaggedFallback`).
       * The only ways to state it were `mm import <url> --untagged`, `options.untaggedFallback`
       * on the API and a button inside the wizard, so an import started from a batch, a watched
       * source or Discover met none of them and its owner met a card that offered cancelling.
       *
       * It is **not** the preselection, and that is the whole of the judgement. Filing an album
       * under a title nobody chose is worse than parking it, so the pipeline's default stays
       * "ask"; what the card owes the reader is the offer, said plainly enough that choosing it
       * is a decision rather than an accident. `UNTAGGED_ANSWER` is the shape, not a new verb:
       * `{action: "retry", step: "match"}` is what the pin button and the qualifier search
       * already send, with the flag riding along.
       */
      return [
        {
          id: "cancel",
          label: "Cancel this import",
          detail: "The search found nothing usable. Nothing is written to the library.",
          preselected: true,
          value: { action: "cancel" },
        },
        UNTAGGED_ANSWER,
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
    case "job_failed": {
      /*
       * The two things a person does with a failed job, and nothing else: run it again, or
       * give up on it. Both are carried out by `resolveInboxItem`, so the API and the MCP
       * server answer this card exactly as the Console does (`docs/04` § Inbox).
       */
      const step = typeof payload["step"] === "string" ? payload["step"] : null;
      const code = typeof payload["code"] === "string" ? payload["code"] : "UNKNOWN";
      const hint = typeof payload["hint"] === "string" ? payload["hint"] : null;
      return [
        {
          id: "retry",
          label: step === null ? "Retry the import" : `Retry from ${step}`,
          detail:
            hint ??
            `The error was ${code}. Everything from that step on is run again; nothing earlier is repeated.`,
          preselected: true,
          value: { action: "retry", ...(step === null ? {} : { step }) },
        },
        {
          id: "cancel",
          label: "Cancel this import",
          detail: "Give up on it. Nothing further is written to the library.",
          preselected: false,
          value: { action: "cancel" },
        },
        {
          id: "later",
          label: "Later",
          detail: "Leave the failure open and come back to it.",
          preselected: false,
          dismiss: true,
          value: { action: "snooze" },
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
    case "orphan_files": {
      const total = typeof payload["total"] === "number" ? payload["total"] : 0;
      return [
        {
          id: "keep",
          label: "Leave them where they are",
          detail: `The ${String(total)} file(s) stay on disk, unknown to the database. Nothing is moved or deleted.`,
          preselected: true,
          value: { action: "keep_all", accepted: true },
        },
        {
          id: "trash",
          label: "Move them to the trash directory",
          detail:
            "A move, never a delete: they end up under the trash directory from Settings and can be put back.",
          preselected: false,
          value: { action: "trash_orphans" },
        },
        {
          id: "later",
          label: "Later — identify them on the Tools page first",
          detail: "Tools can fingerprint each one and say what it thinks it is.",
          preselected: false,
          dismiss: true,
          value: { action: "snooze" },
        },
      ];
    }
    case "duplicate_recording": {
      const files = Array.isArray(payload["files"]) ? payload["files"] : [];
      return [
        {
          id: "keep",
          label: "Keep both copies",
          detail: "Legitimate more often than not: an album and a compilation share the recording.",
          preselected: true,
          value: { action: "keep_all", accepted: true },
        },
        {
          id: "trash",
          label: `Move the other ${String(Math.max(0, files.length - 1))} copy/copies to the trash`,
          detail: "The first path is kept; the rest are moved to the trash directory.",
          preselected: false,
          value: { action: "trash_duplicates" },
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
    case "verify_mismatch": {
      return [
        {
          id: "accept",
          label: "Accept what Navidrome reports",
          detail:
            "Some fields are simply not indexed by the server; accepting says this album is as good as it gets there.",
          preselected: true,
          value: { action: "accept_navidrome", accepted: true },
        },
        {
          id: "reverify",
          label: "Rescan and compare again",
          detail: "Ask Navidrome for this album once more; a mismatch often survives one scan.",
          preselected: false,
          value: { action: "reverify" },
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
    case "album_incomplete": {
      return [
        {
          id: "accept",
          label: "Accept the album as it is",
          detail: "It stays in the library, short of the tracks it never had.",
          preselected: true,
          value: { action: "accept_partial", accepted: true },
        },
        {
          id: "later",
          label: "Later — find the missing tracks in Discover",
          detail: "Discover is the page that turns a gap into an import.",
          preselected: false,
          dismiss: true,
          value: { action: "snooze" },
        },
      ];
    }
    case "ytdlp_update": {
      return [
        {
          id: "update",
          label: "Try the update again now",
          detail: "Runs the same update, and says what came back this time.",
          preselected: true,
          value: { action: "update_ytdlp" },
        },
        {
          id: "accept",
          label: "Carry on with the version installed",
          detail:
            "YouTube changes its extractor faster than anything else here; an old yt-dlp is the usual cause of a download that stops working.",
          preselected: false,
          value: { action: "keep_version", accepted: true },
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
    case "source_new_video": {
      /*
       * A watched source found something and did not feel entitled to accept it. The card is
       * therefore a *pointer*, not a decision: the release still has to be chosen, and the
       * wizard is the only place that can do that. "Review the import" is the preselection
       * because it is the only answer that moves the import forward.
       */
      const why = typeof payload["why"] === "string" ? payload["why"] : null;
      const tracks = typeof payload["tracks"] === "number" ? payload["tracks"] : 0;
      return [
        {
          id: "review",
          label: "Review the import",
          detail:
            why === null
              ? `${String(tracks)} track(s) are waiting for a release to be confirmed.`
              : `Held back because ${why}. Open the import and confirm the release.`,
          preselected: true,
          value: { action: "review" },
        },
        {
          id: "cancel",
          label: "Cancel this import",
          detail: "Nothing is written to the library, and the source will not offer it again.",
          preselected: false,
          value: { action: "cancel" },
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
    case "awaiting_confirm": {
      /*
       * The one blocking step of the pipeline, asked as a question at last.
       *
       * The preselection is "yes", because the mapping is already computed and on screen and
       * because the preselection is always the answer that lets the job carry on. The second
       * option is the escape hatch rather than another answer: the wizard is the only place a
       * different release can actually be chosen, so the card points at it instead of
       * pretending to offer the choice itself.
       */
      const count = Array.isArray(payload["tracks"]) ? payload["tracks"].length : 0;
      return [
        {
          id: "confirm",
          label: "Confirm and start",
          detail: `Accept the mapping as shown and download the ${String(count)} track(s).`,
          preselected: true,
          value: { action: "confirm" },
        },
        {
          id: "review",
          label: "Choose another release first",
          detail: "Opens the import wizard at the release step; nothing is confirmed.",
          preselected: false,
          value: { action: "review" },
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
          preselected: false,
          dismiss: true,
          value: { action: "snooze" },
        },
      ];
    }
    case "cover_missing": {
      return [
        {
          id: "keep",
          label: "Keep the picture that is in the file",
          detail:
            "Nothing is removed: the cover v1 embedded stays where it is. It is simply not in the document, so a re-tag cannot re-create it.",
          preselected: true,
          value: { action: "keep_embedded", accepted: true },
        },
        {
          id: "choose",
          label: "Pick a cover on the album page",
          detail:
            "The cover picker lists the Cover Art Archive candidates and accepts an upload; whatever is chosen there is written to the document and locked.",
          preselected: false,
          value: { action: "choose_cover" },
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
    case "cookies_expiring": {
      return [
        {
          id: "renewed",
          label: "I have refreshed the cookies",
          detail: "Paste or upload a fresh cookies.txt in Settings → Downloader, then take this.",
          preselected: true,
          value: { action: "cookies_renewed", accepted: true },
        },
        {
          id: "anonymous",
          label: "Carry on without cookies",
          detail: "Anonymous downloads still work for most public videos.",
          preselected: false,
          value: { action: "keep_anonymous", accepted: true },
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
    default: {
      /*
       * The generic pair, kept for a type nobody has written a card for yet.
       *
       * It used to serve seven of the twelve types, and it was the reason `orphan_files` read
       * "Accept the proposed answer" without saying *what* was being accepted (`keep_all`),
       * next to none of the actions Tools offers on the very same orphan (DRIVE-1 §B6).
       * `docs/04` § Inbox asks for a preselected answer **and** alternatives; two buttons, one
       * of which is "Later", is not alternatives.
       */
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
  /** Rows in the whole filtered set, not on this page — what the pager prints. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** One number per type, with the *type* filter lifted; the chips read these. */
  readonly byType: Record<InboxType, number>;
  /** One number per status, with the *status* filter lifted; the select reads these. */
  readonly byStatus: Record<InboxStatus, number>;
  /**
   * What has been hidden for good, so the page can show it and take it back.
   *
   * On the list payload rather than behind a button of its own for the reason Discover's
   * count is on its view: a memory nobody can see is a memory nobody trusts, and a dismissal
   * taken by mistake has to be undoable without a database client. Capped, with the true
   * total beside it — the cap is a rendering limit, not a lie about how many there are.
   */
  readonly dismissals: {
    readonly rows: readonly InboxDismissal[];
    readonly total: number;
  };
}

/** How many hidden subjects the Review page lists before it stops drawing rows. */
const DISMISSAL_LIST_LIMIT = 100;

const typeFilter = z.enum(INBOX_TYPES);

/**
 * The list, one page of it, its counts, and the card that is open on it.
 *
 * Everything the toolbar offers is a parameter here and a search parameter in the URL, so a
 * filtered queue is a link: `/review?type=ambiguous_release&sort=oldest` is "the forty edition
 * decisions, the ones that have waited longest first", which is the view that was unreachable
 * at three hundred items.
 *
 * The four reads take **one** `filter` object. That is the whole defence against the count
 * disagreeing with the rows: `listInbox`, `countInbox` and the two grouped counts all compile
 * their predicate from it through `inboxWhere`, and the only difference between them is which
 * single condition the grouped ones lift.
 */
export const fetchInbox = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z
      .object({
        id: z.string().optional(),
        type: typeFilter.optional(),
        status: z.enum(INBOX_STATUS_FILTERS).default("open"),
        q: z.string().default(""),
        sort: z.enum(INBOX_SORTS).default("recent"),
        page: z.number().int().min(0).default(0),
      })
      /*
       * `prefault`, not `default`: the fields below have defaults of their own, so the object's
       * *output* type has four required keys and `default({})` would not type-check against it.
       * `prefault` substitutes on the input side, which is what "called with nothing" means —
       * the palette and the tests call `fetchInbox({ data: {} })` and must get the page the
       * route shows.
       */
      .prefault({}),
  )
  .handler(async ({ data }): Promise<InboxListPayload> => {
    try {
      const filter: InboxFilter = {
        ...(data.status === "all" ? {} : { status: data.status }),
        ...(data.type === undefined ? {} : { type: data.type }),
        ...(data.q.trim() === "" ? {} : { search: data.q }),
        sort: data.sort,
      };
      const offset = data.page * INBOX_PAGE_SIZE;

      const [items, total, byType, byStatus, dismissals] = await Promise.all([
        listInbox({ ...filter, limit: INBOX_PAGE_SIZE, offset }, db()),
        countInbox(filter, db()),
        countInboxByType(filter, db()),
        countInboxByStatus(filter, db()),
        listInboxDismissals({ limit: DISMISSAL_LIST_LIMIT }, db()),
      ]);

      const page = {
        total,
        page: data.page,
        pageSize: INBOX_PAGE_SIZE,
        byType,
        byStatus,
        dismissals,
      };

      /*
       * The open card may be an item this page does not hold — a deep link, or the item that
       * was answered a second ago while the filter has since moved on. It is looked up on its
       * own rather than being dropped, because a `/review/:id` that renders "pick an item"
       * because of a filter would be a link that stopped working.
       */
      const wanted = data.id === undefined ? items[0] : items.find((item) => item.id === data.id);
      const item = wanted ?? (data.id === undefined ? undefined : await lookup(data.id));
      if (item === undefined || item === null) return { items, card: null, ...page };
      return { items, card: await cardFor(item), ...page };
    } catch (error) {
      return toFailure(error);
    }
  });

async function lookup(id: string): Promise<InboxItem | null> {
  return await getInboxItem(id, db());
}

/** Everything the decision card needs that is not on the item row itself. */
async function cardFor(item: InboxItem): Promise<InboxCard> {
  const job = item.importId === null ? null : await getImport(item.importId, db());
  const noCandidate = offersQualifierSearch(item);
  return {
    item,
    job,
    options: optionsFor(item),
    source: await sourceLinkFor(item, job),
    noCandidate,
    editionBaseTitle: noCandidate ? editionBaseTitle(job?.title) : null,
  };
}

/** True for the one card that has no candidate to choose between: `match` found nothing. */
export function offersQualifierSearch(item: InboxItem): boolean {
  if (item.type !== "ambiguous_release" || item.importId === null) return false;
  const candidates = item.payload["candidates"];
  return !Array.isArray(candidates) || candidates.length === 0;
}

/**
 * The one link this card offers back to the audio.
 *
 * Two rows hold an address and neither is the whole answer, which is the judgement
 * `lib/source-url.ts` already makes for the album page. The only thing added here is *which*
 * row to prefer: an item about one track is about one video, so that video wins outright over
 * the playlist the import was submitted as.
 *
 * `raw` is read one row at a time and never for the whole import — it is the verbatim yt-dlp
 * entry, several kilobytes of thumbnails and formats each, and this runs in a loader.
 */
async function sourceLinkFor(item: InboxItem, job: Import | null): Promise<AlbumSourceLink | null> {
  if (item.trackId !== null) {
    const [row] = await db()
      .select({ raw: importTracks.raw })
      .from(importTracks)
      .where(eq(importTracks.id, item.trackId))
      .limit(1);
    const url = webpageUrlOf(row?.raw);
    if (url !== null) {
      return { url, kind: "video", label: "Open the source video on YouTube" };
    }
  }

  if (job === null) return null;
  const [first] = await db()
    .select({ raw: importTracks.raw })
    .from(importTracks)
    .where(eq(importTracks.importId, job.id))
    .orderBy(importTracks.position)
    .limit(1);
  return albumSourceLink(job.url, [webpageUrlOf(first?.raw)]);
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
      const outcome = await resolveInboxItem(
        data.id,
        {
          resolution: data.choice,
          decidedBy: "user",
          status: data.dismiss ? "dismissed" : "resolved",
        },
        db(),
      );

      /*
       * The answer may have restarted the job itself — a chosen release or recording is pinned
       * and re-matched by `applyResolution`. The toast reads this, so "the job resumes" is a
       * report rather than a hope.
       */
      let resumed = outcome.resumed;
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

      return {
        id: data.id,
        importId: item.importId,
        resumed,
        nextId: await nextOpenId(),
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * The next item to open, as one row.
 *
 * It used to be `listInbox({status:"open"})[0]`, which reads every open item **with its
 * payload** — the whole candidate set of every unresolved match — to learn one id. That is the
 * same mistake `countInbox` exists to undo, one function along, and at three hundred items it
 * is a few hundred jsonb documents per answered card.
 */
async function nextOpenId(): Promise<string | null> {
  const [next] = await listInbox({ status: "open", limit: 1 }, db());
  return next?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* the candidateless card's two ways out                               */
/* ------------------------------------------------------------------ */

/**
 * The item this card is about, checked to be the one that offers these two actions.
 *
 * Both functions below relaunch an import, so both have to refuse an item that is not a
 * candidateless `ambiguous_release` — otherwise a crafted call could rewind any import in the
 * database from a card that never offered to.
 */
async function candidatelessRelease(id: string): Promise<{ item: InboxItem; job: Import }> {
  const item = await getInboxItem(id, db());
  if (item === null) {
    throw new MMError("NOT_FOUND", `No Inbox item with id ${id}.`, { status: 404 });
  }
  if (!offersQualifierSearch(item)) {
    throw new MMError(
      "INVALID_INPUT",
      "This question is not one the matcher failed to find any release for.",
      {
        hint: "Relaunching a search only makes sense on a card that has no candidate to choose between.",
        status: 400,
      },
    );
  }
  const job = item.importId === null ? null : await getImport(item.importId, db());
  if (job === null) {
    throw new MMError("NOT_FOUND", "The import this question was about is gone.", { status: 404 });
  }
  return { item, job };
}

export interface RelaunchResult {
  readonly importId: string;
  /** What the import was pinned to, or searched under. For the toast. */
  readonly pinned: string;
  /** The next open item, so the page moves on exactly as answering a card does. */
  readonly nextId: string | null;
}

/**
 * Pin an import to a release the owner pasted, and run `match` again against it.
 *
 * This is the escape hatch `docs/04` already describes, reached from the card instead of from
 * a terminal. Nothing new is invented: `parseMbid` is the same parser the wizard's search box
 * uses (so a musicbrainz.org URL is accepted as readily as a bare id), `pinnedRelease` is the
 * same lookup-and-score the wizard's "I know the answer" path runs, `imports.options.releaseMbid`
 * is the field `mm import --release <mbid>` writes, and `match` reads it through the very
 * branch that exists for a pin the search never returned.
 *
 * The lookup is done **here**, before anything is written, for one reason: a wrong id pasted
 * into a box has to come back as a sentence about that id while the box is still on screen. Left
 * to the step, it would be a failed job discovered later, which is exactly the round trip this
 * card exists to remove.
 */
export const pinReleaseForItem = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), release: z.string().min(1).max(500) }))
  .handler(async ({ data }): Promise<RelaunchResult> => {
    try {
      const { item, job } = await candidatelessRelease(data.id);

      const ref = parseMbRef(data.release);
      if (ref === null) {
        throw new MMError(
          "INVALID_INPUT",
          `“${data.release.trim()}” does not contain a MusicBrainz release id.`,
          {
            hint: "A release id is 36 characters — 8-4-4-4-12 hexadecimal. Pasting the whole musicbrainz.org/release/… address works too.",
            action: "Check the id",
            status: 400,
          },
        );
      }
      const releaseMbid = ref.mbid;

      let title = releaseMbid;
      try {
        const { candidate } = await pinnedRelease({
          job,
          settings: await loadSettings(db()),
          releaseMbid,
          db: db(),
        });
        title = candidate.title;
      } catch (error) {
        const failure = MMError.from(error);
        if (failure.code === "NOT_FOUND") {
          /*
           * **Name what it is before saying it is wrong.**
           *
           * The same resolver the wizard's box uses. "MusicBrainz does not know a release with
           * id X" is the worst answer available when X is a perfectly good *recording* — it
           * says the id is wrong when the kind is wrong — and it is the exact sentence the
           * owner met one screen over. One extra lookup buys the honest one.
           */
          const what = await resolveMbRef(data.release, {
            job,
            single: false,
            videoTitle: job.title,
            videoSeconds: null,
            db: db(),
          });
          throw new MMError(
            "NOT_FOUND",
            what === null || what.entity === null
              ? `MusicBrainz does not know a release with id ${releaseMbid}.`
              : `That id is a ${what.noun ?? "different kind of entity"} — “${what.title ?? releaseMbid}” — and this card needs a release.`,
            {
              hint:
                what === null || what.entity === null
                  ? `Open musicbrainz.org/release/${releaseMbid} to check it.`
                  : "Open it on musicbrainz.org and copy the release's own id, or use the wizard, where any kind of id is accepted.",
              action: "Check the id",
              status: 404,
            },
          );
        }
        // An outage, a rate limit, a stale cassette: said as it is rather than reported as a
        // release that does not exist, which would send somebody looking for the wrong bug.
        throw failure;
      }

      await setImportOptions(job.id, { releaseMbid }, { releaseMbid }, db());
      /*
       * Answered as a `retry` from `match`, which is vocabulary the Inbox already has: the
       * resolution is logged in `decisions` like any other, `applyResolution` rewinds and
       * re-queues, and nothing here learns how to restart a job on its own.
       */
      await resolveInboxItem(
        item.id,
        {
          resolution: { action: "retry", step: "match", releaseMbid },
          decidedBy: "user",
        },
        db(),
      );

      return { importId: job.id, pinned: title, nextId: await nextOpenId() };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Search again under the album title without its edition qualifier.
 *
 * Thirty of the owner's imports are stuck on "The search came back empty" because the playlist
 * says *Expanded Edition* / *Deluxe* / *Bonus Track Version* and MusicBrainz never published
 * that edition — while the base title returns twelve of them.
 *
 * **The stripping itself is not implemented here.** It is `stripEditionQualifier` in
 * `packages/domain/src/normalize/title.ts`, reached through `lib/edition-qualifier.ts` — the
 * same function the matcher's own base-title rung uses, so this button offers exactly the
 * search `match` would otherwise have had to guess at. What *is* here is the wiring: an
 * explicit album title on the import, which `match` prefers over the hint it derives from the
 * videos' own tags.
 */
export const searchWithoutQualifier = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<RelaunchResult> => {
    try {
      const { item, job } = await candidatelessRelease(data.id);
      const base = editionBaseTitle(job.title);
      if (base === null) {
        throw new MMError(
          "INVALID_INPUT",
          `“${job.title ?? job.url}” carries no edition qualifier to drop.`,
          {
            hint: "This shortcut only removes a trailing “(Expanded Edition)”, “(Deluxe)” or “(Bonus Track Version)”. Paste a release id instead.",
            status: 400,
          },
        );
      }

      await setImportOptions(job.id, { albumTitle: base }, {}, db());
      await resolveInboxItem(
        item.id,
        { resolution: { action: "retry", step: "match", albumTitle: base }, decidedBy: "user" },
        db(),
      );

      return { importId: job.id, pinned: base, nextId: await nextOpenId() };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Un-hide a subject, or all of them: the way back from "stop asking".
 *
 * Deleting the memory is the whole undo — the next scan, verify or Discover sync walks the
 * same library and, finding nothing that says otherwise, raises the question again. Nothing
 * is resurrected here, because the item that carried the question is gone and rebuilding it
 * from a row that describes a library of some weeks ago would be a fiction.
 */
export const askInboxAgain = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z
      .object({ subject: z.string().min(1).optional(), all: z.boolean().default(false) })
      .refine((value) => value.all || value.subject !== undefined, {
        message: "Give a `subject`, or `all: true`.",
      }),
  )
  .handler(async ({ data }): Promise<{ readonly forgotten: number }> => {
    try {
      if (data.all) return { forgotten: await forgetInboxDismissals({}, db()) };
      const subject = data.subject ?? "";
      const removed = await forgetInboxDismissal(subject, db());
      if (!removed) {
        throw new MMError("NOT_FOUND", `Nothing hidden under ${subject}.`, {
          status: 404,
          hint: "It may already have been un-hidden; reload the review queue.",
        });
      }
      return { forgotten: 1 };
    } catch (error) {
      return toFailure(error);
    }
  });

export type { InboxType };
