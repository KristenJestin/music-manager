/**
 * MusicBrainz → document fields.
 *
 * Three pure resolvers, one per entity, each producing a `DocumentPatch`. They are merged in
 * precedence order by the caller (`merge`), so `fromMusicBrainzRecording` can refine what
 * `fromMusicBrainzRelease` established without either of them knowing about the other.
 *
 * The n/a decisions live here, because this is where we know what MusicBrainz *said*: a
 * release with no label-info genuinely has no `LABEL`, a recording with no linked work has no
 * `WORK`, `LANGUAGE` or movement. That is §6's "the source says it does not exist", and it is
 * what keeps the completeness score honest instead of punishing us for facts nobody has.
 */

import type { DocumentPatch } from "../document.ts";
import type { PerformerCredit } from "../document.ts";
import {
  artistIds,
  artistNames,
  artistSortNames,
  joinArtistCredit,
  topGenres,
  type MbRecording,
  type MbRelation,
  type MbRelease,
  type MbWork,
} from "./musicbrainz-types.ts";
import { PatchBuilder } from "./patch.ts";
import { creditsFromRelations, mbidFieldFor, performedWork, urlOfType } from "./relations.ts";

/**
 * MusicBrainz tags are folk taxonomy: mostly genres, sometimes a mood. `MOOD` takes only the
 * tags in this vocabulary, so "seen live" and "french house" never end up in it (§2.4).
 */
const MOOD_VOCABULARY: ReadonlySet<string> = new Set([
  "aggressive",
  "atmospheric",
  "calm",
  "chill",
  "dark",
  "dreamy",
  "energetic",
  "epic",
  "euphoric",
  "happy",
  "hypnotic",
  "melancholic",
  "melancholy",
  "mellow",
  "nostalgic",
  "party",
  "peaceful",
  "relaxing",
  "romantic",
  "sad",
  "sensual",
  "uplifting",
  "upbeat",
]);

/** Fields that only exist for classical repertoire; §2.4's movement block. */
const CLASSICAL_FIELDS = ["movement", "movementnumber", "movementtotal", "showmovement"] as const;

export interface ReleaseResolverOptions {
  /** 1-based medium position; defaults to the first medium. */
  readonly mediumPosition?: number;
  /** 1-based track position on that medium. */
  readonly trackPosition: number;
  /** ISO-8601 instant the response was fetched — becomes every field's `fetchedAt`. */
  readonly fetchedAt: string;
}

/**
 * Everything one release says about one of its tracks: the album-scope block (§2 notes), the
 * track's position, its credited title and artists, and the release identifiers.
 *
 * Recording-level facts (ISRC, genres, credits, work) come from `fromMusicBrainzRecording`,
 * which this resolver deliberately does not call: the caller merges the two.
 */
