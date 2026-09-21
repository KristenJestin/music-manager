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
  describeAlias,
  pickAlias,
  translatesAlbums,
  translatesArtists,
  type LocalePreference,
  type MbAlias,
} from "../alias.ts";
import {
  artistAliasVia,
  artistIds,
  artistNames,
  artistSortNames,
  joinArtistCredit,
  topGenres,
  type ArtistNameSource,
  type MbRecording,
  type MbRelation,
  type MbRelease,
  type MbWork,
} from "./musicbrainz-types.ts";
import { PatchBuilder } from "./patch.ts";
import { creditsFromRelations, mbidFieldFor, performedWork, urlOfType } from "./relations.ts";
import { MOOD_VOCABULARY } from "./vocabulary.ts";
import {
  decideWorkTags,
  DEFAULT_WRITE_WORK_TAGS,
  WORK_TAG_FIELDS,
  type ClassicalWorkShape,
  type WriteWorkTags,
} from "../classical.ts";

/** §2.4's movement block: everything `WORK_TAG_FIELDS` holds beyond `WORK` itself. */
const CLASSICAL_FIELDS = WORK_TAG_FIELDS.filter((field) => field !== "work");

/**
 * How the work fields are decided (issue #4): the setting, and what the release is.
 *
 * `classical` is computed by the caller — `resolve` sees the release *and* the work, which is
 * the pair `isClassicalRelease` reads — so the resolvers stay pure functions of their options.
 */
export interface WorkTagOptions {
  /** The `writeWorkTags` setting (D4-03); `classical` when nobody chose. */
  readonly writeWorkTags?: WriteWorkTags | undefined;
  /** Whether `isClassicalRelease` holds for this release. Defaults to `false`. */
  readonly classical?: boolean | undefined;
}

export interface ReleaseResolverOptions {
  /** 1-based medium position; defaults to the first medium. */
  readonly mediumPosition?: number;
  /** 1-based track position on that medium. */
  readonly trackPosition: number;
  /** ISO-8601 instant the response was fetched — becomes every field's `fetchedAt`. */
  readonly fetchedAt: string;
  /** `credit.name` or `credit.artist.name` for ARTIST/ARTISTS. Defaults to `credited`. */
  readonly artistNameSource?: ArtistNameSource;
  /**
   * Picard's “translate names to this locale”. Absent — the default — translates nothing,
   * and every tag below is exactly what it was before the feature existed.
   */
  readonly locale?: LocalePreference;
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
  const names = options.artistNameSource ?? "credited";
  // Two switches, so the preference is split at the top rather than tested at six call sites.
  const artistLocale = translatesArtists(options.locale) ? options.locale : undefined;
  const albumLocale = translatesAlbums(options.locale) ? options.locale : undefined;

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
  /*
   * The album title, translated when the locale asks for it: the release *group*'s aliases
   * first — the album as a work, which is where a translated title belongs — then the
   * pressing's own. `ALBUMSORT` normally has nothing to hold, because MusicBrainz files no
   * sort title for releases; when the title has been translated it holds the original, which
   * is the one thing that must not be lost (§1: the document keeps the provenance *and* the
   * original).
   */
  const albumAlias =
    pickAlias(releaseGroup?.aliases, aliasQuery(albumLocale, release.title)) ??
    pickAlias(release.aliases, aliasQuery(albumLocale, release.title));
  patch.set("album", albumAlias?.name ?? release.title, {
    via: albumAlias === null ? null : describeAlias(albumAlias),
  });
  if (albumAlias === null || release.title === undefined || release.title === "") {
    patch.na("albumsort", "MusicBrainz has no sort title for releases");
  } else {
    patch.set("albumsort", release.title, { via: describeAlias(albumAlias) });
  }

  const albumArtistCredit = release["artist-credit"];
  const albumArtistVia = artistAliasVia(albumArtistCredit, names, artistLocale);
  patch.set("albumartist", joinArtistCredit(albumArtistCredit, names, artistLocale), {
    via: albumArtistVia,
  });
  patch.set("albumartists", artistNames(albumArtistCredit, names, artistLocale), {
    via: albumArtistVia,
  });
  // Untouched by the locale on purpose: MusicBrainz's `sort-name` already holds the original
  // name in sortable form (`梶浦由記` sorts as `Kajiura, Yuki`), which is exactly where §1
  // wants the original kept when the displayed name has been translated.
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
    const trackArtistVia = artistAliasVia(trackCredit, names, artistLocale);
    patch.set("artist", joinArtistCredit(trackCredit, names, artistLocale), {
      via: trackArtistVia,
    });
    patch.set("artists", artistNames(trackCredit, names, artistLocale), { via: trackArtistVia });
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

