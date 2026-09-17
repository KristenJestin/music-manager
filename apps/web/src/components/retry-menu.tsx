/**
 * Retry, with the step on the button rather than in a terminal.
 *
 * `retryJob` has taken a step since P03 and the Console never sent one, so a finished album could
 * only be retried from its resume point — `verify` for a job whose every step finished — and
 * forcing a re-match meant `mm retry --step match` somewhere else entirely. Fifteen finished
 * albums were in that state.
 *
 * A split control: the main half is the plain Retry that was always there, and the chevron opens
 * the list of steps this particular import can be retried from (`retryOptionsFor`). Each row says
 * **what it will redo**, because "match" and "tag" mean nothing to somebody who has not read the
 * pipeline documentation, and the difference between them is the difference between losing a
 * confirmed mapping and not.
 *
 * A step that throws work away goes through `ConfirmDialog` carrying its own `warning`, and it is
 * the menu entry that decides that — not this component — so the sentence a person reads before
 * pressing and the behaviour of the server are two readings of one list.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, RotateCcw } from "lucide-react";
import { cn } from "cn";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { ConfirmDialog } from "#/components/library/confirm-dialog.tsx";
import { retryOptionsFor, type RetryOption } from "#/server/services/retry-plan.ts";
import type { ImportStatus, StepName } from "#/server/db/schema/enums.vocab.ts";

export interface RetryMenuProps {
  /** The import, as far as this control is concerned: how far it got, and whether it is over. */
  readonly job: { readonly status: ImportStatus; readonly step: StepName };
  /** Runs the retry. `undefined` is the plain Retry, from the import's own resume point. */
  readonly onRetry: (step?: StepName) => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly size?: "default" | "xs";
  /** The word on the main half. The pages say "Queueing…" and "Running…" through it. */
  readonly label?: string;
  readonly title?: string;
}

export function RetryMenu({
  job,
  onRetry,
  disabled = false,
  busy = false,
  size = "default",
  label = "Retry",
  title,
}: RetryMenuProps) {
  const [confirming, setConfirming] = useState<RetryOption | null>(null);
  const options = retryOptionsFor(job);

  // Nothing worth a menu: one option is the resume point the main half already runs.
  const withMenu = options.length > 1;

  const run = (option: RetryOption): void => {
    if (option.destructive) setConfirming(option);
    else onRetry(option.step);
  };

  return (
    <>
      {/* The click stops here. On the jobs list the whole row navigates, and a chevron that
          opened a menu *and* walked away from the page would be unusable. The popup itself is
          portalled to the body, so a menu entry never bubbles through the row at all. */}
      <div
        className="flex"
        data-testid="job-retry-control"
        onClick={(event) => {
          event.stopPropagation();
        }}
        role="presentation"
      >
        <Button
          data-testid="job-retry"
          size={size}
          variant={size === "xs" ? "outline" : "default"}
          disabled={disabled}
          {...(title === undefined ? {} : { title })}
          className={withMenu ? "rounded-r-none" : undefined}
          onClick={() => {
            onRetry();
          }}
        >
          <RotateCcw aria-hidden="true" /> {label}
        </Button>
        {withMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="job-retry-menu"
              aria-label="Choose the step to retry from"
              disabled={disabled}
              className={cn(
                buttonVariants({
                  variant: size === "xs" ? "outline" : "default",
                  size: size === "xs" ? "icon-xs" : "icon",
                }),
                "rounded-l-none border-l border-line",
              )}
            >
              <ChevronDown aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              {/* The group is not decoration: Base UI's `Menu.GroupLabel` throws outside a
                  `Menu.Group`, and an error boundary is what the page shows for it. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Retry from…</DropdownMenuLabel>
                {options.map((option) => (
                  <DropdownMenuItem
                    key={option.step}
                    data-testid={`job-retry-step-${option.step}`}
                    variant={option.destructive ? "destructive" : "default"}
                    className="items-start"
                    onClick={() => {
                      run(option);
                    }}
                  >
                    <span className="flex flex-col gap-0.5 py-0.5">
                      <span className="flex items-center gap-1.5 font-medium">
                        {option.label}
                        <span className="font-mono text-2xs text-fg-3">{option.step}</span>
                        {option.destructive ? (
                          <AlertTriangle className="size-3" aria-label="Discards work" />
                        ) : null}
                      </span>
                      <span className="text-2xs whitespace-normal text-fg-2">{option.detail}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {/* The warning is the menu entry's own, so the dialog cannot say something the server
          will not do. `destructive={false}`: nothing is deleted from disk — what is lost is a
          decision, and painting it like a delete would make the real deletes read as routine. */}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        testId="job-retry-confirm"
        title={`${confirming?.label ?? "Retry"}?`}
        description={confirming?.detail ?? ""}
        consequence={confirming?.warning ?? undefined}
        confirmLabel={confirming?.label ?? "Retry"}
        destructive={false}
        busy={busy}
        onConfirm={() => {
          const step = confirming?.step;
          setConfirming(null);
          if (step !== undefined) onRetry(step);
        }}
      />
    </>
  );
}
