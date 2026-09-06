/**
 * The eight steps of a job as eight bars, small enough to live in a table cell.
 *
 * It answers one question at a glance — *how far did this get before it stopped?* — which is
 * the question you actually have when you look down a list of twenty jobs. Colour carries the
 * outcome: green behind, blue blinking on the current one, amber when a human is being waited
 * for, red where it broke.
 */
import { cn } from "cn";
import { STEPS, type ImportStatus, type StepName } from "#/server/db/schema/enums.vocab.ts";

export interface PipelineDotsProps {
  readonly step: StepName;
  readonly status: ImportStatus;
  readonly className?: string;
}

export function PipelineDots({ step, status, className }: PipelineDotsProps) {
  const index = STEPS.indexOf(step);
  return (
    <div
      data-slot="pipeline"
      className={cn("flex gap-0.5", className)}
      title={STEPS.join(" › ")}
      aria-label={`${step}, ${status}`}
    >
      {STEPS.map((name, position) => {
        const state =
          status === "done"
            ? "done"
            : status === "failed" && position === index
              ? "fail"
              : (status === "awaiting_review" || status === "awaiting_confirm") &&
                  position === index
                ? "wait"
                : position < index
                  ? "done"
                  : position === index && status === "running"
                    ? "active"
                    : position === index
                      ? "wait"
                      : "todo";
        return (
          <i
            key={name}
            title={name}
            className={cn(
              "h-1.5 w-3.5 rounded-xs bg-surface-3",
              state === "done" && "bg-ok",
              state === "active" && "animate-blink bg-info",
              state === "fail" && "bg-danger",
              state === "wait" && "bg-warn",
            )}
          />
        );
      })}
    </div>
  );
}
