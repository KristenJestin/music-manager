/**
 * The horizontal stepper: the wizard's four steps, and a job's eight.
 *
 * `current` is where you are; `done` is how many are behind you. They are separate because a
 * job can rest *on* a step that has not finished (`download`, running) and because the wizard
 * lets you walk back into a step you already completed.
 */
import { cn } from "cn";

export interface StepperProps {
  readonly steps: readonly string[];
  /** Zero-based index of the step being shown. */
  readonly current: number;
  /** How many leading steps are finished. Defaults to `current`. */
  readonly done?: number;
  /** Called when a finished step is clicked; without it the stepper is not interactive. */
  readonly onSelect?: (index: number) => void;
  readonly className?: string;
}

export function Stepper({ steps, current, done, onSelect, className }: StepperProps) {
  const complete = done ?? current;
  return (
    <ol data-slot="stepper" className={cn("flex list-none items-center", className)}>
      {steps.map((step, index) => {
        const isDone = index < complete;
        const isActive = index === current;
        const clickable = onSelect !== undefined && isDone;
        const body = (
          <>
            <b
              className={cn(
                "grid size-5 place-items-center rounded-full border border-line-strong text-3xs font-semibold",
                isDone && "border-ok bg-ok text-background",
                isActive && "border-primary bg-primary text-primary-foreground",
              )}
            >
              {index + 1}
            </b>
            <span>{step}</span>
          </>
        );
        return (
          <li
            key={step}
            data-state={isDone ? "done" : isActive ? "active" : "todo"}
            className={cn(
              "relative flex items-center gap-1.5 pr-6 text-xs text-fg-3",
              "after:absolute after:top-1/2 after:right-1.5 after:h-px after:w-2.5 after:bg-line-strong after:content-['']",
              "last:pr-0 last:after:hidden",
              isDone && "text-fg-1",
              isActive && "text-foreground",
            )}
          >
            {clickable ? (
              <button
                type="button"
                className="flex cursor-pointer items-center gap-1.5"
                onClick={() => {
                  onSelect(index);
                }}
              >
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}
