/**
 * A determinate progress bar, tinted by the outcome it is heading for.
 */
import { cn } from "cn";
import { pctWidth } from "#/lib/format.ts";
import type { Tone } from "#/components/status-badge.tsx";

const FILL: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  muted: "bg-fg-3",
  primary: "bg-primary",
};

export interface ProgressBarProps {
  /** In [0, 1]. */
  readonly value: number;
  readonly tone?: Tone;
  readonly className?: string;
  readonly label?: string;
}

export function ProgressBar({ value, tone = "info", className, label }: ProgressBarProps) {
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, Math.max(0, value)) * 100)}
      aria-label={label}
      className={cn("h-1.5 overflow-hidden rounded-sm bg-surface-3", className)}
    >
      <span
        className={cn("block h-full rounded-sm", FILL[tone])}
        style={{ width: pctWidth(value) }}
      />
    </div>
  );
}