export function fromMusicBrainzRelease(
  release: MbRelease,
  options: ReleaseResolverOptions,
): DocumentPatch {
  const patch = new PatchBuilder("musicbrainz", options.fetchedAt);

  const media = release.media ?? [];
  const medium =
    options.mediumPosition === undefined
      ? media[0]
      : media.find((candidate) => candidate.position === options.mediumPosition);
  const track = (medium?.tracks ?? []).find(
    (candidate) => candidate.position === options.trackPosition,
  );
  const releaseGroup = release["release-group"];

  /* ---- §2.1 identity and position ---- */
  patch.set("album", release.title);
  patch.na("albumsort", "MusicBrainz has no sort title for releases");
  const albumArtistCredit = release["artist-credit"];
  patch.set("albumartist", joinArtistCredit(albumArtistCredit));
  patch.set("albumartists", artistNames(albumArtistCredit));
  patch.set("albumartistsort", artistSortNames(albumArtistCredit));
  patch.set("musicbrainz_albumartistid", artistIds(albumArtistCredit));
  patch.setOrNa(
    "albumcomment",
    release.disambiguation,
    "the release has no disambiguation comment",
  );

  if (track !== undefined) {
    patch.set("title", track.title);
    patch.na("titlesort", "MusicBrainz has no sort title for recordings");
    const trackCredit = track["artist-credit"] ?? track.recording?.["artist-credit"];
    patch.set("artist", joinArtistCredit(trackCredit));
    patch.set("artists", artistNames(trackCredit));
    patch.set("artistsort", artistSortNames(trackCredit));
    patch.set("musicbrainz_artistid", artistIds(trackCredit));
    patch.set("tracknumber", track.position);
    patch.set("musicbrainz_releasetrackid", track.id);
  }

  const totalTracks = medium?.["track-count"] ?? medium?.tracks?.length;
  patch.set("totaltracks", totalTracks);
  patch.set("totaltracks_alias", totalTracks);
  patch.set("discnumber", medium?.position ?? 1);
  patch.set("totaldiscs", media.length);
  patch.set("totaldiscs_alias", media.length);
  patch.setOrNa("discsubtitle", medium?.title, "the medium has no title");

  const isCompilation = artistNames(albumArtistCredit).includes("Various Artists");
  if (isCompilation) patch.set("compilation", true);
  else patch.na("compilation", "the release is not a Various Artists compilation");

  /* ---- §2.2 dates and release ---- */
  patch.set("date", release.date);
  patch.set("releasedate", release.date);
  const originalDate = releaseGroup?.["first-release-date"];
  patch.set("originaldate", originalDate);
  patch.set(
    "originalyear",
    originalDate === undefined ? undefined : Number(originalDate.slice(0, 4)),
  );
  patch.set("releasetype", releaseTypes(release));
  patch.set("releasestatus", release.status?.toLowerCase());
  patch.set("releasecountry", release.country);
  patch.setOrNa("media", medium?.format, "the medium has no declared format");

  const labelInfo = release["label-info"] ?? [];
  const labels = labelInfo.map((info) => info.label?.name ?? "").filter((name) => name !== "");
  const catalogNumbers = labelInfo
    .map((info) => info["catalog-number"] ?? "")
    .filter((value) => value !== "");
  patch.setOrNa("label", labels, "the release carries no label");
  patch.setOrNa("catalognumber", catalogNumbers, "the release has no catalogue number");
  patch.setOrNa("barcode", release.barcode, "the release has no barcode");
  patch.setOrNa(
    "asin",
    release.asin ?? amazonAsin(urlOfType(release.relations, "amazon asin")),
    "the release has no Amazon listing",
  );
  patch.setOrNa("script", release["text-representation"]?.script, "the release declares no script");
  patch.setOrNa(
    "license",
    urlOfType(release.relations, "license"),
    "the release has no licence URL",
  );
  // Not an n/a: §2.2 sources WEBSITE from the *artist*'s url-rels, and a release lookup does
  // not carry them. The field stays missing until the artist is fetched — the source has the
  // fact, we have not asked for it, and that is exactly what "missing" means.
  patch.set("website", urlOfType(release.relations, "official homepage"));

  /* ---- §2.3 release-level credits (art direction, mastering, photography…) ---- */
  addCredits(patch, release.relations, "the release");

  /* ---- §2.4 and §2.5 ---- */
  patch.setOrNa("genre", topGenres(release.genres), "MusicBrainz has no genre on the release");
  patch.setOrNa("mood", moodsFromTags(release), "no mood among the MusicBrainz tags");
  patch.set("musicbrainz_albumid", release.id);
  patch.set("musicbrainz_releasegroupid", releaseGroup?.id);
  patch.na("musicbrainz_originalalbumid", "this release is not a cover or a merge of another one");
  patch.na("musicbrainz_originalartistid", "this release is not a cover of another artist's work");
  patch.na("grouping", "no series or work parent on this release");

  return patch.build();
}

/**
 * What a recording says about itself: its title, its ISRCs, its genres, and the credits its
 * relations carry — including the work it performs, whose own relations bring the composer,
 * the lyricist and the lyrics language.
 */
export function fromMusicBrainzRecording(
  recording: MbRecording,
  options: { fetchedAt: string },
): DocumentPatch {
  const patch = new PatchBuilder("musicbrainz", options.fetchedAt);

  patch.set("title", recording.title);
  patch.setOrNa("subtitle", recording.disambiguation, "the recording has no disambiguation");
  patch.set("musicbrainz_recordingid", recording.id);
  patch.setOrNa("isrc", recording.isrcs, "MusicBrainz knows no ISRC for this recording");
  patch.setOrNa("genre", topGenres(recording.genres), "MusicBrainz has no genre on the recording");
  patch.setOrNa("mood", moodsFromTags(recording), "no mood among the MusicBrainz tags");

  const credit = recording["artist-credit"];
  patch.set("artist", joinArtistCredit(credit));
  patch.set("artists", artistNames(credit));
  patch.set("artistsort", artistSortNames(credit));
  patch.set("musicbrainz_artistid", artistIds(credit));

  addCredits(patch, recording.relations, "the recording");

  const work = performedWork(recording.relations)?.work;
  if (work === undefined) {
    patch.naAll(
      ["work", "musicbrainz_workid", "language", ...CLASSICAL_FIELDS],
      "no work is linked to this recording",
    );
  } else {
    mergeWorkInto(patch, work);
  }

  return patch.build();
}

/**
 * A work looked up on its own. Same output as the work half of `fromMusicBrainzRecording`,
 * for the case where the work is fetched separately (a recording resolved without
 * `work-level-rels`, or a work refreshed alone).
 */
