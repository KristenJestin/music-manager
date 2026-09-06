/**
 * Every closed vocabulary of the pipeline, as Postgres enums.
 *
 * They live in one file because they are the shared alphabet of `docs/04-pipeline-et-matching.md`:
 * the eight steps, the states an import can rest in, the Inbox item types. A value added here
 * is a migration, which is exactly the friction such a vocabulary deserves.
 *
 * **The arrays themselves are in `enums.vocab.ts`, which imports nothing.** Only the `pgEnum`
 * wrappers live here, because `pgEnum` drags `drizzle-orm/pg-core` in with it and the Console
 * needs a few of these arrays as values in the browser. Server code is unaffected: every name
 * of the vocabulary is re-exported below, so this module stays the one import for the schema.
 */
import { pgEnum } from "drizzle-orm/pg-core";
import {
  DECISION_KINDS,
  EVENT_LEVELS,
  IMPORT_KINDS,
  IMPORT_STATUSES,
  INBOX_STATUSES,
  INBOX_TYPES,
  STEP_STATUSES,
  STEPS,
  TRACK_ROLES,
  TRACK_STATES,
} from "#/server/db/schema/enums.vocab.ts";

export * from "#/server/db/schema/enums.vocab.ts";

export const stepEnum = pgEnum("step_name", STEPS);
export const importStatusEnum = pgEnum("import_status", IMPORT_STATUSES);
export const importKindEnum = pgEnum("import_kind", IMPORT_KINDS);
export const stepStatusEnum = pgEnum("step_status", STEP_STATUSES);
export const trackStateEnum = pgEnum("track_state", TRACK_STATES);
export const trackRoleEnum = pgEnum("track_role", TRACK_ROLES);
export const inboxTypeEnum = pgEnum("inbox_type", INBOX_TYPES);
export const inboxStatusEnum = pgEnum("inbox_status", INBOX_STATUSES);
export const eventLevelEnum = pgEnum("event_level", EVENT_LEVELS);
export const decisionKindEnum = pgEnum("decision_kind", DECISION_KINDS);
