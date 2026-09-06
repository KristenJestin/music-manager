/**
 * A running re-tag, followed live.
 *
 * The worker writes `retag.queued` / `retag.started` / `retag.progress` / `retag.done` into
 * `job_events` as it goes, and `/api/events` already streams that journal. So there is nothing
 * new to build here and — more to the point — nothing to poll: the page reads the same rows
 * the CLI prints and the same rows a reconnect replays.
 *
 * `EventSource` has no wildcard, so each name is subscribed to explicitly, exactly as
 * `use-job-events` does. The stream is opened only while there is something to follow: a run
 * that has finished will never write another line, and holding a Postgres `LISTEN` open for a
 * page nobody is watching is the sort of thing that is invisible until it is a problem.
 */
import { useEffect, useRef, useState } from "react";
import type { JobEventPayload } from "@mm/contracts";

export interface RetagSnapshot {
  readonly runId: string;
  readonly status: string;
  readonly dryRun: boolean;
  readonly total: number;
  readonly done: number;
  readonly changed: number;
  readonly failed: number;
  readonly schemaVersion: number;
  readonly scope: string;
}

const NAMES = [
  "retag.queued",
  "retag.started",
  "retag.progress",
  "retag.done",
  "retag.failed",
  "retag.cancelled",
] as const;

const FINISHED = new Set(["retag.done", "retag.failed", "retag.cancelled"]);

export interface UseRetagProgressOptions {
  /** The run the loader found, if any. `null` means "nothing in flight". */
  readonly initial: RetagSnapshot | null;
  /** Called once the run reaches an end state, so the route can refetch its rows. */
  readonly onFinished?: (snapshot: RetagSnapshot) => void;
}

export function useRetagProgress({
  initial,
  onFinished,
}: UseRetagProgressOptions): RetagSnapshot | null {
  const [snapshot, setSnapshot] = useState<RetagSnapshot | null>(initial);

  // The loader is the truth on every navigation; the stream only refines it in place.
  useEffect(() => {
    setSnapshot(initial);
  }, [initial]);

  const finished = useRef<((snapshot: RetagSnapshot) => void) | undefined>(undefined);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  const active =
    initial !== null && (initial.status === "pending" || initial.status === "running");

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
      const data = payload.data ?? {};
      const runId = typeof data["runId"] === "string" ? data["runId"] : null;
      if (runId === null) return;

      setSnapshot((current) => {
        if (current === null || current.runId !== runId) return current;
        const next: RetagSnapshot = {
          ...current,
          done: typeof data["done"] === "number" ? data["done"] : current.done + 1,
          total: typeof data["total"] === "number" ? data["total"] : current.total,
          changed: typeof data["changed"] === "number" ? data["changed"] : current.changed,
          failed: typeof data["failed"] === "number" ? data["failed"] : current.failed,
          status: FINISHED.has(payload.type)
            ? payload.type.slice("retag.".length)
            : "running",
        };
        if (FINISHED.has(payload.type)) finished.current?.(next);
        return next;
      });
    };

    source.onmessage = handle;
    for (const name of NAMES) source.addEventListener(name, handle as EventListener);
    return () => {
      source.close();
    };
  }, [active]);

  return snapshot;
}
