/**
 * The step machine, as pure functions.
 *
 * `docs/04-pipeline-et-matching.md` gives eight steps in a fixed order and three rules:
 * every step writes its result before the transition, a step can be re-run alone, and a job
 * resumes from wherever it stopped. All three are decisions about *state*, not about I/O, so
 * they live here — no database, no toolbox, no clock — and the step implementations next door
 * only have to say what happened.
 *
 * A step returns one of four outcomes:
 *
 *  - `done`    — move on to the next step;
 *  - `blocked` — a human is needed (`confirm` without `--yes`, an Inbox item to resolve).
 *                The job rests *on* this step and resumes by re-running it;
 *  - `failed`  — the step gave up. `mm retry <id> --step <step>` rewinds to it;
 *  - `skipped` — nothing to do (`replaygain` disabled, every track already present).
 *                Treated exactly like `done` for the purpose of moving on.
 */
import type { MMErrorBody } from "@mm/contracts";
import type { ImportStatus, StepName, StepStatus } from "#/server/db/schema/index.ts";

/** The eight steps, in execution order. Index in this array *is* the progression. */
export const STEP_ORDER = [
  "resolve",
  "match",
  "confirm",
  "download",
  "fingerprint",
  "tag",
  "place",
  "verify",
] as const satisfies readonly StepName[];

export type StepOutcome = "done" | "blocked" | "failed" | "skipped";

export interface StepResult {
  readonly status: StepOutcome;
  /** One line for the journal and for `mm job`. */
  readonly message?: string;
  /** Anything the step wants to remember, stored on `job_steps.result`. */
  readonly data?: Record<string, unknown>;
  /**
   * Why the job is blocked. `confirm` sets `awaiting_confirm`, an Inbox item sets
   * `awaiting_review`; anything else is a deliberate pause.
   */
  readonly blockedAs?: Extract<ImportStatus, "awaiting_confirm" | "awaiting_review" | "paused">;
  /**
   * The failure, in the one shape the whole system uses — including `status` (the HTTP code a
   * bridge call came back with) and `details`. It used to be a narrower inline type, which
   * silently dropped both on the way into `job_steps.error`.
   */
  readonly error?: MMErrorBody;
}

/** Position of a step in the pipeline, or -1 when the name is not one of ours. */
export function stepIndex(step: StepName): number {
  return STEP_ORDER.indexOf(step);
}

/** The step after `step`, or `null` when the pipeline is over. */
export function nextStep(step: StepName): StepName | null {
  const index = stepIndex(step);
  if (index === -1) return null;
  return STEP_ORDER[index + 1] ?? null;
}

/** Every step from `step` to the end. What a resume or a retry has to run. */
export function stepsFrom(step: StepName): readonly StepName[] {
  const index = stepIndex(step);
  return index === -1 ? [] : STEP_ORDER.slice(index);
}

/** True when `a` comes strictly before `b`. */
export function isBefore(a: StepName, b: StepName): boolean {
  return stepIndex(a) < stepIndex(b);
}

export interface Transition {
  readonly step: StepName;
  readonly status: ImportStatus;
  /** What to store on `job_steps.status` for the step that just ran. */
  readonly stepStatus: StepStatus;
  /** True when the runner should immediately execute `step`. */
  readonly continues: boolean;
}

/**
 * Where the job goes after `step` returned `result`.
 *
 * This is the whole of the machine. Everything else — retries, resume, cancel — is expressed
 * as "pick a step, then keep applying this function".
 */
export function transition(step: StepName, result: StepResult): Transition {
  switch (result.status) {
    case "done":
    case "skipped": {
      const following = nextStep(step);
      const stepStatus: StepStatus = result.status === "skipped" ? "skipped" : "done";
      if (following === null) {
        return { step, status: "done", stepStatus, continues: false };
      }
      return { step: following, status: "running", stepStatus, continues: true };
    }
    case "blocked":
      return {
        // The job rests *on* the blocking step: resuming means running it again, now that
        // the answer exists. Moving past it would lose the reason it stopped.
        step,
        status: result.blockedAs ?? "paused",
        stepStatus: "blocked",
        continues: false,
      };
    case "failed":
      return { step, status: "failed", stepStatus: "failed", continues: false };
  }
}

/** Statuses from which nothing more will happen without a human. */
export const TERMINAL_STATUSES = ["done", "failed", "cancelled"] as const;

export function isTerminal(status: ImportStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Statuses a `resume` may pick up again. */
export function isResumable(status: ImportStatus): boolean {
  return status === "pending" || status === "running" || status === "paused";
}

/**
 * Where a job should restart.
 *
 * A step that finished is not re-run; the first one that did not is where work resumes. A
 * blocked step *is* re-run, because the thing that blocked it has presumably been answered.
 */
export function resumePoint(
  completed: Partial<Record<StepName, StepStatus>>,
  fallback: StepName = "resolve",
): StepName {
  for (const step of STEP_ORDER) {
    const status = completed[step];
    if (status !== "done" && status !== "skipped") return step;
  }
  return fallback;
}

/**
 * The pause between two downloads, in milliseconds.
 *
 * `docs/04` asks for 5–15 s. A fixed delay is a signature; a uniform draw inside the window
 * is not, and it costs nothing. `random` is injected so the test is not a coin flip.
 */
export function jitterMs(min: number, max: number, random: () => number = Math.random): number {
  const low = Math.max(0, Math.min(min, max));
  const high = Math.max(0, Math.max(min, max));
  if (high === low) return low;
  return low + Math.floor(random() * (high - low + 1));
}

/**
 * Backoff after a failed attempt: `base × 2^(attempt-1)`, capped.
 *
 * `attempt` is 1-based — the pause *after* the first failure is `base`. The cap matters more
 * than the curve: without it the fourth retry of a long album would land tomorrow.
 */
export function backoffMs(attempt: number, base: number, max: number): number {
  if (attempt <= 0) return 0;
  const raw = base * 2 ** (attempt - 1);
  return Math.min(Math.max(0, max), Math.max(0, raw));
}