  // Always the canonical name: "Various Artists" is a database fact, not a printed credit.
  const isCompilation = artistNames(albumArtistCredit, "canonical").includes("Various Artists");
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

/** The `pickAlias` query for a release-side name, or one that matches nothing when off. */
function aliasQuery(
  locale: LocalePreference | undefined,
  credited: string | undefined,
): { locale: string; onlyNonLatin: boolean; kind: "release"; credited?: string } {
  return {
    locale: locale?.locale ?? "",
    onlyNonLatin: locale?.onlyNonLatin ?? true,
    kind: "release",
    ...(credited === undefined ? {} : { credited }),
  };
}

/**
 * Which of a release group's pseudo-releases is the transliteration of the one we matched.
 *
 * Pure, so the choice is a test rather than a hope, and **totally ordered**, so two rebuilds
 * from the same cache pick the same one (§8):
 *
 *  1. a Latin `text-representation.script` first — that is the whole point of the exercise;
 *  2. the same track count on every medium as the chosen release — a pseudo-release with a
 *     different tracklist is a different edition, and pairing by position would then write
 *     track 7's title onto track 7 of something else;
 *  3. the oldest date, then the MBID — the two remaining tie-breaks, in that order.
 *
 * Returns `null` when nothing qualifies, which is the ordinary case and is silent by design.
 */
export function choosePseudoRelease(
  candidates: readonly MbRelease[],
  chosen: MbRelease,
): MbRelease | null {
  const shape = trackShape(chosen);
  const usable = candidates.filter(
    (candidate) =>
      candidate.id !== undefined &&
      candidate.id !== "" &&
      candidate.id !== chosen.id &&
      sameShape(trackShape(candidate), shape),
  );

  const ranked = [...usable].sort((a, b) => {
    const latin = latinRank(a) - latinRank(b);
    if (latin !== 0) return latin;
    const date = (a.date ?? "9999").localeCompare(b.date ?? "9999");
    if (date !== 0) return date;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  const best = ranked[0];
  if (best === undefined) return null;
  return latinRank(best) === 0 ? best : null;
}

function latinRank(release: MbRelease): number {
  return release["text-representation"]?.script === "Latn" ? 0 : 1;
}

/** The track count of each medium, in medium order — the fingerprint of a tracklist. */
function trackShape(release: MbRelease): readonly number[] {
  return [...(release.media ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((medium) => medium["track-count"] ?? medium.tracks?.length ?? 0);
}

function sameShape(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((count, index) => count === b[index]);
}

export interface PseudoReleaseOptions {
  /** 1-based medium position on the **chosen** release; matched by position on the pseudo. */
  readonly mediumPosition?: number;
  readonly trackPosition: number;
  readonly fetchedAt: string;
}

/**
 * The transliterated titles of a **pseudo-release**, on top of the real release's patch.
 *
 * MusicBrainz models a romanised edition of a Japanese album as a separate release with
 * `status: Pseudo-Release` inside the same release group. It is not a pressing anybody owns,
 * which is why the matcher filters it out (`status:Official` in `matching/lucene.ts`), and it
 * is the only place a *track* title exists in Latin script: recording aliases carry no locale,
 * so there is nothing else to read.
 *
 * This resolver produces four fields and nothing else — the pseudo-release is a spelling of
 * the album we already matched, not a second opinion about its label, its barcode or its
 * credits. `ALBUMSORT` and `TITLESORT` keep the originals, so the document holds both names
 * exactly as §1 asks.
 *
 * Tracks are paired by **position**, medium by medium: a pseudo-release with a different
 * tracklist is not this album transliterated, and the caller checks the track counts before
 * ever getting here.
 */
export function fromMusicBrainzPseudoRelease(
  pseudo: MbRelease,
  original: { readonly album?: string | undefined; readonly title?: string | undefined },
  options: PseudoReleaseOptions,
): DocumentPatch {
  const patch = new PatchBuilder("musicbrainz", options.fetchedAt);
  const via = `pseudo-release ${pseudo.id ?? "?"}`;

  if (patch.set("album", pseudo.title, { via }) && original.album !== undefined) {
    patch.set("albumsort", original.album, { via });
  }

  const media = pseudo.media ?? [];
  const medium =
    options.mediumPosition === undefined
      ? media[0]
      : media.find((candidate) => candidate.position === options.mediumPosition);
  const track = (medium?.tracks ?? []).find(
    (candidate) => candidate.position === options.trackPosition,
  );
  const title = track?.title ?? track?.recording?.title;
  if (patch.set("title", title, { via }) && original.title !== undefined) {
    patch.set("titlesort", original.title, { via });
  }

  return patch.build();
}

/**
 * D9-01 — **the release owns the tracklist; a recording is a fallback for it.**
 *
 * A release's track and its recording are two answers to the same question, and MusicBrainz
 * keeps both: the tracklist of the edition we matched (what the sleeve prints, in the
 * edition's script — the worldwide *Suzume* titles track 1 "The First Encounter") and the
 * recording's own title (the canonical Japanese, 二人の出逢い). Picard writes the track's, and
 * so do we — but both patches are `musicbrainz`, so `merge` settles them on confidence, and
 * by default the two were equal: whichever patch happened to be pushed last won, and that was
 * the recording.
 *
 * The whole fix is this number: the release's track credit keeps 1, the recording's falls to
 * 0.9. Three consequences, all of them wanted — with both present the release wins, a
 * standalone recording (no release, so nothing is held against it) still writes its own
 * title and credits, and the pseudo-release, which is pushed last at confidence 1, still wins
 * over both.
 *
 * Lowering this patch rather than teaching `wins()` about releases is deliberate: the
 * pseudo-release path *relies* on "same source, same confidence, the later patch wins", and a
 * precedence rule between two patches of one source would take that away.
 */
const TRACKLIST_FALLBACK_CONFIDENCE = 0.9;

/**
 * What a recording says about itself: its title, its ISRCs, its genres, and the credits its
 * relations carry — including the work it performs, whose own relations bring the composer,
 * the lyricist and the lyrics language.
 *
 * The five tracklist fields (`title`, `artist`, `artists`, `artistsort`,
 * `musicbrainz_artistid`) are written at `TRACKLIST_FALLBACK_CONFIDENCE`, not at 1: the
 * matched release states them for this very track, and MusicBrainz's own documentation calls
 * the recording's value the fallback. Everything else here — ISRCs, genres, moods, the work —
 * exists only on the recording and stays at full confidence.
 */
export function fromMusicBrainzRecording(
  recording: MbRecording,
  options: {
    fetchedAt: string;
    artistNameSource?: ArtistNameSource;
    locale?: LocalePreference;
  } & WorkTagOptions,
): DocumentPatch {
  const patch = new PatchBuilder("musicbrainz", options.fetchedAt);
  const names = options.artistNameSource ?? "credited";
  const locale = translatesArtists(options.locale) ? options.locale : undefined;
  const fallback = { confidence: TRACKLIST_FALLBACK_CONFIDENCE };

  patch.set("title", recording.title, fallback);
  patch.setOrNa("subtitle", recording.disambiguation, "the recording has no disambiguation");
  patch.set("musicbrainz_recordingid", recording.id);
  patch.setOrNa("isrc", recording.isrcs, "MusicBrainz knows no ISRC for this recording");
  patch.setOrNa("genre", topGenres(recording.genres), "MusicBrainz has no genre on the recording");
  patch.setOrNa("mood", moodsFromTags(recording), "no mood among the MusicBrainz tags");

  const credit = recording["artist-credit"];
  const via = artistAliasVia(credit, names, locale);
  patch.set("artist", joinArtistCredit(credit, names, locale), { ...fallback, via });
  patch.set("artists", artistNames(credit, names, locale), { ...fallback, via });
  patch.set("artistsort", artistSortNames(credit), fallback);
  patch.set("musicbrainz_artistid", artistIds(credit), fallback);

  addCredits(patch, recording.relations, "the recording");

  const work = performedWork(recording.relations)?.work;
  if (work === undefined) {
    patch.naAll(
      ["work", "musicbrainz_workid", "language", ...CLASSICAL_FIELDS],
      "no work is linked to this recording",
    );
  } else {
    mergeWorkInto(patch, work, options);
  }

  return patch.build();
}

/**
 * A work looked up on its own. Same output as the work half of `fromMusicBrainzRecording`,
 * for the case where the work is fetched separately (a recording resolved without
 * `work-level-rels`, or a work refreshed alone).
 */
export function fromMusicBrainzWork(
  work: MbWork,
  options: { fetchedAt: string } & WorkTagOptions,
): DocumentPatch {
  const patch = new PatchBuilder("musicbrainz", options.fetchedAt);
  mergeWorkInto(patch, work, options);
  return patch.build();
}

export interface ArtistResolverOptions {
  readonly fetchedAt: string;
}

/**
 * An artist looked up on its own (`inc=url-rels`).
 *
 * It exists for one field the release lookup structurally cannot give: §2.2 sources
 * `WEBSITE` from the **artist's** url-rels, and a release response carries the release's. The
 * release resolver therefore leaves `website` *missing* rather than n/a, and this resolver is
 * what fills it once the artist has actually been asked.
 *
 * It deliberately produces **only** that field. The artist credits already come from the
 * release and the recording, where they carry join phrases and credited names; re-deriving
 * them here from a single artist entity would win the merge on tie-breaking order and quietly
 * replace "Daft Punk feat. Romanthony" with "Daft Punk".
 */
export function fromMusicBrainzArtist(
  artist: MbArtistLike,
  options: ArtistResolverOptions,
): DocumentPatch {
  const patch = new PatchBuilder("musicbrainz", options.fetchedAt);
  patch.setOrNa(
    "website",
    urlOfType(artist.relations, "official homepage"),
    "the artist has no official homepage in MusicBrainz",
  );
  return patch.build();
}

/** `inc=url-rels` adds relations to an artist; the shared type does not declare them. */
export interface MbArtistLike {
  readonly id?: string;
  readonly name?: string;
  readonly "sort-name"?: string;
  readonly country?: string;
  readonly relations?: readonly MbRelation[];
  readonly genres?: readonly { readonly name?: string; readonly count?: number }[];
  readonly tags?: readonly { readonly name?: string; readonly count?: number }[];
  /** `artistFull` asks for `aliases`; this is where the locale names of §2.1 come from. */
  readonly aliases?: readonly MbAlias[];
}

/**
 * What `isClassicalRelease` reads of a release: the genres and the tags of its group, then
 * the release's own (`releaseFull` asks for `release-groups` + `genres`, so both are in hand).
 */
export function releaseGenreNames(release: MbRelease | undefined): string[] {
  const group = release?.["release-group"];
  return [
    ...(group?.genres ?? []),
    ...(group?.tags ?? []),
    ...(release?.genres ?? []),
    ...(release?.tags ?? []),
  ]
    .map((name) => name.name ?? "")
    .filter((name) => name !== "");
}

/** What `isClassicalRelease` reads of a work: its title, its composer credit, its movements. */
export function classicalShapeOf(work: MbWork | undefined): ClassicalWorkShape | undefined {
  if (work === undefined) return undefined;
  return {
    title: work.title,
    composer: (work.relations ?? []).some((relation) => relation.type === "composer"),
    movements: movementCount(work),
  };
}

/**
 * MusicBrainz models a classical work's movements as works linked by `parts` / `part of`.
 *
 * `workFull` does not ask for `work-rels`, so the count is 0 on the ordinary path and the
 * release group's genres are what decides; it is read here for the payloads that do carry it.
 */
function movementCount(work: MbWork): number {
  return (work.relations ?? []).filter(
    (relation) =>
      relation["target-type"] === "work" &&
      (relation.type === "parts" || relation.type === "part of"),
  ).length;
}

/**
 * Fold a work into the document — or say why its display fields are not written (issue #4).
 *
 * `WORK` is not an identifier: a player groups the tracks of an album by it. Writing it on a
 * pop release duplicates each title in a header, which is why `writeWorkTags` exists; the work
 * *id* is written either way, so a release whose work fields were switched off can still be
 * recognised after the fact.
 */
function mergeWorkInto(patch: PatchBuilder, work: MbWork, options: WorkTagOptions): void {
  const decision = decideWorkTags(
    options.writeWorkTags ?? DEFAULT_WRITE_WORK_TAGS,
    options.classical ?? false,
  );

  patch.set("musicbrainz_workid", work.id);

  if (decision.write) {
    patch.set("work", work.title);
    // Movements only exist on classical works, which MusicBrainz models as work parts.
    patch.naAll(CLASSICAL_FIELDS, "the work is not a classical multi-movement piece");
  } else {
    // D4-02: n/a with the reason, never missing — `verify` and the completeness score read
    // the difference between "we have no such tag" and "the source does not have it".
    patch.naAll(WORK_TAG_FIELDS, decision.reason ?? "not a classical release");
  }

  patch.setOrNa(
    "language",
    work.language ?? work.languages?.[0],
    "MusicBrainz declares no lyrics language for the work",
  );
  addCredits(patch, work.relations, "the work");
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
    .filter((type): type is string => typeof type === "string" && type !== "")
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
