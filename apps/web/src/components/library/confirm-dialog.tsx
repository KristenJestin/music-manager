/**
 * The confirmation in front of anything that cannot be undone.
 *
 * Two rules, both learned the hard way by every app that has ever deleted the wrong thing:
 *
 *  - **it says what will happen, in nouns and numbers** — "3 files, 3 sidecars, 4 rows", not
 *    "this action cannot be undone";
 *  - **the destructive button is not the default focus**, so `Enter` on a dialog you have not
 *    read does nothing.
 *
 * `busy` disables both buttons rather than closing the dialog, because a delete that takes two
 * seconds and a dialog that vanishes immediately is how people press it twice.
 */
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  /** The exact consequence, spelled out. Shown in a box above the buttons. */
  readonly consequence?: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly busy?: boolean;
  readonly destructive?: boolean;
  readonly testId?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  consequence,
  confirmLabel,
  onConfirm,
  busy = false,
  destructive = true,
  testId = "confirm-dialog",
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={testId} className="max-w-form">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {consequence === undefined ? null : (
          <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-fg-1">
            {consequence}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            nativeButton={false}
            render={<DialogClose />}
            data-testid={`${testId}-cancel`}
          >
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={onConfirm}
            data-testid={`${testId}-confirm`}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
