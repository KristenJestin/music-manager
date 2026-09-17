/**
 * The closed vocabularies of the pipeline, as plain values — **and nothing else**.
 *
 * This file is the half of `enums.ts` that the browser is allowed to have. The two are split
 * for one reason: `enums.ts` calls `pgEnum`, so importing it pulls `drizzle-orm/pg-core` in
 * behind the vocabulary. The Console legitimately needs some of these arrays as *values* —
 * `STEPS` orders the pipeline dots, and an order cannot be a type — so a component that wanted
 * eight strings was shipping the Drizzle core to every visitor.
 *
 * **Keep this file free of imports.** It has none today, and `client-boundary.guard.test.ts`
 * asserts that it stays that way: the guard lets client code reach into `server/**` only for
 * modules it can prove are pure, and purity here is checked, not promised.
 *
 * `enums.ts` re-exports every name below, so server code keeps importing one module.
 */

/** The eight steps of `docs/04-pipeline-et-matching.md`, in execution order. */
export const STEPS = [
  "resolve",
  "match",
  "confirm",
  "download",
  "fingerprint",
  "tag",
  "place",
  "verify",
] as const;
export type StepName = (typeof STEPS)[number];

/**
 * Where an import currently rests.
 *
 *  - `awaiting_confirm`  — the `confirm` step is blocking on a human (no `--yes`);
 *  - `awaiting_review`   — an Inbox item must be resolved before the job can go on;
 *  - `paused`            — stopped on purpose, resumable;
 *  - `waiting_upstream`  — a source refused (429, 5xx, a timeout) and the job is on the queue
 *                          again with a growing delay. **Not** a failure and not a pause: it
 *                          is running, slowly, and `imports.next_attempt_at` says until when.
 *                          It exists because a busy MusicBrainz used to land in `failed`,
 *                          which is terminal, and forty-five albums were abandoned for it;
 *  - `failed`            — a step gave up; `mm retry` re-runs it. A job that exhausted its
 *                          upstream attempts ends here too, carrying `UPSTREAM_UNAVAILABLE`
 *                          so the row still says *the source*, not *the file*.
 */
