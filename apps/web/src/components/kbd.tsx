/**
 * A keycap. The Console is keyboard-first, so every shortcut it has is printed next to the
 * thing it does rather than hidden in a help page.
 */
import type { ReactNode } from "react";
import { cn } from "cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "rounded-xs border border-b-2 border-line-strong bg-surface-1 px-1.5 py-px font-mono text-3xs text-fg-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
