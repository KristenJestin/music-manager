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
 *  - `awaiting_confirm` — the `confirm` step is blocking on a human (no `--yes`);
 *  - `awaiting_review`  — an Inbox item must be resolved before the job can go on;
 *  - `paused`           — stopped on purpose, resumable;
 *  - `failed`           — a step gave up; `mm retry` re-runs it.
 */
export const IMPORT_STATUSES = [
  "pending",
  "running",
  "awaiting_confirm",
  "awaiting_review",
  "paused",
  "done",
  "failed",
  "cancelled",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

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

/** The twelve Inbox item types of `docs/04-pipeline-et-matching.md` § Inbox. */
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
