/**
 * One value per album, for every field the tag map marks `albumScope`.
 *
 * The fourth MCP test report found the CHVRCHES album scoring 0.9529 while every one of its
 * thirteen tracks scored 0.9929. The 0.04 was `albumCompleteness`'s divergence penalty on two
 * fields, `genre` and `copyright` — and neither divergence was an accident of the data:
 *
 *  - `genre` is `albumScope: true` and the tag map sources it "recording > release-group >
 *    artist". The recording is a **per-track** entity, so an album whose recordings carry
 *    different MusicBrainz genres — that is, any album that is not mono-genre — diverges by
 *    construction. The interlude that has no MusicBrainz genre at all falls back to Last.fm
 *    and diverges a second time.
 *  - `copyright` comes from the ℗ line of each video's description, which is per video.
 *
 * Penalising that would have been treating the symptom. This module is the cure: given the
 * album's documents, it resolves **one** value per album-scope field (`./rules.ts` says which
 * set the value is constant over and how it is chosen) and rewrites every track's document
 * with it. Fields the tag map keeps per track — `title`, `tracknumber`, `isrc`,
 * `replaygain_track_*`, the recording MBID — are never touched.
 *
 * Three properties matter and are tested:
 *
 *  - **idempotent.** Applying the resolution to its own output changes nothing, which is what
 *    lets the re-tag run twice without a diff and lets a batch that only holds half an album
 *    read the other half from what is already stored.
 *  - **deterministic.** No clock, no set iteration order that depends on insertion: a union is
 *    ordered by frequency then alphabetically, ties always go to the earliest track. The
 *    projection hash of a re-tag has to be reproducible months later (§8).
 *  - **a locked value always wins.** That is what `locked` means everywhere else in the
 *    document, and a value somebody typed by hand is the album's answer by definition.
 */

import {
  canonicalValue,
  mediumKeyOf,
  type Field,
  type FieldValue,
  type NotApplicable,
  type SourceId,
  type TrackDocument,
} from "../metadata/document.ts";
import { SOURCE_PRECEDENCE } from "../metadata/resolvers/index.ts";
import { ALBUM_SCOPE_FIELDS } from "../tagmap/tags.ts";
import { albumScopeRule, type AlbumScopeGrouping } from "./rules.ts";

export {
  ALBUM_SCOPE_RULES,
  albumScopeRule,
  type AlbumScopeGrouping,
  type AlbumScopeRule,
  type AlbumScopeStrategy,
} from "./rules.ts";

/** How many values a capped union keeps when the caller says nothing. Mirrors `maxGenres`. */
export const DEFAULT_MAX_VALUES = 3;

export interface AlbumScopeOptions {
  /** The `maxGenres` setting: how many values a capped union keeps. */
  readonly maxGenres?: number;
  /**
   * Values an **album-scope source** answered for, per field. They beat every aggregation of
   * the tracks, because an aggregation is a guess about the album and this is the album's own
   * answer. The `tag` step fills it with the release group's genres, read from the raw cache.
   */
  readonly albumValues?: Readonly<Record<string, Field>>;
}

/** One field unified, and what it cost. */
export interface AlbumScopeChoice {
  readonly field: string;
  readonly grouping: AlbumScopeGrouping;
  /** The disc number a `medium` choice applies to; `null` for an album-wide one. */
  readonly medium: number | null;
  readonly value: FieldValue;
  readonly source: SourceId;
  /** The rule, in one line — `./rules.ts`'s `why`, or why a lock or an album source won. */
  readonly rule: string;
  /** Positions in the input array whose value this choice replaces. */
  readonly changes: readonly number[];
}

export interface AlbumScopeResolution {
  readonly choices: readonly AlbumScopeChoice[];
  /** The fields whose tracks did not already agree. Empty means there was nothing to do. */
  readonly divergentFields: readonly string[];
}

const RANK = new Map<SourceId, number>(SOURCE_PRECEDENCE.map((source, index) => [source, index]));
const rankOf = (source: SourceId): number => RANK.get(source) ?? Number.MAX_SAFE_INTEGER;

interface Entry {
  readonly index: number;
  readonly held: Field | undefined;
}

/** The bucket key of a field a track does not carry. A NUL cannot start a real value. */
const ABSENT = "\u0000absent";

