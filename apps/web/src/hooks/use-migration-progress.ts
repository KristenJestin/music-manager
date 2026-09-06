/**
 * A running migration, followed live.
 *
 * The worker writes `migration.progress` into `job_events` as it goes — one line per album,
 * per batch of probed files, per import created — and `migration.done` / `migration.failed`
 * when it stops. `/api/events` already streams that journal, so this hook has nothing to poll
 * and nothing to invent: it shows the same lines `mm migrate v1 --verbose` prints and the same
 * lines a reconnect replays.
 *
 * The lines are capped. A migration of twenty thousand files writes thousands of them, and a
 * page that keeps every one is a page that eventually stops scrolling.
 */
import { useEffect, useRef, useState } from "react";
import type { JobEventPayload } from "@mm/contracts";

export interface MigrationLine {
  readonly id: number;
  readonly message: string;
  readonly level: string;
}

const NAMES = ["migration.progress", "migration.done", "migration.failed"] as const;
const FINISHED = new Set<string>(["migration.done", "migration.failed"]);

/** How many lines to keep on screen. */
const KEEP = 60;

export interface UseMigrationProgressOptions {
  /** Open the stream only while there is something to follow. */
  readonly active: boolean;
  /** Called once the run reaches an end state, so the route can refetch its rows. */
  readonly onFinished?: () => void;
}

export function useMigrationProgress({
  active,
  onFinished,
}: UseMigrationProgressOptions): readonly MigrationLine[] {
  const [lines, setLines] = useState<readonly MigrationLine[]>([]);

  const finished = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (!active) return;
    const source = new EventSource("/api/events");

    const handle = (message: MessageEvent<string>): void => {
      let payload: JobEventPayload;
      try {
        payload = JSON.parse(message.data) as JobEventPayload;
      } catch {
        return;
      }
      if (!NAMES.includes(payload.type as (typeof NAMES)[number])) return;

      setLines((current) =>
        [...current, { id: payload.id, message: payload.message, level: payload.level }].slice(
          -KEEP,
        ),
      );
      // The end of a run is announced from the handler rather than from render: the caller
      // reacts by refetching, and starting that during render is how a page loops for ever.
      if (FINISHED.has(payload.type)) finished.current?.();
    };

    source.onmessage = handle;
    for (const name of NAMES) source.addEventListener(name, handle as EventListener);
    return () => {
      source.close();
    };
  }, [active]);

  return lines;
}
