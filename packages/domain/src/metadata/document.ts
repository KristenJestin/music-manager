/**
 * The metadata document — layer 2 of `docs/03-metadonnees.md` §1.
 *
 * The database is the source of truth; files are a regenerable projection of it. A document
 * holds one entry per tag-map field with its provenance, and is recomputable at will from the
 * raw cache plus the values you locked.
 *
 * A field is in exactly one of three states:
 *  - **present**: an entry in `fields`;
 *  - **n/a**: an entry in `na`, with the reason the source gives (instrumental track, release
 *    with no label, recording with no linked work…). n/a leaves the completeness denominator;
 *  - **missing**: neither — it counts against the score.
 */

import { albumScopeRule } from "../albumscope/rules.ts";
import { ALBUM_SCOPE_FIELDS, tagByField } from "../tagmap/tags.ts";

/** Every source a value can come from (§4), plus the two non-network ones. */
export const SOURCES = [
  "musicbrainz",
  "coverartarchive",
  "acoustid",
  "lrclib",
  "deezer",
  "lastfm",
  "listenbrainz",
  "wikimedia",
  "rsgain",
  "youtube",
  "app",
  /**
   * The v1 database, as read by the migration of P11.
   *
   * It is a source like any other and is treated like one: it seeds a field with low
   * confidence and no precedence, so the moment MusicBrainz answers for the same field the
   * real value wins. What v1's owner *forced* by hand arrives locked instead, and a locked
   * value beats every source — which is the whole point of migrating those overrides rather
   * than discarding them.
   */
  "v1",
  "user",
] as const;

export type SourceId = (typeof SOURCES)[number];

/** A credited performer: `PERFORMER=Nile Rodgers (guitar)` (§2.3). */
export interface PerformerCredit {
  readonly name: string;
  readonly role: string;
  readonly mbid?: string;
}

/** An image to embed. Pictures are projected apart from the text tags (§2.6). */
export interface EmbeddedPicture {
  readonly kind: "front" | "back";
  readonly mimeType: string;
  readonly url: string;
  readonly comment?: string;
}

/** LRCLIB gives synchronised lyrics when it has them, plain text otherwise (§2.6). */
export interface LyricsValue {
  readonly synced: string | null;
  readonly plain: string | null;
}

export type FieldValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly PerformerCredit[]
  | readonly EmbeddedPicture[]
  | LyricsValue;

/** One resolved value with its provenance (§1). */
export interface Field<T extends FieldValue = FieldValue> {
  readonly value: T;
  readonly source: SourceId;
  /** 0…1. How sure the resolver is; ties in `merge` are broken by it. */
  readonly confidence: number;
  /** ISO-8601 instant the underlying source response was fetched. */
  readonly fetchedAt: string;
  /** A locked value survives every re-resolution and wins every merge. */
  readonly locked: boolean;
}

/** Why a field does not apply to this track. Shown as “n/a” rather than “missing”. */
export interface NotApplicable {
  readonly reason: string;
  readonly source: SourceId;
}

export interface TrackDocument {
  /** `TAG_SCHEMA_VERSION` at the time the document was built (see ./schema.ts). */
  readonly schemaVersion: number;
  readonly fields: Readonly<Record<string, Field>>;
  readonly na: Readonly<Record<string, NotApplicable>>;
}

/** A partial contribution to a document: what one resolver produces. */
export interface DocumentPatch {
  readonly fields?: Readonly<Record<string, Field>>;
  readonly na?: Readonly<Record<string, NotApplicable>>;
}

export function emptyDocument(schemaVersion: number): TrackDocument {
  return { schemaVersion, fields: {}, na: {} };
}

/** Build a `Field` without repeating the boilerplate at every resolver call site. */
export function field<T extends FieldValue>(
  value: T,
  source: SourceId,
  fetchedAt: string,
  options: { confidence?: number; locked?: boolean } = {},
): Field<T> {
  return {
    value,
    source,
    confidence: options.confidence ?? 1,
    fetchedAt,
    locked: options.locked ?? false,
  };
}

/**
 * Merge resolver outputs into one document.
 *
 * The rules, in order:
 *  1. a **locked** value always wins (that is what `locked` is for — §1);
 *  2. otherwise the value whose source comes first in `precedence` wins;
 *  3. sources equally ranked (or absent from `precedence`) are settled by `confidence`,
 *     then by patch order — the last patch wins, so callers can layer refinements.
 *
 * A field that any patch marks present is never n/a: an explicit value beats “the source says
 * it does not exist”, which is what happens when you fill a field by hand.
 */
export function merge(
  patches: readonly DocumentPatch[],
  options: { schemaVersion: number; precedence?: readonly SourceId[] },
): TrackDocument {
  const rank = new Map<SourceId, number>();
  (options.precedence ?? []).forEach((source, index) => rank.set(source, index));
  const rankOf = (source: SourceId): number => rank.get(source) ?? Number.MAX_SAFE_INTEGER;

  const fields: Record<string, Field> = {};
  const na: Record<string, NotApplicable> = {};

  for (const patch of patches) {
    for (const [name, candidate] of Object.entries(patch.na ?? {})) {
      na[name] = candidate;
    }
    for (const [name, candidate] of Object.entries(patch.fields ?? {})) {
      const held = fields[name];
      if (held === undefined || wins(candidate, held, rankOf)) fields[name] = candidate;
    }
  }

  for (const name of Object.keys(fields)) delete na[name];

  return { schemaVersion: options.schemaVersion, fields, na };
}

