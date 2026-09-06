/**
 * A [0, 1] score as a bar plus its number.
 *
 * Both, always. The bar is what the eye reads down a column of twenty rows; the number is
 * what you quote when you say why you disagreed with the matcher.
 */
import { cn } from "cn";
import { pct, pctWidth } from "#/lib/format.ts";
import { scoreTone, type Tone } from "#/components/status-badge.tsx";

const FILL: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  muted: "bg-fg-3",
  primary: "bg-primary",
};

export interface ScoreBarProps {
  readonly value: number | null | undefined;
  /** Override the tone the value would get on its own. */
  readonly tone?: Tone;
  /** Hide the percentage, when the row already shows it. */
  readonly hideNumber?: boolean;
  readonly className?: string;
}

export function ScoreBar({ value, tone, hideNumber = false, className }: ScoreBarProps) {
  const resolved = tone ?? scoreTone(value);
  return (
    <span
      data-slot="score-bar"
      className={cn("inline-flex items-center gap-1.5", className)}
      title={pct(value)}
    >
      <span className="h-1 w-scorebar overflow-hidden rounded-sm bg-surface-3">
        <span className={cn("block h-full", FILL[resolved])} style={{ width: pctWidth(value) }} />
      </span>
      {hideNumber ? null : <span className="font-mono text-2xs text-fg-1">{pct(value)}</span>}
    </span>
  );
}
