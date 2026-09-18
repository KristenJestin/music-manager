/**
 * The application's own namespace (`docs/03-metadonnees.md` §2.6).
 *
 * `MUSICMANAGER_TAGSCHEMA` is what makes §8's "never re-download" promise work: the
 * background re-tag job selects the files whose schema is behind the current one and
 * re-projects them from the raw cache, with no network at all.
 *
 * Nothing here comes from a source: these fields are facts about *our* processing, so they
 * are always present and never n/a.
 */

import type { DocumentPatch } from "../document.ts";
import { PatchBuilder } from "./patch.ts";

export interface AppProvenance {
  /** The import job this track belongs to. */
  readonly importId: string;
  /**
   * The URL the audio came from — the machine-readable twin of `COMMENT`.
   *
   * **`null` when there genuinely is not one.** A track of a release that the source never
   * published has a row of its own so that a file can be adopted onto it, and that row has no
   * video and no URL. Writing an empty string, or the import's own playlist URL, would put a
   * value into the one field the library scan, the v1 reconciliation and the re-tag all match
   * on — and they would match the wrong thing, or match every such track to each other.
   * Absent is the truth, and `n/a` is how this document says absent.
   */
  readonly sourceUrl: string | null;
  /** `TAG_SCHEMA_VERSION`; see ../schema.ts. */
  readonly tagSchemaVersion: number;
  /** Encoder identification, when the toolbox transcoded rather than remuxed. */
  readonly encodedBy?: string;
  readonly fetchedAt: string;
}

export function fromApp(provenance: AppProvenance): DocumentPatch {
  const patch = new PatchBuilder("app", provenance.fetchedAt);

  patch.set("musicmanager_tagschema", provenance.tagSchemaVersion);
  patch.set("musicmanager_importid", provenance.importId);
  patch.setOrNa(
    "musicmanager_sourceurl",
    provenance.sourceUrl ?? undefined,
    "this track came from no source of its own; a file was adopted onto it",
  );
  if (provenance.encodedBy !== undefined) patch.set("encodedby", provenance.encodedBy);

  // §2.4/§2.6: nothing in our pipeline produces these, and no source ever will for a
  // YouTube-sourced track. Marking them here keeps them out of the completeness denominator
  // instead of leaving them permanently "missing".
  patch.na("key", "local key analysis is off by default (§2.6)");

  return patch.build();
}
