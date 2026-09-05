/**
 * rsgain → the loudness block (`docs/03-metadonnees.md` §2.6).
 *
 * rsgain scans the whole album at once, so the album values are only correct once every track
 * is on disk. Opus files get `R128_*` **and** `REPLAYGAIN_*`: the R128 tags are what an Opus
 * decoder applies, the ReplayGain ones are what every library reader indexes.
 *
 * The values are passed through verbatim, in rsgain's own formatting ("-8.47 dB",
 * "1.083092"). Re-deriving them would risk a rounding difference between what we write in the
 * file and what the tool measured.
 */

import type { DocumentPatch } from "../document.ts";
import { PatchBuilder } from "./patch.ts";

export interface RsgainResult {
  readonly filename?: string;
  readonly trackGain?: string;
  readonly trackPeak?: string;
  readonly trackRange?: string;
  readonly albumGain?: string;
  readonly albumPeak?: string;
  readonly albumRange?: string;
  readonly referenceLoudness?: string;
  /** Q7.8 fixed point relative to −23 LUFS; Opus only. */
  readonly r128TrackGain?: number;
  readonly r128AlbumGain?: number;
}

export interface RsgainOptions {
  readonly fetchedAt: string;
  /** Opus is the only container that carries R128 tags (§2.6, "Opus uniquement"). */
  readonly opus: boolean;
}

export function fromRsgain(result: RsgainResult, options: RsgainOptions): DocumentPatch {
  const patch = new PatchBuilder("rsgain", options.fetchedAt);

  patch.set("replaygain_track_gain", result.trackGain);
  patch.set("replaygain_track_peak", result.trackPeak);
  patch.setOrNa("replaygain_track_range", result.trackRange, "rsgain reported no track range");
  patch.set("replaygain_album_gain", result.albumGain);
  patch.set("replaygain_album_peak", result.albumPeak);
  patch.setOrNa("replaygain_album_range", result.albumRange, "rsgain reported no album range");
  patch.setOrNa(
    "replaygain_reference_loudness",
    result.referenceLoudness,
    "rsgain reported no reference loudness",
  );

  if (options.opus) {
    patch.set("r128_track_gain", result.r128TrackGain);
    patch.set("r128_album_gain", result.r128AlbumGain);
  } else {
    patch.naAll(["r128_track_gain", "r128_album_gain"], "R128 tags exist only in Opus files");
  }

  return patch.build();
}
