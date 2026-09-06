/**
 * Toasts, bottom right. Transient confirmations only — anything you might need to read twice
 * belongs on the page, in a callout.
 */
import { AlertTriangle, CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "cn";
import { useShell } from "#/components/shell/shell-context.tsx";

const ICON = { info: Info, ok: CircleCheck, warn: AlertTriangle, danger: CircleAlert } as const;
const TONE = {
  info: "text-info",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
} as const;

export function Toaster() {
  const { toasts, dismissToast } = useShell();
  return (
    <div
      data-testid="toaster"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-60 flex flex-col gap-2"
    >
      {toasts.map((toast) => {
        const Icon = ICON[toast.tone];
        return (
          <div
            key={toast.id}
            role="status"
            className="flex items-center gap-2 rounded-md border border-line-strong bg-surface-3 px-3.5 py-2.5 text-xs shadow-lg"
          >
            <Icon className={cn("size-4 shrink-0", TONE[toast.tone])} aria-hidden="true" />
            <span>{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="ml-2 text-fg-3 hover:text-foreground"
              onClick={() => {
                dismissToast(toast.id);
              }}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
