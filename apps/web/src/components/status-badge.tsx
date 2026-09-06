/**
 * Tones and status badges.
 *
 * One vocabulary of five tones (`ok`, `warn`, `danger`, `info`, `muted`) plus the Console
 * amber (`primary`), and one table that says which tone every status in the database gets.
 * Having that table in one place is what stops "failed" from being red on one page and orange
 * on another — and it means a new `import_status` value shows up as a compile error here
 * rather than as a grey badge nobody notices.
 */
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ImportStatus, StepStatus, TrackState } from "#/server/db/schema/enums.ts";
import { Badge } from "#/components/ui/badge.tsx";

export type Tone = "ok" | "warn" | "danger" | "info" | "muted" | "primary";

const toneBadge = cva("h-5 rounded-sm border-transparent px-1.5 text-2xs font-medium", {
  variants: {
    tone: {
      ok: "bg-ok-soft text-ok",
      warn: "bg-warn-soft text-warn",
      danger: "bg-danger-soft text-danger",
      info: "bg-info-soft text-info",
      muted: "bg-muted-soft text-fg-1",
      primary: "bg-primary-soft text-primary",
    },
    outline: {
      true: "border-line-strong bg-transparent text-fg-2",
      false: "",
    },
  },
  defaultVariants: { tone: "muted", outline: false },
});

export interface ToneBadgeProps extends VariantProps<typeof toneBadge> {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly title?: string;
}

/** A small rectangular badge in one of the six tones. The Console's workhorse. */
export function ToneBadge({ tone, outline, className, children, title }: ToneBadgeProps) {
  return (
    <Badge variant="outline" title={title} className={cn(toneBadge({ tone, outline }), className)}>
      {children}
    </Badge>
  );
}

/** Label and tone of every status an import can rest in. */
export const IMPORT_STATUS_META: Record<ImportStatus, { label: string; tone: Tone }> = {
  pending: { label: "Queued", tone: "muted" },
  running: { label: "Running", tone: "info" },
  awaiting_confirm: { label: "Needs confirm", tone: "warn" },
  awaiting_review: { label: "Needs review", tone: "warn" },
  paused: { label: "Paused", tone: "muted" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

/** Label and tone of every state one video can be in. */
export const TRACK_STATE_META: Record<TrackState, { label: string; tone: Tone }> = {
  pending: { label: "Queued", tone: "muted" },
  downloaded: { label: "Downloaded", tone: "info" },
  fingerprinted: { label: "Fingerprinted", tone: "info" },
  tagged: { label: "Tagged", tone: "info" },
  placed: { label: "Placed", tone: "ok" },
  done: { label: "Done", tone: "ok" },
  skipped: { label: "Skipped", tone: "muted" },
  failed: { label: "Failed", tone: "danger" },
};

/** Label and tone of every outcome one step can have. */
export const STEP_STATUS_META: Record<StepStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "muted" },
  running: { label: "Running", tone: "info" },
  done: { label: "Done", tone: "ok" },
  blocked: { label: "Blocked", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "muted" },
};

export function ImportStatusBadge({
  status,
  className,
}: {
  readonly status: ImportStatus;
  readonly className?: string;
}) {
  const meta = IMPORT_STATUS_META[status];
  return (
    <ToneBadge tone={meta.tone} className={className}>
      {meta.label}
    </ToneBadge>
  );
}

export function TrackStateBadge({
  state,
  className,
}: {
  readonly state: TrackState;
  readonly className?: string;
}) {
  const meta = TRACK_STATE_META[state];
  return (
    <ToneBadge tone={meta.tone} className={className}>
      {meta.label}
    </ToneBadge>
  );
}

/** The tone a [0, 1] score deserves: green above 0.85, amber above 0.6, red below. */
export function scoreTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined) return "muted";
  if (value >= 0.85) return "ok";
  if (value >= 0.6) return "warn";
  return "danger";
}
