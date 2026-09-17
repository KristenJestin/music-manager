/**
 * What an Inbox answer *means*, decided before anything is written.
 *
 * `applyResolution` used to open with `if (typeof action !== "string") return;` — so every
 * answer that is a **choice** rather than a verb fell through it in silence. An
 * `ambiguous_recording` card offers `{recordingMbid: "…"}`, an `ambiguous_release` card offers
 * `{releaseMbid: "…"}`, and neither carries an `action`: the item was marked `resolved`, a
 * `decisions` row was written, the Console said "Decision saved; the job resumes" and the job
 * stayed `Blocked` at `match` for ever. The owner's *Good Luck, Babe!* is that bug, and it
 * threw away a decision he had taken.
 *
 * Two properties fix it for good, and both live here rather than in the caller:
 *
 *  - **the plan is computed before the item is closed.** `planResolution` is pure and it
 *    throws; `resolveInboxItem` calls it first, so an answer nothing can carry out leaves the
 *    item open and the person looking at the card instead of at a queue that quietly emptied;
 *  - **nothing is handled by falling through.** Every verb this Inbox can produce is named in
 *    one of the two lists below, and an answer that is in neither — a new option someone adds
 *    to `optionsFor` and forgets to wire — is an `INVALID_INPUT`, loudly, on the first click.
 *
 * A third list, `SILENCING_ACTIONS`, is a strict subset of the closing ones and answers a
 * different question: which of them mean "and stop asking" rather than "not now". It exists
 * because a scan rebuilds its items from scratch, so a verb read as merely closing is a verb
 * that gets asked again tomorrow (`services/inbox-dismissals.ts`).
 */
import { MMError } from "@mm/contracts";
import type { InboxType } from "#/server/db/schema/enums.vocab.ts";

/**
 * The item types whose answer *is* a MusicBrainz entity.
 *
 * On these, and only on these, a bare `{releaseMbid}` or `{recordingMbid}` is the whole answer
 * and has to be applied. Everywhere else an MBID in the resolution is context — a
 * `verify_mismatch` payload naming the album it is about — and must not pin anything.
 */
const CHOICE_TYPES: ReadonlySet<InboxType> = new Set<InboxType>([
  "ambiguous_release",
  "ambiguous_recording",
]);

/**
 * Verbs whose whole effect is the item closing.
 *
 * "I have seen it", "not now", "import what we have anyway". The job is re-queued by whoever
 * resolved the item, exactly as before; there is nothing for this module to do. They are
 * listed by name rather than caught by a default branch, because the point of the list is that
 * a verb missing from it is a bug and says so.
 */
const CLOSING_ACTIONS: ReadonlySet<string> = new Set([
  "snooze",
  "dismiss",
  "ignore",
  "accept",
  "import anyway",
  "accept_partial",
  "accept_navidrome",
  "keep_all",
  "keep_version",
  "keep_embedded",
  "keep_anonymous",
  "keep-mapping",
  "cookies_renewed",
]);

/**
 * The closing verbs that also mean **"and stop asking"**, as opposed to "not now".
 *
 * `snooze` is the one deliberately missing from this list, and the omission is the whole
 * distinction: "Later" leaves the question to be asked again, which is exactly right for a
 * question you have not answered yet. Everything below *is* an answer.
 *
 *  - `dismiss` and `ignore` say so in the general case — they are what a batch "reject" sends;
 *  - `keep_all`, `accept_partial` and `accept_navidrome` are the same sentence in the words of
 *    one card: "these two copies are both meant to be there", "this album is as complete as it
 *    will ever be", "that field is simply not indexed". The owner pressed *Keep both copies*
 *    eleven times and the scan asked eleven times more, so treating the affirmative verb of a
 *    scan card as anything but final was the bug.
 *
 * What it silences is a *subject*, and only for the types a scan rebuilds — see
 * `services/inbox-dismissals.ts`, which owns the key and therefore owns what expires.
 */
const SILENCING_ACTIONS: ReadonlySet<string> = new Set([
  "dismiss",
  "ignore",
  "keep_all",
  "accept_partial",
  "accept_navidrome",
]);

