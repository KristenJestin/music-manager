/**
 * Completeness scoring (`docs/03-metadonnees.md` §6).
 *
 * Per track: a weighted sum of the fields present over the fields that apply. Required
 * counts 3, recommended 2, optional 1. A field the source says does not exist is **n/a** and
 * leaves the denominator — an instrumental track is not punished for having no lyrics, a
 * self-released album is not punished for having no label.
 *
 * Two readings, always both:
 *  - **global**, over the whole superset — what we actually wrote;
 *  - **per profile**, over the fields one consumer indexes — what Navidrome will show.
 *
 * Per album: the mean of the tracks, minus a penalty when a field of album scope diverges
 * between tracks, because that is what makes some servers split an album in two.
 */

import { albumScopeConsistency, type TrackDocument } from "../metadata/document.ts";
import { profileById, type ConsumerProfile, type ProfileId } from "../tagmap/profiles.ts";
import { LEVEL_WEIGHT, TAGS, type TagDefinition } from "../tagmap/tags.ts";

export type FieldState = "present" | "missing" | "na";

export interface FieldReport {
  readonly field: string;
  readonly vorbis: string;
  readonly state: FieldState;
  readonly level: TagDefinition["level"];
  readonly weight: number;
  /** Only for `na`: why the source says the field does not exist. */
  readonly reason?: string;
}

export interface CompletenessScore {
  /** 0…1, or `null` when nothing applies at all (an empty profile). */
  readonly score: number | null;
  readonly earned: number;
  readonly applicable: number;
  readonly present: readonly string[];
  readonly missing: readonly string[];
  readonly na: readonly string[];
}

export interface TrackCompleteness extends CompletenessScore {
  readonly byProfile: Readonly<Record<ProfileId, CompletenessScore>>;
  readonly fields: readonly FieldReport[];
}

function stateOf(document: TrackDocument, tag: TagDefinition): FieldState {
  if (tag.field in document.fields) return "present";
  if (tag.field in document.na) return "na";
  return "missing";
}

function scoreOver(document: TrackDocument, tags: readonly TagDefinition[]): CompletenessScore {
  let earned = 0;
  let applicable = 0;
  const present: string[] = [];
  const missing: string[] = [];
  const na: string[] = [];

  for (const tag of tags) {
    const state = stateOf(document, tag);
    if (state === "na") {
      na.push(tag.field);
      continue;
    }
    const weight = LEVEL_WEIGHT[tag.level];
    applicable += weight;
    if (state === "present") {
      earned += weight;
      present.push(tag.field);
    } else {
      missing.push(tag.field);
    }
  }

  return {
    score: applicable === 0 ? null : earned / applicable,
    earned,
    applicable,
    present,
    missing,
    na,
  };
}

/** The global score, the per-profile scores, and the state of every field of the map. */
export function trackCompleteness(document: TrackDocument): TrackCompleteness {
  const global = scoreOver(document, TAGS);

  const byProfile = {} as Record<ProfileId, CompletenessScore>;
  for (const profile of ["navidrome", "jellyfin", "plex", "kodi", "lms", "players"] as const) {
    byProfile[profile] = profileCompleteness(document, profileById(profile));
  }

  const fields: FieldReport[] = TAGS.map((tag) => {
    const state = stateOf(document, tag);
    const reason = document.na[tag.field]?.reason;
    const base = {
      field: tag.field,
      vorbis: tag.vorbis,
      state,
      level: tag.level,
      weight: LEVEL_WEIGHT[tag.level],
    };
    return state === "na" && reason !== undefined ? { ...base, reason } : base;
  });

  return { ...global, byProfile, fields };
}

/** The same score restricted to the fields one consumer indexes (§5). */
export function profileCompleteness(
  document: TrackDocument,
  profile: ConsumerProfile,
): CompletenessScore {
  const reads = new Set(profile.reads);
  return scoreOver(
    document,
    TAGS.filter((tag) => reads.has(tag.field)),
  );
}

export interface AlbumCompleteness extends CompletenessScore {
  /** The mean of the tracks' global scores, before the divergence penalty. */
  readonly meanTrackScore: number | null;
  /** The mean after the penalty — what the album badge shows. */
  readonly score: number | null;
  readonly divergentFields: readonly string[];
  readonly penalty: number;
  readonly byProfile: Readonly<Record<ProfileId, number | null>>;
}

/**
 * Penalty per album-scope field that diverges between tracks. Small on purpose: a divergence
 * is a warning about how a server will group the album, not a metadata failure. Capped at
 * `MAX_DIVERGENCE_PENALTY` so a badly split album still reports its real field coverage.
 */
const DIVERGENCE_PENALTY = 0.02;
const MAX_DIVERGENCE_PENALTY = 0.2;

/** The album badge: the mean of the tracks, penalised for album-scope drift (§6). */
export function albumCompleteness(documents: readonly TrackDocument[]): AlbumCompleteness {
  const tracks = documents.map(trackCompleteness);
  const scored = tracks
    .map((track) => track.score)
    .filter((score): score is number => score !== null);
  const mean = scored.length === 0 ? null : scored.reduce((a, b) => a + b, 0) / scored.length;

  const report = albumScopeConsistency(documents);
  const divergentFields = report.divergences.map((divergence) => divergence.field);
  const penalty = Math.min(divergentFields.length * DIVERGENCE_PENALTY, MAX_DIVERGENCE_PENALTY);

  const byProfile = {} as Record<ProfileId, number | null>;
  for (const profile of ["navidrome", "jellyfin", "plex", "kodi", "lms", "players"] as const) {
    const values = tracks
      .map((track) => track.byProfile[profile].score)
      .filter((score): score is number => score !== null);
    byProfile[profile] =
      values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  }

  return {
    score: mean === null ? null : Math.max(0, mean - penalty),
    meanTrackScore: mean,
    earned: tracks.reduce((total, track) => total + track.earned, 0),
    applicable: tracks.reduce((total, track) => total + track.applicable, 0),
    present: [],
    missing: [...new Set(tracks.flatMap((track) => track.missing))].sort(),
    na: [...new Set(tracks.flatMap((track) => track.na))].sort(),
    divergentFields,
    penalty,
    byProfile,
  };
}
