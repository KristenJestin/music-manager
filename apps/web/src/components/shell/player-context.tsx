/**
 * The Console's one audio element, and the queue in front of it.
 *
 * A player has to survive navigation — click a track on an album page, open Discover, and the
 * music keeps playing — so it cannot live on a page. It lives in the shell, beside
 * `shell-context.tsx` and for the same reason: it is "something the chrome owns that any page
 * may ask for". A page calls `play([...])` and forgets about it.
 *
 * **One `<audio>` element, rendered here**, not in the bar. The bar is a view of this state and
 * could in principle be hidden, collapsed or replaced; the element must not be unmounted and
 * remounted when that happens, because a remount is a stop. So the provider renders it, the bar
 * reads the state, and `HTMLMediaElement` stays the single source of truth for position,
 * duration and whether sound is actually coming out — React state here only *mirrors* it, from
 * the media events, rather than trying to drive it.
 *
 * Two sources of audio, and the difference is visible on purpose (`source` on each track):
 * `library` is our own file over `/api/stream`, full length and seekable; `deezer` is a
 * thirty-second preview of something we do not own. Conflating them would make the player lie
 * about what the library contains.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  classifyMediaError,
  classifyPlayRejection,
  previewExpired,
  worthShowing,
  type PlaybackFailure,
} from "#/lib/playback.ts";
import { resolvePreview } from "#/server/functions/player.ts";
import type { PlayableTrack } from "#/server/services/preview.ts";
import { useTestId } from "#/components/pending-tree.tsx";

export type { PlayableTrack };

/** The same-origin URL for a library track. The path is never in it (see `api.stream.ts`). */
export function streamUrl(trackId: string): string {
  return `/api/stream?track=${encodeURIComponent(trackId)}`;
}

/** Build a queue entry for a track we own. */
export function libraryTrack(track: {
  readonly id: string;
  readonly title: string;
  readonly artist?: string | null;
  readonly album?: string | null;
  readonly coverUrl?: string | null;
  readonly durationSeconds?: number | null;
}): PlayableTrack {
  return {
    id: `library:${track.id}`,
    title: track.title,
    artist: track.artist ?? null,
    album: track.album ?? null,
    src: streamUrl(track.id),
    source: "library",
    // Nothing to re-resolve: `/api/stream` takes an id and never expires.
    subject: null,
    coverUrl: track.coverUrl ?? null,
    durationSeconds: track.durationSeconds ?? null,
  };
}

