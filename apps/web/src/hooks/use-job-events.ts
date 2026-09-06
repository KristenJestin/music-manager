/**
 * The live journal of one job.
 *
 * `EventSource` against `/api/events?import=<id>&since=<n>`. Two properties make this lossless
 * rather than merely live:
 *
 *  - it **starts from the last id the page already rendered**, so the rows the loader fetched
 *    and the rows the stream delivers meet exactly, with no gap and no duplicate;
 *  - the browser's own reconnect sends `Last-Event-ID`, and the endpoint replays from there,
 *    so a laptop that slept through a download catches up rather than missing it.
 *
 * The two halves are kept apart on purpose: `initial` is whatever the route loader last
 * fetched, `streamed` is what has arrived since, and the returned list is the two merged
 * during render. Nothing copies one into the other, so there is no effect that has to
 * re-synchronise them when the loader re-runs — which it does on every refetch.
 *
 * `onTerminal` fires when the import reaches an end state. The page uses it to re-read the
 * rows: the journal says "done", but the *tracks* and their file paths live in the database,
 * and only a refetch has those.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { JOB_EVENT_TYPES, type JobEventPayload } from "@mm/contracts";

const TERMINAL = new Set(["import.done", "import.failed", "import.cancelled"]);

/**
 * The names to subscribe to.
 *
 * The server names every frame (`event: step.done`), and `EventSource` has no wildcard, so an
 * unnamed-frame `onmessage` handler is not enough on its own. This is the shared catalogue of
 * `@mm/contracts` plus the handful the orchestrator emits that the catalogue has not caught up
 * with. A name missing from here is simply not rendered live — which is survivable, because
 * the page also refetches when the job ends.
 */
const SUBSCRIBED = [
  ...JOB_EVENT_TYPES,
  "step.blocked",
  "track.started",
  "track.progress",
  "track.done",
  "preferences.learned",
  // `verify` names its own lines; without these the read-back is invisible until the step ends.
  "verify.progress",
  "verify.album",
  "verify.failed",
] as const;

export interface UseJobEventsOptions {
  readonly importId: string;
  readonly initial: readonly JobEventPayload[];
  /**
   * Open the stream at all. False for a job that has already finished: nothing more will ever
   * be written to its journal, so a connection would hold a Postgres `LISTEN` open for as long
   * as the tab stayed on the page and — worse — the page would claim to be "live" about a job
   * that ended yesterday.
   */
  readonly enabled?: boolean;
  readonly onTerminal?: (event: JobEventPayload) => void;
  readonly onEvent?: (event: JobEventPayload) => void;
}

export interface JobEventsState {
  readonly events: readonly JobEventPayload[];
  /** True while the stream is open. Goes false on a terminal event or a transport error. */
  readonly live: boolean;
}

export function useJobEvents({
  importId,
  initial,
  enabled = true,
  onTerminal,
  onEvent,
}: UseJobEventsOptions): JobEventsState {
  const [streamed, setStreamed] = useState<readonly JobEventPayload[]>([]);
  const [live, setLive] = useState(false);

  // The callbacks are read by the stream, never during render, so they live in a ref that is
  // refreshed by its own effect rather than assigned while rendering.
  const handlers = useRef<{
    onTerminal: ((event: JobEventPayload) => void) | undefined;
    onEvent: ((event: JobEventPayload) => void) | undefined;
  }>({ onTerminal: undefined, onEvent: undefined });

  useEffect(() => {
    handlers.current = { onTerminal, onEvent };
  }, [onTerminal, onEvent]);

  /** The loader's rows, then anything newer this stream has seen, deduplicated by id. */
  const events = useMemo(() => {
    const seen = new Set(initial.map((event) => event.id));
    const extra = streamed.filter((event) => event.importId === importId && !seen.has(event.id));
    return extra.length === 0 ? initial : [...initial, ...extra];
  }, [initial, streamed, importId]);

  /** The id to resume from: the newest thing already on screen. */
  const cursor = useMemo(() => events.reduce((max, event) => Math.max(max, event.id), 0), [events]);

  // `cursor` is deliberately *not* a dependency: it changes with every message, and depending
  // on it would tear the stream down and rebuild it each time. It is read once, when the
  // stream opens, through a ref.
  const cursorRef = useRef(0);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(
      `/api/events?import=${encodeURIComponent(importId)}&since=${String(cursorRef.current)}`,
    );

    const handle = (message: MessageEvent<string>): void => {
      let payload: JobEventPayload;
      try {
        payload = JSON.parse(message.data) as JobEventPayload;
      } catch {
        return;
      }
      setStreamed((current) =>
        current.some((event) => event.id === payload.id) ? current : [...current, payload],
      );
      handlers.current.onEvent?.(payload);
      if (TERMINAL.has(payload.type)) {
        handlers.current.onTerminal?.(payload);
        source.close();
        setLive(false);
      }
    };

    source.onmessage = handle;
    for (const type of new Set<string>(SUBSCRIBED)) {
      source.addEventListener(type, handle as EventListener);
    }
    source.onopen = () => {
      setLive(true);
    };
    source.onerror = () => {
      setLive(false);
    };

    return () => {
      source.close();
      // A different job's stream must not inherit this one's backlog.
      setStreamed([]);
      setLive(false);
    };
  }, [importId, enabled]);

  return { events, live };
}
