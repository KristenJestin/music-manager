/**
 * The eight steps of a job, in two sizes, from one vocabulary.
 *
 * `PipelineDots` answers one question at a glance — *how far did this get before it stopped?*
 * — which is the question you actually have when you look down a list of twenty jobs.
 * `PipelineStepper` answers the same question on the job's own page, at reading size.
 *
 * They share :func:`stepStates`, and that is the point: the owner's review found the list
 * showing a running step blinking blue and a failed one red, while the detail page showed
 * both of them a flat amber, because the detail used the wizard's neutral `Stepper`. One job,
 * two colours, no explanation. Colour now carries the outcome in both places — green behind,
 * blue blinking on the current one, amber when a human is being waited for, red where it
 * broke — and a change here reaches the list and the detail together.
 *
 * **Owner review, fourth round (F3).** `stepStates` used to take one step name (`job.step`,
 * the head) and colour everything before it green, everything after it grey. That read as
 * "download, then fingerprint, then tag, then place" — a straight line. Since decision 147 it
 * is not one: `fingerprint`, `tag` and `place` run per track, overlapping `download` and each
 * other, and the header stepper kept showing a single blue dot while three steps were really
 * running at once. The fix is to stop inferring state from a position and read it off the
 * steps themselves — `job_steps.status` already says `running` on every step that is, thanks
 * to `syncLocalSteps` (`server/services/jobs/pipeline.ts`) — and to add the `done/total` count
 * per track that makes "running" honest rather than vague. The **head** step (`job.step`,
 * still "the first one not finished") stays visually first among equals, because it is still
 * the one answer to "what is this job doing" that fits in one word.
 */
import { cn } from "cn";
import {
  STEPS,
  type ImportStatus,
  type StepName,
  type StepStatus,
  type TrackState,
} from "#/server/db/schema/enums.vocab.ts";
import type { Tone } from "#/components/status-badge.tsx";

/** What one step looks like right now, independently of how big it is drawn. */
export type StepState = "done" | "active" | "wait" | "fail" | "todo";

/** The tone of every step state, in the vocabulary of `status-badge.tsx`. */
export const STEP_STATE_TONE: Record<StepState, Tone> = {
  done: "ok",
  active: "info",
  wait: "warn",
  fail: "danger",
  todo: "muted",
};

/** A one-word gloss, used as the accessible name and the tooltip. */
export const STEP_STATE_LABEL: Record<StepState, string> = {
  done: "done",
  active: "running",
  wait: "waiting",
  fail: "failed",
  todo: "not run",
};

/** One position of the stepper: the step's name and its `job_steps` row, if it has one yet. */
export interface StepRow {
  readonly step: StepName;
  readonly row: { readonly status: StepStatus } | null;
}

/**
 * The state of every step of a job, read off its own `job_steps` row rather than off a
 * position — which is what lets more than one come back `active` at once.
 *
 * `row === null` means the step has never run: nothing has reached it yet, and that is
 * `"todo"` regardless of overall status. A `done` import overrides everything to `"done"`,
 * since a step can finish and its row still say `skipped` or the row can be missing entirely
 * for a step nothing needed (`replaygain` off, no extras) — neither should read as unfinished
 * work. A `cancelled` import turns every unfinished row to `"todo"`: there is nothing left
 * running to call `active`, and nothing left to call `wait` for either.
 */
export function stepStates(steps: readonly StepRow[], status: ImportStatus): StepState[] {
  return steps.map(({ row }) => {
    if (status === "done") return "done";
    if (row === null) return "todo";
    if (status === "cancelled" && row.status !== "done" && row.status !== "skipped") return "todo";
    switch (row.status) {
      case "done":
      case "skipped":
        return "done";
      case "running":
        return "active";
      case "blocked":
      case "pending":
        return "wait";
      case "failed":
        return "fail";
    }
  });
}

/**
 * The four steps a track passes through one at a time: the single global `download` slot,
 * then the three per-track steps of decision 147. Index in this array plus one is the track's
 * rank once it has passed that step — `downloaded` is rank 1, `placed`/`done` is rank 4.
 */