function wins(candidate: Field, held: Field, rankOf: (source: SourceId) => number): boolean {
  if (held.locked) return false;
  if (candidate.locked) return true;
  const candidateRank = rankOf(candidate.source);
  const heldRank = rankOf(held.source);
  if (candidateRank !== heldRank) return candidateRank < heldRank;
  return candidate.confidence >= held.confidence;
}

/** Pin a value: it survives every later re-resolution (§1). */
export function lock(document: TrackDocument, name: string): TrackDocument {
  return setLocked(document, name, true);
}

/** Release a pinned value, letting the resolvers own it again. */
export function unlock(document: TrackDocument, name: string): TrackDocument {
  return setLocked(document, name, false);
}

function setLocked(document: TrackDocument, name: string, locked: boolean): TrackDocument {
  const held = document.fields[name];
  if (held === undefined)
    throw new Error(`cannot ${locked ? "lock" : "unlock"} absent field: ${name}`);
  return {
    ...document,
    fields: { ...document.fields, [name]: { ...held, locked } },
  };
}

/** Overwrite a field by hand. The value is locked, so no resolver can take it back. */
export function setUserValue<T extends FieldValue>(
  document: TrackDocument,
  name: string,
  value: T,
  fetchedAt: string,
): TrackDocument {
  const { [name]: _removed, ...na } = document.na;
  return {
    ...document,
    fields: { ...document.fields, [name]: field(value, "user", fetchedAt, { locked: true }) },
    na,
  };
}

export interface AlbumScopeDivergence {
  readonly field: string;
  /** One entry per distinct rendering of the value, with the indexes of the tracks holding it. */
  readonly values: readonly { readonly value: string; readonly tracks: readonly number[] }[];
  /** The disc a `medium`-grouped divergence was found on; `null` for an album-wide field. */
  readonly medium?: number | null;
}

/**
 * Which disc a document belongs to — the grouping key of a `medium`-scoped field.
 *
 * `DISCNUMBER` is per track and always present on a MusicBrainz-matched release; a document
 * that has none is treated as disc 1, which is what a single-medium release means anyway.
 */
export function mediumKeyOf(document: TrackDocument): number {
  const held = document.fields["discnumber"]?.value;
  if (typeof held === "number") return held;
  if (typeof held === "string") {
    const parsed = Number.parseInt(held, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1;
}

export interface AlbumScopeReport {
  readonly consistent: boolean;
  readonly divergences: readonly AlbumScopeDivergence[];
}

/**
 * Album-scope check (§2, “Champs à portée album”): genre, mood, releasetype, label, the
 * totals… must be identical on every track, or some servers split the album in two. Absence
 * counts as its own value, so “one track missing GENRE” is reported too.
 *
 * The comparison set is the field's own, from `albumscope/rules.ts`: `TRACKTOTAL` and `MEDIA`
 * are sourced from the *medium*, so they are compared disc by disc. Comparing them across a
 * two-disc release reported a divergence that is not one, and a "fix" that unified them would
 * have written disc one's track count onto disc two.
 *
 * `documents` is the album's tracks in track order; the reported indexes are positions in
 * that array.
 */
/** The bucket key of a field no track carries. A NUL cannot start a real value. */
const ABSENT = "\u0000absent";

export function albumScopeConsistency(documents: readonly TrackDocument[]): AlbumScopeReport {
  if (documents.length < 2) return { consistent: true, divergences: [] };

  const divergences: AlbumScopeDivergence[] = [];

  for (const name of ALBUM_SCOPE_FIELDS) {
    const grouping = albumScopeRule(name).grouping;
    const groups = new Map<number | null, Map<string, number[]>>();
    documents.forEach((document, index) => {
      const group = grouping === "album" ? null : mediumKeyOf(document);
      let buckets = groups.get(group);
      if (buckets === undefined) {
        buckets = new Map<string, number[]>();
        groups.set(group, buckets);
      }
      const held = document.fields[name];
      const key = held === undefined ? ABSENT : canonicalValue(held.value);
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [index]);
      else bucket.push(index);
    });

    const ordered = [...groups.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    for (const [medium, buckets] of ordered) {
      if (buckets.size < 2) continue;
      const values = [...buckets.entries()].map(([key, tracks]) => ({
        value: key === ABSENT ? "(absent)" : key,
        tracks,
      }));
      divergences.push(medium === null ? { field: name, values } : { field: name, values, medium });
    }
  }

  return { consistent: divergences.length === 0, divergences };
}

/** A stable, comparable rendering of a value — used for equality, never written to a file. */
export function canonicalValue(value: FieldValue): string {
  if (Array.isArray(value)) {
    return (value as readonly unknown[])
      .map((item) =>
        typeof item === "object" && item !== null ? JSON.stringify(item) : String(item),
      )
      .join("");
  }
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Every field name in a document that the tag map does not know — always empty in practice. */
export function unknownFields(document: TrackDocument): readonly string[] {
  return [...Object.keys(document.fields), ...Object.keys(document.na)].filter(
    (name) => tagByField(name) === undefined,
  );
}