/** A value rendered for comparison; `undefined` (absent) is its own bucket. */
function keyOf(held: Field | undefined): string {
  return held === undefined ? ABSENT : canonicalValue(held.value);
}

function stringsOf(value: FieldValue): string[] {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

/**
 * Resolve every album-scope field to one value.
 *
 * `documents` is the album's tracks **in track order**; the indexes reported in `changes` are
 * positions in that array. A field no track carries is left alone: unifying "absent" onto
 * "absent" writes nothing and would only make the n/a reasons disappear.
 */
export function resolveAlbumScope(
  documents: readonly TrackDocument[],
  options: AlbumScopeOptions = {},
): AlbumScopeResolution {
  const maxValues = options.maxGenres ?? DEFAULT_MAX_VALUES;
  const choices: AlbumScopeChoice[] = [];
  const divergentFields: string[] = [];

  for (const field of ALBUM_SCOPE_FIELDS) {
    const rule = albumScopeRule(field);
    const groups = new Map<number | null, Entry[]>();
    documents.forEach((document, index) => {
      const key = rule.grouping === "album" ? null : mediumKeyOf(document);
      const bucket = groups.get(key);
      const entry: Entry = { index, held: document.fields[field] };
      if (bucket === undefined) groups.set(key, [entry]);
      else bucket.push(entry);
    });

    let diverged = false;
    for (const [medium, entries] of [...groups.entries()].sort(compareMedium)) {
      if (new Set(entries.map((entry) => keyOf(entry.held))).size > 1) diverged = true;

      const present = entries.filter(
        (entry): entry is Entry & { held: Field } => entry.held !== undefined,
      );
      if (present.length === 0) continue;

      const chosen = choose(field, present, rule, options, maxValues);
      if (chosen === null) continue;

      const key = canonicalValue(chosen.value);
      const changes = entries
        .filter((entry) => keyOf(entry.held) !== key)
        .map((entry) => entry.index);

      choices.push({
        field,
        grouping: rule.grouping,
        medium,
        value: chosen.value,
        source: chosen.source,
        rule: chosen.rule,
        changes,
      });
    }
    if (diverged) divergentFields.push(field);
  }

  return { choices, divergentFields };
}

function compareMedium(a: readonly [number | null, unknown], b: readonly [number | null, unknown]) {
  return (a[0] ?? 0) - (b[0] ?? 0);
}

interface Chosen {
  readonly value: FieldValue;
  readonly source: SourceId;
  readonly rule: string;
}

function choose(
  field: string,
  present: readonly (Entry & { held: Field })[],
  rule: ReturnType<typeof albumScopeRule>,
  options: AlbumScopeOptions,
  maxValues: number,
): Chosen | null {
  /* 1 · a locked value is the album's answer, whatever the sources say. */
  const locked = present.find((entry) => entry.held.locked);
  if (locked !== undefined) {
    return {
      value: locked.held.value,
      source: locked.held.source,
      rule: `a value locked on track ${String(locked.index + 1)} wins for the whole album`,
    };
  }

  /* 2 · an album-scope source answered for this album-scope field. */
  const supplied = options.albumValues?.[field];
  if (supplied !== undefined && rule.grouping === "album") {
    return {
      value: supplied.value,
      source: supplied.source,
      rule: rule.why,
    };
  }

  /*
   * 3 · the tracks that carry the field already agree — say so and stop.
   *
   * Without this, a `union` would re-order itself for ever: the first pass writes
   * `["synth-pop", "electropop"]` (three votes to one), the second sees two values with three
   * votes each and re-sorts them alphabetically, and the re-tag rewrites thirteen files on
   * every run. Convergence is not a nicety here — §8's diff has to go empty.
   */
  const unanimous = present[0];
  if (
    unanimous !== undefined &&
    present.every(
      (entry) => canonicalValue(entry.held.value) === canonicalValue(unanimous.held.value),
    )
  ) {
    return {
      value: unanimous.held.value,
      source: unanimous.held.source,
      rule: "every track that carries it already agrees",
    };
  }

  /* 4 · only the best-ranked source votes: one Last.fm fallback cannot outvote MusicBrainz. */
  const best = Math.min(...present.map((entry) => rankOf(entry.held.source)));
  const voters = present.filter((entry) => rankOf(entry.held.source) === best);
  const first = voters[0];
  if (first === undefined) return null;

  if (rule.strategy === "union") {
    const counts = new Map<string, number>();
    for (const entry of voters) {
      for (const value of stringsOf(entry.held.value)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return null;
    const ordered = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value]) => value);
    const kept = rule.capped ? ordered.slice(0, Math.max(1, maxValues)) : ordered;
    return { value: kept, source: first.held.source, rule: rule.why };
  }

  if (rule.strategy === "mostSpecific") {
    const winner = voters.reduce((best_, entry) => {
      const a = canonicalValue(entry.held.value);
      const b = canonicalValue(best_.held.value);
      return a.length > b.length ? entry : best_;
    }, first);
    return { value: winner.held.value, source: winner.held.source, rule: rule.why };
  }

  /* majority: the most frequent rendering, ties to the earliest track. */
  const tally = new Map<string, { count: number; entry: Entry & { held: Field } }>();
  for (const entry of voters) {
    const key = canonicalValue(entry.held.value);
    const seen = tally.get(key);
    if (seen === undefined) tally.set(key, { count: 1, entry });
    else seen.count += 1;
  }
  const winner = [...tally.values()].sort(
    (a, b) => b.count - a.count || a.entry.index - b.entry.index,
  )[0];
  if (winner === undefined) return null;
  return { value: winner.entry.held.value, source: winner.entry.held.source, rule: rule.why };
}

