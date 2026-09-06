/**
 * The MusicBrainz match of wizard step 2, followed live.
 *
 * The server publishes one frame before every request it makes (`server/services/match-
 * progress.ts`), so the screen can name the second it is spending rather than show a spinner
 * for ten of them. Same shape as `use-retag-progress`: an `EventSource`, one named frame, and
 * nothing kept once the stream closes.
 *
 * The stream is opened only while a match is actually in flight — the pending component is the
 * only caller, and it is unmounted the moment the loader resolves.
 */
import { useEffect, useState } from "react";

export interface MatchProgressSnapshot {
  readonly importId: string;
  readonly phase: "starting" | "searching" | "looking-up" | "scoring" | "done";
  readonly label: string;
  readonly searches: number;
  readonly searchesPlanned: number;
  readonly lookups: number;
  readonly lookupsPlanned: number;
}

export function useMatchProgress(importId: string | null): MatchProgressSnapshot | null {
  const [progress, setProgress] = useState<MatchProgressSnapshot | null>(null);

  useEffect(() => {
    if (importId === null || importId === "") return;
    const source = new EventSource(`/api/match-progress?import=${encodeURIComponent(importId)}`);

    const handle = (message: MessageEvent<string>): void => {
      try {
        setProgress(JSON.parse(message.data) as MatchProgressSnapshot);
      } catch {
        // A truncated frame is not worth a broken screen; the next one will be whole.
      }
    };
    source.addEventListener("match.progress", handle as EventListener);
    return () => {
      source.close();
    };
  }, [importId]);

  // A snapshot from a previous import is not this one's: filtered here rather than reset in
  // the effect, which would be a setState in an effect body and one cascading render.
  return progress !== null && progress.importId === importId ? progress : null;
}
