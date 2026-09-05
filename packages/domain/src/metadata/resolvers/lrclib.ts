/**
 * LRCLIB → `LYRICS` (`docs/03-metadonnees.md` §2.6).
 *
 * The synchronised LRC when LRCLIB has one, the plain text otherwise. The point of this
 * resolver is the third case: `instrumental: true` means the track *has* no lyrics, so
 * `LYRICS` is **n/a** and not missing — it leaves the completeness denominator (§6) instead
 * of counting against a track that will never have words.
 */

import type { DocumentPatch, LyricsValue } from "../document.ts";
import { PatchBuilder } from "./patch.ts";

export interface LrclibEntry {
  readonly id?: number;
  readonly trackName?: string;
  readonly artistName?: string;
  readonly albumName?: string;
  readonly duration?: number;
  readonly instrumental?: boolean;
  readonly plainLyrics?: string | null;
  readonly syncedLyrics?: string | null;
}

export interface LrclibOptions {
  readonly fetchedAt: string;
  /** Duration of the track in seconds, when known: LRCLIB results are picked by duration. */
  readonly durationSeconds?: number;
  /** Widest accepted duration difference, in seconds. LRCLIB's own tolerance is 2 s. */
  readonly toleranceSeconds?: number;
}

/**
 * Choose the best of a `/api/search` result list: the entry whose duration is closest to the
 * track's, preferring one that carries synchronised lyrics. Ties are broken by the LRCLIB id
 * so the choice is stable across runs.
 */
export function chooseLrclibEntry(
  results: readonly LrclibEntry[],
  options: { durationSeconds?: number; toleranceSeconds?: number } = {},
): LrclibEntry | null {
  const tolerance = options.toleranceSeconds ?? 2;
  const target = options.durationSeconds;

  const candidates =
    target === undefined
      ? [...results]
      : results.filter((entry) => Math.abs((entry.duration ?? -1) - target) <= tolerance);
  if (candidates.length === 0) return null;

  return (
    candidates.sort((a, b) => {
      const syncedDelta = Number(hasSynced(b)) - Number(hasSynced(a));
      if (syncedDelta !== 0) return syncedDelta;
      if (target !== undefined) {
        const distance =
          Math.abs((a.duration ?? 0) - target) - Math.abs((b.duration ?? 0) - target);
        if (distance !== 0) return distance;
      }
      return (a.id ?? 0) - (b.id ?? 0);
    })[0] ?? null
  );
}

function hasSynced(entry: LrclibEntry): boolean {
  return typeof entry.syncedLyrics === "string" && entry.syncedLyrics !== "";
}

export function fromLrclib(entry: LrclibEntry | null, options: LrclibOptions): DocumentPatch {
  const patch = new PatchBuilder("lrclib", options.fetchedAt);

  if (entry === null) {
    // Not an n/a: LRCLIB simply has nothing yet. The album goes back in the refresh queue and
    // the lyrics may arrive later (§6), so the field stays *missing*.
    return patch.build();
  }

  if (entry.instrumental === true) {
    patch.na("lyrics", "LRCLIB marks this track instrumental");
    patch.na("lyrics_synced", "LRCLIB marks this track instrumental");
    return patch.build();
  }

  const synced =
    typeof entry.syncedLyrics === "string" && entry.syncedLyrics !== "" ? entry.syncedLyrics : null;
  const plain =
    typeof entry.plainLyrics === "string" && entry.plainLyrics !== "" ? entry.plainLyrics : null;
  if (synced === null && plain === null) return patch.build();

  const value: LyricsValue = { synced, plain };
  patch.set("lyrics", value);
  if (synced !== null) patch.set("lyrics_synced", value);
  else patch.na("lyrics_synced", "LRCLIB has only plain lyrics for this track");

  return patch.build();
}