/**
 * Rewrite one document with the resolved values.
 *
 * Keyed on the **disc**, never on the track's position in the album, so a resolution computed
 * once over the whole album can be applied to a single file. That is what the background
 * re-tag needs: it works in batches of `retagBatchSize`, and a batch that holds four tracks of
 * a thirteen-track album must still write the album's value, not the batch's.
 *
 * A field the resolution fills stops being n/a on a track that had it n/a — the album *has* a
 * genre, this track simply had no recording-level one — which is the same rule `merge` applies
 * when a resolver produces a value for a field another declared absent. A document nothing
 * changes is returned unchanged, by identity.
 */
export function applyAlbumScopeTo(
  document: TrackDocument,
  resolution: AlbumScopeResolution,
): TrackDocument {
  const medium = mediumKeyOf(document);
  let fields: Record<string, Field> | null = null;
  let na: Record<string, NotApplicable> | null = null;

  for (const choice of resolution.choices) {
    if (choice.grouping === "medium" && choice.medium !== medium) continue;
    const held = document.fields[choice.field];
    if (held !== undefined && canonicalValue(held.value) === canonicalValue(choice.value)) continue;
    fields ??= { ...document.fields };
    na ??= { ...document.na };
    fields[choice.field] = {
      value: choice.value,
      source: choice.source,
      confidence: held?.confidence ?? 1,
      fetchedAt: held?.fetchedAt ?? latestFetchedAt(document),
      locked: held?.locked ?? false,
    };
    delete na[choice.field];
  }

  return fields === null || na === null ? document : { ...document, fields, na };
}

/** `applyAlbumScopeTo` over a whole album. */
export function applyAlbumScope(
  documents: readonly TrackDocument[],
  resolution: AlbumScopeResolution,
): TrackDocument[] {
  return documents.map((document) => applyAlbumScopeTo(document, resolution));
}

/** The choices that actually rewrite something — what a diff or a report should show. */
export function changedChoices(resolution: AlbumScopeResolution): readonly AlbumScopeChoice[] {
  return resolution.choices.filter((choice) => choice.changes.length > 0);
}

/** The newest `fetchedAt` in a document — the stamp a field the track never held inherits. */
function latestFetchedAt(document: TrackDocument): string {
  let latest = "";
  for (const held of Object.values(document.fields)) {
    if (held.fetchedAt > latest) latest = held.fetchedAt;
  }
  return latest === "" ? new Date(0).toISOString() : latest;
}

/** `resolveAlbumScope` then `applyAlbumScope`, which is how every caller uses them. */
export function unifyAlbumScope(
  documents: readonly TrackDocument[],
  options: AlbumScopeOptions = {},
): { documents: TrackDocument[]; resolution: AlbumScopeResolution } {
  const resolution = resolveAlbumScope(documents, options);
  return { documents: applyAlbumScope(documents, resolution), resolution };
}
