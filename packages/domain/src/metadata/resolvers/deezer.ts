/**
 * Deezer (public, keyless) → `BPM` and `ITUNESADVISORY` (`docs/03-metadonnees.md` §2.6, §4).
 *
 * Queried by ISRC, which is the whole point: the ISRC comes from MusicBrainz, so the join is
 * exact and no fuzzy matching is involved. Deezer is the cheapest source of a BPM — local
 * analysis is expensive and off by default — and the only free source of an explicit flag.
 *
 * `gain` and `release_date` are read for cross-checking only: ReplayGain comes from rsgain on
 * the file we actually downloaded, and the date comes from the chosen MusicBrainz release.
 */

import type { DocumentPatch } from "../document.ts";
import { PatchBuilder } from "./patch.ts";

export interface DeezerTrack {
  readonly id?: number;
  readonly title?: string;
  readonly isrc?: string;
  readonly duration?: number;
  readonly bpm?: number;
  readonly gain?: number;
  readonly explicit_lyrics?: boolean;
  /** 0 not explicit, 1 explicit, 2 unknown, 4 edited, 6 no advice available. */
  readonly explicit_content_lyrics?: number;
  readonly release_date?: string;
  readonly error?: { readonly type?: string; readonly message?: string };
}

export function fromDeezerTrack(track: DeezerTrack, options: { fetchedAt: string }): DocumentPatch {
  const patch = new PatchBuilder("deezer", options.fetchedAt);

  if (track.error !== undefined) return patch.build();

  // TBPM is an integer frame; Deezer returns one decimal. Rounded once, here, so the value is
  // identical in all three formats and in the golden files.
  const bpm = track.bpm;
  if (bpm !== undefined && bpm > 0) patch.set("bpm", Math.round(bpm));
  else patch.na("bpm", "Deezer has no BPM for this ISRC");

  // §2.6: 1 = explicit, 2 = clean. Deezer's `explicit_content_lyrics` is more precise than the
  // boolean, but the boolean is always present, so it is the fallback.
  const code = track.explicit_content_lyrics;
  if (code === 1 || code === 4) patch.set("explicit", 1);
  else if (code === 0) patch.set("explicit", 2);
  else if (track.explicit_lyrics === true) patch.set("explicit", 1);
  else if (track.explicit_lyrics === false) patch.set("explicit", 2);
  else patch.na("explicit", "Deezer states no explicit flag for this ISRC");

  return patch.build();
}
