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
  /** The URL the audio came from — the machine-readable twin of `COMMENT`. */
  readonly sourceUrl: string;
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
  patch.set("musicmanager_sourceurl", provenance.sourceUrl);
  if (provenance.encodedBy !== undefined) patch.set("encodedby", provenance.encodedBy);

  // §2.4/§2.6: nothing in our pipeline produces these, and no source ever will for a
  // YouTube-sourced track. Marking them here keeps them out of the completeness denominator
  // instead of leaving them permanently "missing".
  patch.na("key", "local key analysis is off by default (§2.6)");

  return patch.build();
}
