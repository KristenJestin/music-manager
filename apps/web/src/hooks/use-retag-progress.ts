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
 *
 * The loader's row and the stream's deltas are kept **apart** and merged during render, the
 * way `use-job-events` keeps its two lists apart. Copying one into the other would mean an
 * effect that re-synchronises them every time the route refetches — a cascading render, and a
 * window in which the page shows the old run's counters against the new run's total.
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

/** What the stream knows: which run, and the counters that have moved since. */
interface Delta {
  readonly runId: string;
  readonly status?: string;
  readonly total?: number;
  readonly done?: number;
  readonly changed?: number;
  readonly failed?: number;
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
  /**
   * Called once the run reaches an end state, so the route can refetch its rows.
   *
   * No argument: the caller has the snapshot already (it is what this hook returns), and a
   * callback that carried it would have to be fired from render, which is where side effects
   * do not belong.
   */
  readonly onFinished?: () => void;
}

export function useRetagProgress({
  initial,
  onFinished,
}: UseRetagProgressOptions): RetagSnapshot | null {
  const [delta, setDelta] = useState<Delta | null>(null);

  const finished = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  const runId = initial?.runId ?? null;
  const active = initial !== null && (initial.status === "pending" || initial.status === "running");

  useEffect(() => {
    if (!active || runId === null) return;
    const source = new EventSource("/api/events");

    const handle = (message: MessageEvent<string>): void => {
      let payload: JobEventPayload;
      try {
        payload = JSON.parse(message.data) as JobEventPayload;
      } catch {
        return;
      }
      const data = payload.data ?? {};
      if (data["runId"] !== runId) return;

      setDelta((current) => {
        const base = current?.runId === runId ? current : { runId };
        return {
          runId,
          status: FINISHED.has(payload.type) ? payload.type.slice("retag.".length) : "running",
          // `retag.progress` carries one file, not a running total, so the counter is
          // advanced here rather than read off the event.
          done: typeof data["done"] === "number" ? data["done"] : (base.done ?? 0) + 1,
          ...(typeof data["total"] === "number" ? { total: data["total"] } : {}),
          ...(typeof data["changed"] === "number" ? { changed: data["changed"] } : {}),
          ...(typeof data["failed"] === "number" ? { failed: data["failed"] } : {}),
        };
      });
    };

    source.onmessage = handle;
    for (const name of NAMES) source.addEventListener(name, handle as EventListener);
    return () => {
      source.close();
    };
  }, [active, runId]);

  const merged: RetagSnapshot | null =
    initial === null
      ? null
      : delta === null || delta.runId !== initial.runId
        ? initial
        : {
            ...initial,
            ...(delta.status === undefined ? {} : { status: delta.status }),
            ...(delta.total === undefined ? {} : { total: delta.total }),
            // The loader's count and the stream's count race; the larger of the two is the
            // honest answer, and it never goes backwards under somebody's eyes.
            done: Math.max(initial.done, delta.done ?? 0),
            ...(delta.changed === undefined ? {} : { changed: delta.changed }),
            ...(delta.failed === undefined ? {} : { failed: delta.failed }),
          };

  // The end of a run is announced from an effect, not from render: the caller reacts by
  // refetching its rows, and starting that during render is how a page loops for ever.
  const status = merged?.status ?? null;
  useEffect(() => {
    if (status !== null && FINISHED.has(`retag.${status}`)) finished.current?.();
  }, [status]);

  return merged;
}
