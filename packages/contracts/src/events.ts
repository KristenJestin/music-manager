/**
 * The job event, as it leaves the server.
 *
 * One shape for three consumers: the SSE stream the Console subscribes to
 * (`GET /api/events?import=…`), the `--follow` mode of the CLI, and the REST journal of P08.
 * It is a projection of a `job_events` row, so anything the stream shows can be replayed
 * from the database after a reload.
 */
import { z } from "zod";

/** The eight steps of `docs/04-pipeline-et-matching.md`, as a wire value. */
export const STEP_NAMES = [
  "resolve",
  "match",
  "confirm",
  "download",
  "fingerprint",
  "tag",
  "place",
  "verify",
] as const;
export type StepName = (typeof STEP_NAMES)[number];
export const stepNameSchema = z.enum(STEP_NAMES);

/**
 * The event names the orchestrator emits. Dotted, `subject.verb`, so a consumer can filter on
 * a prefix. Not an enum on the wire — a newer server may emit a name an older client should
 * simply ignore rather than reject.
 */
export const JOB_EVENT_TYPES = [
  "import.created",
  "import.status",
  "import.done",
  "import.failed",
  "import.cancelled",
  "step.started",
  "step.done",
  "step.blocked",
  "step.failed",
  "step.skipped",
  /** A step failed and the machine rewound to an earlier one instead of stopping the job. */
  "step.restarting",
  "track.started",
  "track.progress",
  /** The toolbox's single download slot is taken; this track is queueing, not failing. */
  "track.waiting",
  "track.done",
  "track.skipped",
  "track.failed",
  "inbox.created",
  "inbox.resolved",
  "heartbeat",
] as const;

export const jobEventSchema = z.object({
  id: z.number(),
  importId: z.string().nullable(),
  trackId: z.string().nullable(),
  step: stepNameSchema.nullable(),
  level: z.enum(["info", "warn", "error"]),
  type: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  at: z.string(),
});

export type JobEventPayload = z.infer<typeof jobEventSchema>;
