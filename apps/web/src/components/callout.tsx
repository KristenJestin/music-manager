/**
 * A boxed explanation: what the matcher did, what is about to happen, what broke.
 *
 * The Console leans on these heavily and on purpose — an interface that decides nothing for
 * you has to be prepared to explain itself constantly, and a paragraph in the flow of the
 * page is a better place for that than a tooltip.
 */
import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { AlertTriangle, CircleAlert, Info, Sparkles, CircleCheck } from "lucide-react";

const calloutVariants = cva("flex gap-2.5 rounded-md border px-3 py-2.5 text-xs", {
  variants: {
    tone: {
      ok: "border-ok-edge bg-ok-soft text-ok-text",
      warn: "border-warn-edge bg-warn-soft text-warn-text",
      danger: "border-danger-edge bg-danger-soft text-danger-text",
      info: "border-info-edge bg-info-soft text-info-text",
      primary: "border-primary-edge bg-primary-soft text-primary",
      neutral: "border-line bg-surface-1 text-fg-2",
    },
  },
  defaultVariants: { tone: "neutral" },
});

const DEFAULT_ICON = {
  ok: CircleCheck,
  warn: AlertTriangle,
  danger: CircleAlert,
  info: Info,
  primary: Sparkles,
  neutral: Info,
} as const;

export interface CalloutProps extends VariantProps<typeof calloutVariants> {
  readonly children: ReactNode;
  /** Replace the tone's default icon. */
  readonly icon?: ReactNode;
  readonly className?: string;
  readonly "data-testid"?: string;
  readonly role?: string;
}

export function Callout({
  tone = "neutral",
  icon,
  children,
  className,
  role,
  "data-testid": testId,
}: CalloutProps) {
  const Icon = DEFAULT_ICON[tone ?? "neutral"];
  return (
    <div
      data-slot="callout"
      data-testid={testId}
      role={role}
      className={cn(calloutVariants({ tone }), className)}
    >
      <span className="mt-px shrink-0">
        {icon ?? <Icon className="size-4" aria-hidden="true" />}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
