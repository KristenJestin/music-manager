/**
 * Live progress for a *list* of imports.
 *
 * The Jobs page had an auto-refresh that conveyed no motion: the numbers were right and the
 * page looked asleep, which is exactly the failure the owner reported — silence that looks
 * like success. `use-job-events` solves this for one job by rendering its journal; a list
 * cannot render fifty journals, and it does not want to. What it wants is the two numbers per
 * row that move.
 *
 * So: one `EventSource` on `/api/events`, the same stream the shell already listens to. A
 * frame naming one of the imports on screen does not update anything by itself — the journal
 * says *what happened*, not *where the tallies now stand*, and a client that counted
 * `track.done` frames would drift the moment one was missed. It marks the id dirty, and a
 * debounced `fetchJobProgress` asks the server for the truth about those rows only. That is
 * two indexed queries over the fifty ids on screen, not a re-run of the page loader: the table
 * does not re-sort or re-page under the reader's cursor while they are looking at it.
 *
 * The stream is not assumed to work. `EventSource` reconnects on its own, but a proxy that
 * kills the connection and a server that is down look the same from here, so the state is
 * published (`connecting` / `live` / `reconnecting`) for the page to show, and a slow poll
 * takes over whenever the stream is not live. A fallback nobody can see is how a dead page
 * passes for a quiet one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJobProgress, type JobProgress } from "#/server/functions/jobs.ts";

/** What the page shows about the stream itself. */
export type StreamState = "connecting" | "live" | "reconnecting";

export interface JobsProgressState {
  /** Fresher values for the rows that moved, by import id. Empty until something happens. */
  readonly rows: ReadonlyMap<string, JobProgress>;
  readonly stream: StreamState;
  /** When these rows were last confirmed against the server. `null` before the first read. */
  readonly checkedAt: number | null;
  /** Re-read now — what the Refresh button and the poll both call. */
  refresh: () => void;
}

/**
 * The frames worth reacting to.
 *
 * `EventSource` has no wildcard, so every name is subscribed to explicitly (the same trap
 * `use-job-events` documents). These are the ones that change a tally, a status or a step;
 * `step.started` is in the list because a job moving from `download` to `tag` is motion the
 * step column has to show.
 */
const NAMES = [
  "track.started",
  "track.done",
  "track.failed",
  "track.skipped",
  "track.waiting",
  "step.started",
  "step.done",
  "step.failed",
  "step.skipped",
  "step.blocked",
  "step.restarting",
  "step.waiting_upstream",
  "import.status",
  "import.done",
  "import.failed",
  "import.cancelled",
] as const;

/** One shared empty overlay, so "nothing known yet" is a stable reference between renders. */
const EMPTY: ReadonlyMap<string, JobProgress> = new Map();

/** The ids back out of the key. An import id has no comma in it, so this is exact. */
function idsOf(key: string): string[] {
  return key === "" ? [] : key.split(",");
}

/** Long enough to collapse a burst of frames into one query, short enough to feel immediate. */
const SETTLE_MS = 500;
/** The fallback cadence while the stream is down. Slow on purpose: it is a safety net. */
const POLL_MS = 10_000;

export interface UseJobsProgressOptions {
  /** The imports on screen. Order does not matter; identity does. */
  readonly ids: readonly string[];
  /** False on the server and wherever a live list makes no sense. */
  readonly enabled?: boolean;
}

export function useJobsProgress({
  ids,
  enabled = true,
}: UseJobsProgressOptions): JobsProgressState {
  const [stream, setStream] = useState<StreamState>("connecting");

  /*
   * The page of rows, as one sorted string.
   *
   * Every caller builds `ids` with a `.map()`, so the array is a new object on every render
   * and useless as an identity; the string is not. It is what tells a *new page* from the same
   * page re-rendered, and the ids are recovered from it wherever they are needed — so the
   * stream's handler, which must not be rebuilt every render, holds one ref and not two.
   */
  const key = useMemo(() => [...ids].sort().join(","), [ids]);
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  /*
   * What the last read learned, *and which page it was about*.
   *
   * The pair is one piece of state rather than two so that a page change invalidates the
   * overlay by derivation — `store.key !== key` — instead of by an effect that resets it after
   * the fact. Row 51 is not row 1 with new numbers, and a render in between showing one page's
   * tallies against another page's rows is exactly the kind of flicker nobody can reproduce.
   */
  const [store, setStore] = useState<{
    key: string;
    rows: ReadonlyMap<string, JobProgress>;
    at: number | null;
  }>({ key, rows: new Map(), at: null });

  const current = store.key === key ? store : null;
  const rows = current?.rows ?? EMPTY;
  const checkedAt = current?.at ?? null;

  const inFlight = useRef(false);
  const again = useRef(false);

  /*
   * One read at a time, and never a lost one.
   *
   * A second request while one is in flight is remembered rather than dropped: the answer
   * already on its way was computed before whatever just happened, so returning it and
   * stopping would leave the row a track behind until the next event — which, for the last
   * track of the last import, never comes. The same drain-once-more rule `subscribe()` uses.
   */
  const read = useCallback(function run(): void {
    const wanted = idsOf(keyRef.current);
    if (wanted.length === 0) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    const done = (): void => {
      inFlight.current = false;
      if (!again.current) return;
      again.current = false;
      run();
    };
    void fetchJobProgress({ data: { ids: wanted } }).then((fresh) => {
      setStore({
        key: keyRef.current,
        rows: new Map(fresh.map((row) => [row.id, row])),
        at: Date.now(),
      });
      done();
      // A failed read is not worth a toast on a list page; the next tick tries again.
    }, done);
  }, []);

  /* ---- the stream ---- */
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/events");
    let settle: ReturnType<typeof setTimeout> | null = null;

    const nudge = (message: MessageEvent<string>): void => {
      let importId: string | null = null;
      try {
        importId = (JSON.parse(message.data) as { importId: string | null }).importId;
      } catch {
        importId = null;
      }
      // A frame about a job that is not on this page changes nothing on this page.
      if (importId !== null && !idsOf(keyRef.current).includes(importId)) return;
      if (settle !== null) return;
      settle = setTimeout(() => {
        settle = null;
        read();
      }, SETTLE_MS);
    };

    source.onopen = () => {
      setStream("live");
      // The connection may have been down long enough for the rows to be wrong.
      read();
    };
    source.onerror = () => {
      setStream("reconnecting");
    };
    source.onmessage = nudge;
    for (const name of NAMES) source.addEventListener(name, nudge as EventListener);

    return () => {
      if (settle !== null) clearTimeout(settle);
      source.close();
      setStream("connecting");
    };
  }, [enabled, read]);

  /* ---- the fallback ---- */
  useEffect(() => {
    if (!enabled || stream === "live") return;
    const timer = setInterval(read, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [enabled, stream, read]);

  return { rows, stream, checkedAt, refresh: read };
}
