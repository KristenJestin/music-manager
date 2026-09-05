/**
 * Every closed vocabulary of the pipeline, as Postgres enums.
 *
 * They live in one file because they are the shared alphabet of `docs/04-pipeline-et-matching.md`:
 * the eight steps, the states an import can rest in, the Inbox item types. A value added here
 * is a migration, which is exactly the friction such a vocabulary deserves.
 */
import { pgEnum } from "drizzle-orm/pg-core";

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
export const stepEnum = pgEnum("step_name", STEPS);

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
export const importStatusEnum = pgEnum("import_status", IMPORT_STATUSES);

/** What the submitted URL turned out to be. */
export const IMPORT_KINDS = ["album", "single", "playlist", "channel"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const importKindEnum = pgEnum("import_kind", IMPORT_KINDS);

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
export const stepStatusEnum = pgEnum("step_status", STEP_STATUSES);

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
export const trackStateEnum = pgEnum("track_state", TRACK_STATES);

/**
 * What the mapping decided about one video: bound to a track, an `extra_videos` leftover,
 * or not considered at all.
 */
export const TRACK_ROLES = ["mapped", "extra", "unmatched"] as const;
export type TrackRole = (typeof TRACK_ROLES)[number];
export const trackRoleEnum = pgEnum("track_role", TRACK_ROLES);

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
export const inboxTypeEnum = pgEnum("inbox_type", INBOX_TYPES);

export const INBOX_STATUSES = ["open", "resolved", "dismissed"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const inboxStatusEnum = pgEnum("inbox_status", INBOX_STATUSES);

/** Severity of a journal line. The Console colours on this. */
export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];
export const eventLevelEnum = pgEnum("event_level", EVENT_LEVELS);

/** What a recorded decision was about (`docs/04` § Modèle, `decisions`). */
export const DECISION_KINDS = ["release", "mapping", "inbox", "option"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
export const decisionKindEnum = pgEnum("decision_kind", DECISION_KINDS);