export interface PlayerContextValue {
  readonly queue: readonly PlayableTrack[];
  readonly index: number;
  readonly current: PlayableTrack | null;
  readonly playing: boolean;
  /** Seconds into the current track, mirrored from the element. */
  readonly position: number;
  /** Seconds, as the element reports it — 30 for a preview, the real length for a file. */
  readonly duration: number;
  readonly volume: number;
  readonly muted: boolean;
  /** Set when the browser refused to load or decode the current source. */
  readonly error: string | null;
  /** Replace the queue and start at `startAt`. An empty list is a no-op. */
  play(tracks: readonly PlayableTrack[], startAt?: number): void;
  toggle(): void;
  next(): void;
  previous(): void;
  seek(seconds: number): void;
  setVolume(value: number): void;
  toggleMuted(): void;
  /** Stop, empty the queue, and take the bar off the screen. */
  close(): void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

/** Where the chosen volume is remembered between visits. */
const VOLUME_KEY = "mm.player.volume";

/**
 * The remembered volume, read during the first render.
 *
 * Normally reading `localStorage` while rendering is how you get a hydration mismatch, and
 * this app is careful about it everywhere else (`useHydrated`). It is safe here for one
 * specific reason: the queue starts empty, so the bar — the only thing that renders this
 * number — does not exist in the server's HTML at all. There is nothing to mismatch with, and
 * paying a second render to learn the volume would fade the first note in at full blast.
 */
function storedVolume(): number {
  if (typeof window === "undefined") return 1;
  const stored = Number.parseFloat(window.localStorage.getItem(VOLUME_KEY) ?? "");
  return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 1;
}

export function PlayerProvider({ children }: { readonly children: ReactNode }) {
  const testId = useTestId();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<readonly PlayableTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(storedVolume);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The queue entries we have already re-resolved once, by id.
   *
   * A ref and not state: it must not cause a render, and it has to be readable from inside the
   * `error` handler that is about to write it. One retry per entry is the whole policy — a
   * second failure after a freshly minted URL is not a stale ticket, it is something we cannot
   * fix by asking again, and a player that loops on a broken clip is worse than one that stops.
   */
  const retried = useRef<Set<string>>(new Set());

  const current = queue[index] ?? null;

  /**
   * Say what went wrong: once to the console with the browser's own words, once to the reader.
   *
   * The console line is the half that was missing. `MediaError.code` and the `DOMException`
   * name are the only facts that separate an autoplay refusal from a blocked `media-src` from
   * a genuinely dead link, and none of them reach the screen — so they go where a developer
   * looking at a broken player will actually find them.
   */
  const report = useCallback((failure: PlaybackFailure): void => {
    console.warn(`[player] ${failure.kind}: ${failure.detail}`);
    setError(worthShowing(failure) ? failure.message : null);
  }, []);

  useEffect(() => {
    const element = audio.current;
    if (element === null) return;
    element.volume = volume;
    element.muted = muted;
  }, [volume, muted]);

  const play = useCallback((tracks: readonly PlayableTrack[], startAt = 0) => {
    const playable = tracks.filter((track) => track.src !== "");
    if (playable.length === 0) return;
    const from = Math.min(Math.max(startAt, 0), playable.length - 1);
    // A new queue is a new set of tickets: whatever failed last time gets its retry back.
    retried.current = new Set();
    setError(null);
    setQueue(playable);
    setIndex(from);
    setPosition(0);
    setDuration(0);
    // `playing` is set optimistically so the button flips at once; the `play`/`pause` events
    // below correct it if the browser disagrees.
    setPlaying(true);
  }, []);

  /*
   * Load and start whenever the current track changes.
   *
   * Keyed on the source URL rather than on the index, so replacing the queue with the same
   * track at a different position does not restart it, and re-rendering for an unrelated
   * reason never does.
   */
  const src = current?.src ?? null;
  const stale = current !== null && current.source === "deezer" && previewExpired(current.src);
  useEffect(() => {
    const element = audio.current;
    if (element === null || src === null) return;
    if (element.getAttribute("src") !== src) {
      element.src = src;
      element.load();
    }
  }, [src]);

  /**
   * Ask the server for this entry again, with the preview cache bypassed, and swap the URL in.
   *
   * Answers whether a retry is actually under way, so the caller knows whether to show the
   * failure now or wait and see. Only a Deezer clip that carries the subject it came from can
   * be repaired this way; everything else is reported straight away.
   */
  const reresolve = useCallback(
    (track: PlayableTrack): boolean => {
      if (track.source !== "deezer" || track.subject === null) return false;
      if (retried.current.has(track.id)) return false;
      retried.current.add(track.id);

      void resolvePreview({ data: { subject: track.subject, refresh: true } }).then(
        (answer) => {
          // Match by id first: an album queue holds a dozen clips and only one of them failed.
          const fresh =
            answer.tracks.find((candidate) => candidate.id === track.id) ?? answer.tracks[0];
          if (fresh === undefined || fresh.src === "" || fresh.src === track.src) {
            report(
              classifyMediaError(
                { code: 4, message: "re-resolved to the same dead URL" },
                track.source,
              ),
            );
            return;
          }
          setError(null);
          setQueue((held) =>
            held.map((entry) => (entry.id === track.id ? { ...entry, src: fresh.src } : entry)),
          );
          setPlaying(true);
        },
        (cause: unknown) => {
          // The server call itself failed — a session that lapsed, a network blip. Say that,
          // rather than dressing it up as something the media element reported.
          console.warn("[player] re-resolving the preview failed", cause);
          setError("The preview could not be renewed. Try again.");
        },
      );
      return true;
    },
    [report],
  );

  /*
   * A clip whose signature has already lapsed gets a new one asked for, in parallel.
   *
   * Not *instead* of loading it: the element is allowed to try the URL it has, because `exp`
   * is a claim about a CDN we do not control and the clip sometimes still plays. If it does
   * not, the `error` handler below reports it properly — and the retry has already been spent
   * here, so it says the honest thing rather than promising a renewal twice.
   *
   * The server checks the same expiry and is the better place for it, since it can refill the
   * cache. This is the second net, for a queue that has sat on an open page long enough for
   * its tickets to go stale under it without any server call in between.
   */
  useEffect(() => {
    if (current === null || !stale) return;
    console.warn(`[player] ${current.id}: the clip signature has lapsed; asking for a new one`);
    reresolve(current);
  }, [current, reresolve, stale]);

  useEffect(() => {
    const element = audio.current;
    if (element === null || src === null || !playing) return;
    void element.play().catch((cause: unknown) => {
      /*
       * A rejected `play()` is not a media error, and reporting it as one is how the Console
       * came to blame Deezer for the autoplay policy. `AbortError` in particular is the normal
       * consequence of the queue moving on mid-load and deserves no words at all.
       */
      setPlaying(false);
      report(classifyPlayRejection(cause, current?.source ?? "library"));
    });
  }, [src, playing, current?.source, report]);

  /**
   * Move to another entry of the queue.
   *
   * Written against the current `index` rather than inside a `setIndex` updater: an updater has
   * to be a pure function of the previous state, and React is free to call it twice. Four other
   * `setState` calls hiding in there would then fire twice too, which is the kind of bug that
   * only shows up under StrictMode or a concurrent re-render.
   */
  const goTo = useCallback((to: number) => {
    setIndex(to);
    setPosition(0);
    setDuration(0);
    setError(null);
    setPlaying(true);
  }, []);

  const next = useCallback(() => {
    if (index + 1 >= queue.length) {
      setPlaying(false);
      return;
    }
    goTo(index + 1);
  }, [goTo, index, queue.length]);

  const previous = useCallback(() => {
    const element = audio.current;
    // The convention every player follows: past three seconds, "previous" means "from the top".
    if (index === 0 || (element !== null && element.currentTime > 3)) {
      if (element !== null) element.currentTime = 0;
      setPosition(0);
      return;
    }
    goTo(index - 1);
  }, [goTo, index]);

  const toggle = useCallback(() => {
    const element = audio.current;
    if (element === null || element.getAttribute("src") === null) return;
    if (element.paused) {
      setPlaying(true);
      void element.play().catch((cause: unknown) => {
        setPlaying(false);
        report(classifyPlayRejection(cause, current?.source ?? "library"));
      });
    } else {
      element.pause();
      setPlaying(false);
    }
  }, [current?.source, report]);

  const seek = useCallback((seconds: number) => {
    const element = audio.current;
    if (element === null || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.min(Math.max(seconds, 0), element.duration);
    setPosition(element.currentTime);
  }, []);

  const setVolume = useCallback((value: number) => {
    const clamped = Math.min(Math.max(value, 0), 1);
    setVolumeState(clamped);
    setMuted(clamped === 0);
    window.localStorage.setItem(VOLUME_KEY, String(clamped));
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((held) => !held);
  }, []);

  const close = useCallback(() => {
    const element = audio.current;
    if (element !== null) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    retried.current = new Set();
    setPlaying(false);
    setQueue([]);
    setIndex(0);
    setPosition(0);
    setDuration(0);
    setError(null);
  }, []);

  const value = useMemo<PlayerContextValue>(
    () => ({
      queue,
      index,
      current,
      playing,
      position,
      duration,
      volume,
      muted,
      error,
      play,
      toggle,
      next,
      previous,
      seek,
      setVolume,
      toggleMuted,
      close,
    }),
    [
      queue,
      index,
      current,
      playing,
      position,
      duration,
      volume,
      muted,
      error,
      play,
      toggle,
      next,
      previous,
      seek,
      setVolume,
      toggleMuted,
      close,
    ],
  );

  return (
    <PlayerContext.Provider value={value}>
      {children}
      {/*
        Not `hidden`, and no `controls`: the bar is the interface. `preload="metadata"` is what
        gives the scrub bar a length before anybody presses play, and it costs a few kilobytes
        rather than the whole file.
      */}
      <audio
        ref={audio}
        data-testid={testId("player-audio")}
        preload="metadata"
        className="hidden"
        onPlay={() => {
          setPlaying(true);
          // Sound is coming out, so whatever was said a moment ago is no longer true. This is
          // what clears the message when a re-resolved clip starts after its dead one failed.
          setError(null);
        }}
        onPause={() => {
          setPlaying(false);
        }}
        onTimeUpdate={(event) => {
          setPosition(event.currentTarget.currentTime);
        }}
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          setDuration(Number.isFinite(value) ? value : 0);
        }}
        onEnded={next}
        onError={(event) => {
          setPlaying(false);
          const failure = classifyMediaError(
            event.currentTarget.error,
            current?.source ?? "library",
          );
          console.warn(`[player] ${failure.kind}: ${failure.detail}`);
          /*
           * One silent repair before any accusation.
           *
           * Code 4 is what a browser reports for an expired signature, a CORS refusal, a
           * blocked `media-src` and an unknown codec alike. Re-resolving fixes exactly one of
           * those, so it is tried once and only the failure that survives it is shown.
           */
          if (failure.retryable && current !== null && reresolve(current)) return;
          setError(worthShowing(failure) ? failure.message : null);
        }}
      >
        <track kind="captions" />
      </audio>
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const value = useContext(PlayerContext);
  if (value === null) throw new Error("usePlayer must be used inside <PlayerProvider>.");
  return value;
}