export function fromMusicBrainzWork(work: MbWork, options: { fetchedAt: string }): DocumentPatch {
  const patch = new PatchBuilder("musicbrainz", options.fetchedAt);
  mergeWorkInto(patch, work);
  return patch.build();
}

function mergeWorkInto(patch: PatchBuilder, work: MbWork): void {
  patch.set("work", work.title);
  patch.set("musicbrainz_workid", work.id);
  patch.setOrNa(
    "language",
    work.language ?? work.languages?.[0],
    "MusicBrainz declares no lyrics language for the work",
  );
  addCredits(patch, work.relations, "the work");
  // Movements only exist on classical works, which MusicBrainz models as work parts.
  patch.naAll(CLASSICAL_FIELDS, "the work is not a classical multi-movement piece");
}

/** Every credit field of §2.3, with the MBID field that goes with it. */
const CREDIT_FIELDS = [
  "composer",
  "composersort",
  "lyricist",
  "writer",
  "arranger",
  "conductor",
  "producer",
  "engineer",
  "mixer",
  "remixer",
  "djmixer",
  "director",
  "performer",
  "musicbrainz_composerid",
  "musicbrainz_lyricistid",
  "musicbrainz_producerid",
  "musicbrainz_engineerid",
  "musicbrainz_mixerid",
  "musicbrainz_remixerid",
  "musicbrainz_djmixerid",
  "musicbrainz_conductorid",
  "musicbrainz_arrangerid",
  "musicbrainz_performerid",
] as const;

/**
 * Fold a relation list into the credit fields, keeping MusicBrainz order and dropping
 * duplicates (the same producer credited on both the recording and the release).
 *
 * A role with no relation is marked **n/a**, not missing: a relation list is exhaustive for
 * the entity it belongs to, so "no DJ-mixer relation" means this track has no DJ-mixer, which
 * is §6's "the source says it does not exist". `merge` lifts the n/a again if another entity
 * — the work, the release — does credit that role, so the three calls compose.
 */
function addCredits(
  patch: PatchBuilder,
  relations: readonly MbRelation[] | undefined,
  entity: string,
): void {
  const names = new Map<string, string[]>();
  const sorts = new Map<string, string[]>();
  const mbids = new Map<string, string[]>();
  const performers: PerformerCredit[] = [];

  for (const credit of creditsFromRelations(relations)) {
    if (credit.field === "performer") {
      const role = credit.role ?? "performer";
      if (!performers.some((held) => held.name === credit.name && held.role === role)) {
        performers.push(
          credit.mbid === null
            ? { name: credit.name, role }
            : { name: credit.name, role, mbid: credit.mbid },
        );
      }
      if (credit.mbid !== null) push(mbids, "musicbrainz_performerid", credit.mbid);
      continue;
    }
    push(names, credit.field, credit.name);
    if (credit.field === "composer" && credit.sortName !== null)
      push(sorts, "composersort", credit.sortName);
    const mbidField = mbidFieldFor(credit.field);
    if (mbidField !== undefined && credit.mbid !== null) push(mbids, mbidField, credit.mbid);
  }

  const produced = new Set<string>();
  for (const [name, values] of names) if (patch.set(name, values)) produced.add(name);
  for (const [name, values] of sorts) if (patch.set(name, values)) produced.add(name);
  for (const [name, values] of mbids) if (patch.set(name, values)) produced.add(name);
  if (performers.length > 0 && patch.set("performer", performers)) produced.add("performer");

  for (const name of CREDIT_FIELDS) {
    if (!produced.has(name)) patch.na(name, `no such credit relation on ${entity}`);
  }
}

function push(store: Map<string, string[]>, key: string, value: string): void {
  const held = store.get(key);
  if (held === undefined) store.set(key, [value]);
  else if (!held.includes(value)) held.push(value);
}

/** `RELEASETYPE` is the primary type followed by the secondary ones, lowercased (§2.2). */
function releaseTypes(release: MbRelease): string[] {
  const group = release["release-group"];
  if (group === undefined) return [];
  return [group["primary-type"], ...(group["secondary-types"] ?? [])]
    .filter((type): type is string => type !== undefined && type !== "")
    .map((type) => type.toLowerCase());
}

function moodsFromTags(entity: {
  readonly tags?: readonly { readonly name?: string }[];
}): string[] {
  return (entity.tags ?? [])
    .map((tag) => tag.name ?? "")
    .filter((name) => MOOD_VOCABULARY.has(name.toLowerCase()));
}

/** The ASIN is the last path segment of the Amazon URL MusicBrainz stores as a relation. */
function amazonAsin(url: string | null): string | null {
  if (url === null) return null;
  const match = /\/(?:gp\/product|dp)\/([A-Z0-9]{10})/.exec(url);
  return match?.[1] ?? null;
}