export const PIPELINE_STEPS = ["download", "fingerprint", "tag", "place"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export function isPipelineStep(step: StepName): step is PipelineStep {
  return (PIPELINE_STEPS as readonly string[]).includes(step);
}

/**
 * How far a track has travelled, for the stepper's counters only — `done`, `skipped` and
 * `failed` all count as having passed everything still ahead, the same convention the
 * server's own `hasPassed` uses (`server/services/jobs/machine.ts`): the count answers "how
 * many are through this step", not "how many stopped there on purpose".
 */
const RANK: Partial<Record<TrackState, number>> = {
  pending: 0,
  downloaded: 1,
  fingerprinted: 2,
  tagged: 3,
  placed: 4,
  done: 4,
  skipped: 4,
  failed: 4,
};

/**
 * `{done, total}` for one pipelined step, over every track of the import — extras included,
 * the same denominator the "Tracks" header above the table already uses (`tracksDone` /
 * `tracks.length`). Owner review F3: "download 8/17, fingerprint 4/17, tag 2/17, place 2/17".
 */
export function pipelineCount(
  tracks: readonly { readonly state: TrackState }[],
  step: PipelineStep,
): { readonly done: number; readonly total: number } {
  const rank = PIPELINE_STEPS.indexOf(step) + 1;
  const done = tracks.filter((track) => (RANK[track.state] ?? 0) >= rank).length;
  return { done, total: tracks.length };
}

const DOT_TONE: Record<StepState, string> = {
  done: "bg-ok",
  active: "animate-blink bg-info",
  wait: "bg-warn",
  fail: "bg-danger",
  todo: "bg-surface-3",
};

export interface PipelineDotsProps {
  readonly steps: readonly StepRow[];
  /** The step the job is resting on — the first not finished. Drawn with a ring. */
  readonly headStep: StepName;
  readonly status: ImportStatus;
  readonly className?: string;
}

/** Eight bars, small enough to live in a table cell. */
export function PipelineDots({ steps, headStep, status, className }: PipelineDotsProps) {
  const states = stepStates(steps, status);
  return (
    <div
      data-slot="pipeline"
      className={cn("flex gap-0.5", className)}
      title={STEPS.join(", ")}
      aria-label={`${headStep}, ${status}`}
    >
      {steps.map(({ step }, position) => {
        const state = states[position] ?? "todo";
        const isHead = step === headStep;
        return (
          <i
            key={step}
            data-state={state}
            data-head={isHead ? "true" : undefined}
            title={`${step}: ${STEP_STATE_LABEL[state]}`}
            className={cn(
              "h-1.5 w-3.5 rounded-xs",
              DOT_TONE[state],
              isHead && "ring-1 ring-info/70 ring-offset-1 ring-offset-surface-1",
            )}
          />
        );
      })}
    </div>
  );
}

const BULLET_TONE: Record<StepState, string> = {
  done: "border-ok bg-ok text-background",
  active: "animate-blink border-info bg-info text-background",
  wait: "border-warn bg-warn text-background",
  fail: "border-danger bg-danger text-background",
  todo: "border-line-strong text-fg-3",
};

const LABEL_TONE: Record<StepState, string> = {
  done: "text-fg-1",
  active: "text-info",
  wait: "text-warn",
  fail: "text-danger",
  todo: "text-fg-3",
};

export interface PipelineStepperProps {
  readonly steps: readonly StepRow[];
  /** The step the job is resting on — the first not finished. Shown in bold, ringed. */
  readonly headStep: StepName;
  readonly status: ImportStatus;
  /** For the per-track counters (`download 8/17`). Omit where tracks are not loaded. */
  readonly tracks?: readonly { readonly state: TrackState }[];
  readonly className?: string;
}

/** The same eight steps, named and at reading size, for a job's own page. */
export function PipelineStepper({
  steps,
  headStep,
  status,
  tracks = [],
  className,
}: PipelineStepperProps) {
  const states = stepStates(steps, status);
  return (
    <ol
      data-slot="pipeline-stepper"
      className={cn("flex list-none flex-wrap items-center", className)}
      aria-label={`${headStep}, ${status}`}
    >
      {steps.map(({ step }, position) => {
        const state = states[position] ?? "todo";
        const isHead = step === headStep;
        const count = isPipelineStep(step) ? pipelineCount(tracks, step) : null;
        return (
          <li
            key={step}
            data-state={state}
            data-head={isHead ? "true" : undefined}
            title={`${step}: ${STEP_STATE_LABEL[state]}${count === null ? "" : ` (${String(count.done)}/${String(count.total)})`}`}
            className={cn(
              "relative flex items-center gap-1.5 pr-6 text-xs",
              "after:absolute after:top-1/2 after:right-1.5 after:h-px after:w-2.5 after:bg-line-strong after:content-['']",
              "last:pr-0 last:after:hidden",
              LABEL_TONE[state],
              isHead && "font-semibold",
            )}
          >
            <b
              className={cn(
                "grid size-5 place-items-center rounded-full border text-3xs font-semibold",
                BULLET_TONE[state],
                isHead && "ring-2 ring-info/50 ring-offset-1 ring-offset-surface-1",
              )}
            >
              {position + 1}
            </b>
            <span>
              {step}
              {count === null ? null : (
                <span className="ml-1 font-mono text-3xs text-fg-3" data-testid="step-count">
                  {count.done}/{count.total}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
