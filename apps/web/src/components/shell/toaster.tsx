/**
 * Toasts, bottom right. Transient confirmations only — anything you might need to read twice
 * belongs on the page, in a callout.
 *
 * The stack, the enter/exit animations and swipe-to-dismiss are Base UI's, reached through the
 * shadcn `ui/toast` component; this file only says what a Console toast *looks* like — one
 * line, one icon, one of the four tones. The queue itself stays in `shell-context.tsx` so that
 * `useToast()` keeps its signature and keeps working from anywhere under the shell.
 *
 * The viewport keeps `data-testid="toaster"` and every toast keeps `role="status"`, because the
 * Playwright specs read the toast text through the first and screen readers through the second.
 * `h-(--toast-frontmost-height)` is what makes the viewport a box rather than a zero-height
 * line: the toasts inside it are absolutely positioned, so without it the element is present
 * but never "visible", and `expect(getByTestId("toaster")).toBeVisible()` would never pass.
 */
import { AlertTriangle, CircleAlert, CircleCheck, Info } from "lucide-react";
import { cn } from "cn";
import {
  Toast,
  ToastClose,
  ToastContent,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  toast as toastManager,
  useToastManager,
} from "#/components/ui/toast.tsx";
import type { Toast as ToastValue } from "#/components/shell/shell-context.tsx";

const TONES = {
  info: { Icon: Info, className: "text-info" },
  ok: { Icon: CircleCheck, className: "text-ok" },
  warn: { Icon: AlertTriangle, className: "text-warn" },
  danger: { Icon: CircleAlert, className: "text-danger" },
} as const satisfies Record<ToastValue["tone"], unknown>;

/** Base UI carries the tone in its free-form `type`; anything else reads as `info`. */
function toneOf(type: string | undefined): ToastValue["tone"] {
  return type === "ok" || type === "warn" || type === "danger" ? type : "info";
}

function ToastList() {
  const { toasts } = useToastManager();

  return toasts.map((entry) => {
    const { Icon, className } = TONES[toneOf(entry.type)];
    return (
      <Toast
        key={entry.id}
        toast={entry}
        role="status"
        className="rounded-md border-line-strong bg-surface-3 text-xs"
      >
        <ToastContent className="gap-2 px-3.5 py-2.5">
          <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />
          <ToastTitle className="min-w-0 flex-1 text-xs font-normal" />
          <ToastClose aria-label="Dismiss" className="text-fg-3" />
        </ToastContent>
      </Toast>
    );
  });
}

export function Toaster() {
  return (
    <ToastProvider toastManager={toastManager}>
      <ToastPortal>
        <ToastViewport data-testid="toaster" className="z-60 h-(--toast-frontmost-height)">
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}
