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
 */
import { cn } from "cn";
import { STEPS, type ImportStatus, type StepName } from "#/server/db/schema/enums.vocab.ts";
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

/**
 * The state of every step of a job, given where it stopped and why.
 *
 * A done job is done all the way through, whatever step it rests on; everything before the
 * current step has been passed; the current step carries the job's status.
 */
export function stepStates(step: StepName, status: ImportStatus): StepState[] {
  const index = STEPS.indexOf(step);
  return STEPS.map((_name, position) => {
    if (status === "done") return "done";
    if (position < index) return "done";
    if (position > index) return "todo";
    if (status === "failed") return "fail";
    if (status === "running") return "active";
    if (status === "cancelled") return "todo";
    return "wait";
  });
}

const DOT_TONE: Record<StepState, string> = {
  done: "bg-ok",
  active: "animate-blink bg-info",
  wait: "bg-warn",
  fail: "bg-danger",
  todo: "bg-surface-3",
};

export interface PipelineDotsProps {
  readonly step: StepName;
  readonly status: ImportStatus;
  readonly className?: string;
}

/** Eight bars, small enough to live in a table cell. */
export function PipelineDots({ step, status, className }: PipelineDotsProps) {
  const states = stepStates(step, status);
  return (
    <div
      data-slot="pipeline"
      className={cn("flex gap-0.5", className)}
      title={STEPS.join(", ")}
      aria-label={`${step}, ${status}`}
    >
      {STEPS.map((name, position) => {
        const state = states[position] ?? "todo";
        return (
          <i
            key={name}
            data-state={state}
            title={`${name}: ${STEP_STATE_LABEL[state]}`}
            className={cn("h-1.5 w-3.5 rounded-xs", DOT_TONE[state])}
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
  readonly step: StepName;
  readonly status: ImportStatus;
  readonly className?: string;
}

/** The same eight steps, named and at reading size, for a job's own page. */
export function PipelineStepper({ step, status, className }: PipelineStepperProps) {
  const states = stepStates(step, status);
  return (
    <ol
      data-slot="pipeline-stepper"
      className={cn("flex list-none flex-wrap items-center", className)}
      aria-label={`${step}, ${status}`}
    >
      {STEPS.map((name, position) => {
        const state = states[position] ?? "todo";
        return (
          <li
            key={name}
            data-state={state}
            title={`${name}: ${STEP_STATE_LABEL[state]}`}
            className={cn(
              "relative flex items-center gap-1.5 pr-6 text-xs",
              "after:absolute after:top-1/2 after:right-1.5 after:h-px after:w-2.5 after:bg-line-strong after:content-['']",
              "last:pr-0 last:after:hidden",
              LABEL_TONE[state],
            )}
          >
            <b
              className={cn(
                "grid size-5 place-items-center rounded-full border text-3xs font-semibold",
                BULLET_TONE[state],
              )}
            >
              {position + 1}
            </b>
            <span>{name}</span>
          </li>
        );
      })}
    </ol>
  );
}
