/**
 * The job journal, as a terminal.
 *
 * Four columns — time, level, step, message — because that is what makes a log scannable:
 * the eye finds the red word first, then the step it belongs to, and only then reads the
 * sentence. It auto-scrolls while you are at the bottom and stops the moment you scroll up,
 * which is the behaviour every log viewer that does not annoy people has.
 */
import { useEffect, useRef } from "react";
import { cn } from "cn";
import type { JobEventPayload } from "@mm/contracts";
import { clockTime } from "#/lib/format.ts";

const LEVEL_CLASS: Record<string, string> = {
  info: "text-info",
  warn: "text-warn",
  error: "text-danger",
};

export interface LogViewerProps {
  readonly events: readonly JobEventPayload[];
  /** Follow the tail. Turned off as soon as the reader scrolls away from the bottom. */
  readonly follow?: boolean;
  readonly emptyLabel?: string;
  readonly className?: string;
}

export function LogViewer({
  events,
  follow = true,
  emptyLabel = "No journal lines yet.",
  className,
}: LogViewerProps) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const node = box.current;
    if (node === null || !follow || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [events, follow]);

  return (
    <div
      data-slot="log"
      data-testid="log-viewer"
      ref={box}
      onScroll={() => {
        const node = box.current;
        if (node === null) return;
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
      className={cn(
        "max-h-90 overflow-auto rounded-md border border-line bg-background py-2 font-mono text-2xs",
        className,
      )}
    >
      {events.length === 0 ? (
        <p className="px-3 py-1 text-fg-3">{emptyLabel}</p>
      ) : (
        events.map((event) => (
          <div
            key={event.id}
            data-level={event.level}
            className="log-grid gap-2.5 px-3 py-0.5 hover:bg-surface-2"
          >
            <span className="text-fg-3">{clockTime(event.at)}</span>
            <span
              className={cn(
                "self-center text-3xs tracking-wider uppercase",
                LEVEL_CLASS[event.level] ?? "text-fg-2",
              )}
            >
              {event.level}
            </span>
            <span className="truncate text-fg-2">{event.step ?? event.type.split(".")[0]}</span>
            <span className="break-words text-fg-1">{event.message}</span>
          </div>
        ))
      )}
    </div>
  );
}
