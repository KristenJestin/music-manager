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
import type { PlayableTrack } from "#/server/services/preview.ts";

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
  const audio = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<readonly PlayableTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(storedVolume);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = queue[index] ?? null;

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
  useEffect(() => {
    const element = audio.current;
    if (element === null || src === null) return;
    if (element.getAttribute("src") !== src) {
      element.src = src;
      element.load();
    }
  }, [src]);

  useEffect(() => {
    const element = audio.current;
    if (element === null || src === null || !playing) return;
    void element.play().catch(() => {
      // Autoplay policies, a dead preview URL, a codec the browser will not take: all three
      // are "it did not start", and the `error`/`pause` handlers below say which.
      setPlaying(false);
    });
  }, [src, playing]);

  const next = useCallback(() => {
    setIndex((held) => {
      if (held + 1 >= queue.length) {
        setPlaying(false);
        return held;
      }
      setPosition(0);
      setDuration(0);
      setError(null);
      setPlaying(true);
      return held + 1;
    });
  }, [queue.length]);

  const previous = useCallback(() => {
    const element = audio.current;
    // The convention every player follows: past three seconds, "previous" means "from the top".
    if (element !== null && element.currentTime > 3) {
      element.currentTime = 0;
      return;
    }
    setIndex((held) => {
      if (held === 0) {
        if (element !== null) element.currentTime = 0;
        return held;
      }
      setPosition(0);
      setDuration(0);
      setError(null);
      setPlaying(true);
      return held - 1;
    });
  }, []);

  const toggle = useCallback(() => {
    const element = audio.current;
    if (element === null || element.getAttribute("src") === null) return;
    if (element.paused) {
      setPlaying(true);
      void element.play().catch(() => {
        setPlaying(false);
      });
    } else {
      element.pause();
      setPlaying(false);
    }
  }, []);

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
        data-testid="player-audio"
        preload="metadata"
        className="hidden"
        onPlay={() => {
          setPlaying(true);
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
        onError={() => {
          setPlaying(false);
          setError(
            current?.source === "deezer"
              ? "This preview could not be played. Deezer's clip links expire; try again."
              : "This file could not be played.",
          );
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
