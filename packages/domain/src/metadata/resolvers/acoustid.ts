/**
 * AcoustID → `ACOUSTID_ID`, `ACOUSTID_FINGERPRINT` (`docs/03-metadonnees.md` §2.5).
 *
 * The lookup happens after the download, on the file's own fingerprint. Writing the AcoustID
 * into the file makes re-identifying it later free, with no network call at all (§8).
 *
 * The resolver also reports which recording MBIDs AcoustID proposes, so the `fingerprint`
 * step of the pipeline can compare them with the mapping the user confirmed and raise a
 * `fingerprint_mismatch` Inbox item on disagreement (docs/04 §Étapes). It never *chooses*.
 */

import type { DocumentPatch } from "../document.ts";
import { PatchBuilder } from "./patch.ts";

export interface AcoustIdRecording {
  readonly id?: string;
  readonly title?: string;
  readonly duration?: number;
}

export interface AcoustIdResult {
  readonly id?: string;
  readonly score?: number;
  readonly recordings?: readonly AcoustIdRecording[];
}

export interface AcoustIdResponse {
  readonly status?: string;
  readonly results?: readonly AcoustIdResult[];
  readonly error?: { readonly message?: string };
}

export interface AcoustIdOptions {
  readonly fetchedAt: string;
  /** The Chromaprint fingerprint; only written when the option is on (§2.5: bulky). */
  readonly fingerprint?: string;
  /** Minimum score to accept a result. AcoustID scores are in [0, 1]. */
  readonly minimumScore?: number;
}

/** The best result above the threshold, or `null`. Results are already score-ordered. */
export function bestAcoustIdResult(
  response: AcoustIdResponse,
  minimumScore = 0.5,
): AcoustIdResult | null {
  if (response.status !== undefined && response.status !== "ok") return null;
  const ranked = [...(response.results ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = ranked[0];
  if (best === undefined || (best.score ?? 0) < minimumScore) return null;
  return best;
}

/** The recording MBIDs AcoustID proposes for the best result — the mismatch check's input. */
export function acoustIdRecordingIds(
  response: AcoustIdResponse,
  minimumScore = 0.5,
): readonly string[] {
  const best = bestAcoustIdResult(response, minimumScore);
  return (best?.recordings ?? []).map((recording) => recording.id ?? "").filter((id) => id !== "");
}

export function fromAcoustId(response: AcoustIdResponse, options: AcoustIdOptions): DocumentPatch {
  const patch = new PatchBuilder("acoustid", options.fetchedAt);
  const best = bestAcoustIdResult(response, options.minimumScore ?? 0.5);

  if (best?.id === undefined)
    patch.na("acoustid", "AcoustID returned no result above the threshold");
  else patch.set("acoustid", best.id, { confidence: best.score ?? 1 });

  if (options.fingerprint === undefined) {
    patch.na("acoustid_fingerprint", "fingerprint writing is off (§2.5: bulky, opt-in)");
  } else {
    patch.set("acoustid_fingerprint", options.fingerprint);
  }

  return patch.build();
}