export const IMPORT_STATUSES = [
  "pending",
  "running",
  "awaiting_confirm",
  "awaiting_review",
  "paused",
  "waiting_upstream",
  "done",
  "failed",
  "cancelled",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * Who stopped a paused import — and therefore whether a reboot may start it again.
 *
 * `paused` answers "is it stopped"; it has never answered "who stopped it", and the two have
 * opposite consequences at boot. A worker shutting down pauses whatever it was running so that
 * the row stops claiming to be `running` (`runImport`, and every `blockedAs: "paused"` an abort
 * produces); the owner pressing Pause means the opposite — *leave it alone*. Both wrote the same
 * word, so the boot sweep could only ever resume everything, restarting imports somebody had
 * deliberately stopped, or resume nothing, which is what it did.
 *
 * A column rather than a ninth status: `paused` is already public vocabulary — the Console
 * chips, `/api/v1`'s filters, `mm jobs --status`, the MCP tools — and a `paused_by_worker`
 * status would make every `=== "paused"` in the product wrong by omission. This is additive,
 * and a reader that does not ask about it keeps the behaviour it has today.
 *
 * **Only meaningful while `status = 'paused'`.** Every transition *into* `paused` writes it;
 * nothing reads it otherwise. The default on an unexplained pause is `user`, because the
 * expensive mistake is restarting an import the owner stopped, never the reverse.
 */
export const PAUSED_BY = ["user", "worker"] as const;
export type PausedBy = (typeof PAUSED_BY)[number];

/** What the submitted URL turned out to be. */
export const IMPORT_KINDS = ["album", "single", "playlist", "channel"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Outcome of one run of one step. `blocked` is a human gate, not a failure. */
export const STEP_STATUSES = [
  "pending",
  "running",
  "done",
  "blocked",
  "failed",
  "skipped",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** How far one video has travelled. Ordered: each value implies the previous ones. */
export const TRACK_STATES = [
  "pending",
  "downloaded",
  "fingerprinted",
  "tagged",
  "placed",
  "done",
  "skipped",
  "failed",
] as const;
export type TrackState = (typeof TRACK_STATES)[number];

/**
 * What the mapping decided about one video: bound to a track, an `extra_videos` leftover,
 * or not considered at all.
 */
export const TRACK_ROLES = ["mapped", "extra", "unmatched"] as const;
export type TrackRole = (typeof TRACK_ROLES)[number];

/** The Inbox item types of `docs/04-pipeline-et-matching.md` § Inbox, plus the watched sources' own. */
export const INBOX_TYPES = [
  "ambiguous_release",
  "ambiguous_recording",
  "uncovered_tracks",
  "extra_videos",
  "fingerprint_mismatch",
  "job_failed",
  "ytdlp_update",
  "cookies_expiring",
  "album_incomplete",
  "orphan_files",
  "duplicate_recording",
  "verify_mismatch",
  // A migrated file carries a picture no v2 source can account for (P08, migration v1).
  "cover_missing",
  /** A watched source found a video, and the confidence was not high enough to accept it. */
  "source_new_video",
  /**
   * The `confirm` step is blocking on a human, and nothing pointed at it.
   *
   * Not a new word: it is `imports.status`'s own `awaiting_confirm`, used in a second place.
   * The state has existed since P03 and is exactly what `docs/04` § Inbox describes — "une
   * question que le pipeline ne peut pas trancher seul" — but only the *watched source* branch
   * of `confirm` ever raised an item for it, so an import parked there by a batch import, by
   * `mm import` without `--yes`, or by a re-matched job was invisible in the review queue and
   * reachable only from `/api/v1`, MCP or the CLI. Every consumer of the Inbox — the Console,
   * the sidebar count, `list_inbox`, `mm inbox` — gains it by the word existing.
   */
  "awaiting_confirm",
] as const;
export type InboxType = (typeof INBOX_TYPES)[number];

export const INBOX_STATUSES = ["open", "resolved", "dismissed"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

/** Severity of a journal line. The Console colours on this. */
export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/** What a recorded decision was about (`docs/04` § Modèle, `decisions`). */
export const DECISION_KINDS = ["release", "mapping", "inbox", "option"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * What a watched source points at.
 *
 * Two shapes, one behaviour: both are a listing that grows, and the scan only ever asks how
 * it has grown since last time. The distinction is kept because it is what the operator typed
 * and what the Console shows — a channel and a playlist fail for different reasons.
 */
export const WATCHED_SOURCE_KINDS = ["playlist", "channel"] as const;
export type WatchedSourceKind = (typeof WATCHED_SOURCE_KINDS)[number];

/** How the last scan of a source ended. `never` is a source nobody has scanned yet. */
export const WATCHED_SCAN_STATUSES = ["never", "ok", "partial", "failed"] as const;
export type WatchedScanStatus = (typeof WATCHED_SCAN_STATUSES)[number];

/**
 * What became of one video a scan saw.
 *
 *  - `new`      — seen, not yet turned into an import (a scan that stopped halfway);
 *  - `imported` — an import exists for it, whatever that import went on to do;
 *  - `skipped`  — a filter of the source refused it (too short, too long, unavailable);
 *  - `ignored`  — you told it to leave this one alone.
 */
export const WATCHED_ITEM_STATUSES = ["new", "imported", "skipped", "ignored"] as const;
export type WatchedItemStatus = (typeof WATCHED_ITEM_STATUSES)[number];

/**
 * Which files inside its scope a re-tag run covers.
 *
 *  - `behind` — those whose `tag_schema_version` is older than the run's. §8's schema bump, and
 *    a question about `MUSICMANAGER_TAGSCHEMA` rather than about values.
 *  - `adrift` — those whose file disagrees with the database (`quality.tracksAdrift`): the
 *    answer to a re-match or a hand correction. This is the one selection that is about values.
 *  - `all` — everything in scope, current or not.
 *
 * Here rather than in `retag.ts` for the reason `AGENTS.md` gives for `STEPS`: the Console needs
 * it as a *value* — the album page's "Update the files" button sends `adrift` — and it should
 * not cost the visitor `drizzle-orm/pg-core` to have it.
 */
export const RETAG_SELECTIONS = ["behind", "adrift", "all"] as const;
export type RetagSelection = (typeof RETAG_SELECTIONS)[number];