/**
 * Does this answer mean "and do not raise this again"?
 *
 * Pure, and separate from `planResolution` for the reason `planResolution` is separate from
 * `resolveInboxItem`: it is decided before anything is written, and it is unit-testable
 * without a database.
 */
export function silencesSubject(resolution: Record<string, unknown>): boolean {
  const action = text(resolution["action"]);
  return action !== null && SILENCING_ACTIONS.has(action);
}

/**
 * Verbs the *Console* carries out by navigating somewhere, not by resolving the item.
 *
 * `review` opens the job page, `choose_cover` opens the album's artwork picker, `retag` and
 * `identify` open the Tools page with the subject filled in. Answering the card is then the
 * record that the question was dealt with, and the act itself happened on another screen. They
 * are separated from `CLOSING_ACTIONS` so that the list keeps saying which is which.
 */
const ELSEWHERE_ACTIONS: ReadonlySet<string> = new Set([
  "review",
  "choose_cover",
  "retag",
  "identify",
]);

/** What answering an item makes the server do. `none` is "close it, and nothing else". */
export type ResolutionPlan =
  | { readonly kind: "none" }
  | { readonly kind: "cancel" }
  | { readonly kind: "confirm" }
  | { readonly kind: "retry"; readonly step: string | null }
  | { readonly kind: "trash"; readonly what: "orphans" | "duplicates" }
  | { readonly kind: "update-ytdlp" }
  | { readonly kind: "reverify" }
  | { readonly kind: "use-acoustid" }
  | { readonly kind: "skip-track" }
  /** Pin the release the reader chose, then match again against it. */
  | { readonly kind: "pin-release"; readonly releaseMbid: string }
  /** Pin the recording the reader chose, filed under the release it is borrowed from. */
  | {
      readonly kind: "pin-recording";
      readonly recordingMbid: string;
      readonly releaseMbid: string | null;
    };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function refuse(item: { readonly type: InboxType }, said: string): never {
  throw new MMError(
    "INVALID_INPUT",
    `Nothing carries out ${said} on a ${item.type} item, so the question stays open.`,
    {
      hint: "Answer it with one of the options the card offers (`GET /api/v1/inbox/{id}` lists them).",
      action: "Pick one of the offered answers",
      status: 400,
    },
  );
}

/**
 * Read an answer as a plan, or refuse it.
 *
 * Pure on purpose: it is the half of the fix that can be unit-tested without a database, and
 * the half that has to run before the row is touched.
 */
export function planResolution(
  item: { readonly type: InboxType },
  resolution: Record<string, unknown>,
): ResolutionPlan {
  const action = text(resolution["action"]);

  if (action !== null) {
    switch (action) {
      case "cancel":
        return { kind: "cancel" };
      case "confirm":
        return { kind: "confirm" };
      case "retry":
        return { kind: "retry", step: text(resolution["step"]) };
      case "trash_orphans":
        return { kind: "trash", what: "orphans" };
      case "trash_duplicates":
        return { kind: "trash", what: "duplicates" };
      case "update_ytdlp":
        return { kind: "update-ytdlp" };
      case "reverify":
        return { kind: "reverify" };
      case "use-acoustid":
        return { kind: "use-acoustid" };
      case "skip-track":
        return { kind: "skip-track" };
      default:
        break;
    }
    if (CLOSING_ACTIONS.has(action) || ELSEWHERE_ACTIONS.has(action)) return { kind: "none" };
    return refuse(item, `\`action: "${action}"\``);
  }

  /* ---- the answers that are a choice rather than a verb ---- */

  if (CHOICE_TYPES.has(item.type)) {
    const recordingMbid = text(resolution["recordingMbid"]);
    if (recordingMbid !== null) {
      return { kind: "pin-recording", recordingMbid, releaseMbid: text(resolution["releaseMbid"]) };
    }
    const releaseMbid = text(resolution["releaseMbid"]);
    if (releaseMbid !== null) return { kind: "pin-release", releaseMbid };
    /*
     * `{accepted: true}` and nothing else, on a card whose whole question is "which one?".
     *
     * That is `mm inbox accept` on an item the step raised without a preselection — the artist
     * refusal and the "nothing came back" refusal both do. There is no answer in it, and
     * closing it would lose the question rather than answer it.
     */
    return refuse(item, "an answer that names no release or recording");
  }

  return { kind: "none" };
}
