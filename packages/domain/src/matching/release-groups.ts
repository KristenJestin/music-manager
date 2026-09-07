/**
 * The first level of the two-level search (`docs/04-pipeline-et-matching.md` § Algorithme,
 * decision 151): the **release group** — the album as a work, before it is a pressing.
 *
 * The version this replaces asked MusicBrainz for release groups, kept the single best one,
 * and then searched releases inside it. That is one hypothesis, tested against itself. It is
 * also the whole of the owner's D3: "Bad Ideas" is a 2019 album of eleven tracks *and* a 2020
 * single of one, the group search preferred the single, and the album — the actual record the
 * playlist came from — was never a candidate. One card, "2 searches and 1 lookup", 94 %.
 *
 * So there are two functions here and they are deliberately different in kind:
 *
 *  - `searchScore` ranks groups on what a *search result* carries — a title, an artist credit,
 *    a primary type, secondary types. It decides which groups are worth spending a release
 *    search on, and nothing else. It is cheap, it is shallow, and it knows it.
 *  - `group` takes releases that have already been scored by `release-candidates.ts` — with a
 *    real tracklist fit for the ones that got a lookup — and folds them back into their groups.
 *    A group is then worth its best release, because that is what selecting it would import.
 *
 * Pure, like everything else in this directory: the searching itself lives in
 * `apps/web/src/server/services/matching.service.ts`.
 */

import { artistScore, round3, titleScore, unit, yearOf } from "./signals.ts";
import type {
  AlbumHints,
  ReleaseCandidate,
  ReleaseGroupCandidate,
  ReleaseGroupRanking,
} from "./types.ts";
import type { MbReleaseGroup } from "../metadata/resolvers/musicbrainz-types.ts";

/* ------------------------------------------------------------------ */
/* level one: which groups deserve a search                            */
/* ------------------------------------------------------------------ */

/**
 * How much a group's *primary type* looks like the thing a playlist of N videos came from.
 *
 * Not a veto, a lean. A record filed as an EP is still the record the playlist came from —
 * v1's comment "Do NOT filter by primarytype initially for broader search" is why the query
 * carries no type clause at all — but when eleven videos are on the table, an `Album` is a
 * better hypothesis than a `Single`, and the engine is allowed to say so *before* it has spent
 * a lookup finding out. With one video the lean reverses, gently.
 */
export function primaryTypeScore(primary: string | null | undefined, videoCount: number): number {
  const type = (primary ?? "").trim().toLowerCase();
  const many = videoCount >= 4;
  if (type === "") return 0.6;
  if (type === "album") return many ? 1 : 0.7;
  if (type === "ep") return many ? 0.85 : 0.8;
  if (type === "single") return many ? 0.35 : 1;
  if (type === "broadcast" || type === "other") return 0.4;
  return 0.5;
}

/** Secondary types a playlist rip is unlikely to be, as a multiplier rather than a penalty. */
export function secondaryTypeScore(secondary: readonly string[] | undefined): number {
  let score = 1;
  for (const type of secondary ?? []) {
    const value = type.trim().toLowerCase();
    if (value === "compilation") score -= 0.25;
    else if (value === "live") score -= 0.3;
    else if (value === "remix") score -= 0.25;
    else if (value === "soundtrack") score -= 0.15;
    else if (value === "dj-mix" || value === "mixtape/street") score -= 0.2;
    else score -= 0.05;
  }
  return unit(score);
}

export interface GroupSearchScore {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly primaryType: string | null;
  readonly secondaryTypes: readonly string[];
  readonly firstReleaseDate: string | null;
  readonly score: number;
  readonly why: readonly string[];
}

/**
 * Score the groups a `release-group` search returned, best first.
 *
 * Title and artist carry the weight, because they are the only hard evidence a group document
 * has; the type lean is a third of it, and it is what puts the eleven-track album ahead of the
 * one-track single of the same name *before* either has cost a lookup.
 */
export function searchScore(
  groups: readonly MbReleaseGroup[],
  hints: AlbumHints,
  videoCount: number,
): GroupSearchScore[] {
  const album = (hints.album ?? "").trim();
  const artist = (hints.artist ?? "").trim();

  const scored: GroupSearchScore[] = [];
  for (const group of groups) {
    if (group.id === undefined || group.id === "") continue;
    const credited = (group as { "artist-credit"?: readonly { name?: string }[] })["artist-credit"];
    const artistName = (credited ?? [])
      .map((entry) => entry.name ?? "")
      .join(" ")
      .trim();

    const title = album === "" ? 0.5 : titleScore(album, group.title ?? "");
    const credit = artist === "" ? 0.5 : artistScore([artist], artistName);
    const primary = primaryTypeScore(group["primary-type"], videoCount);
    const secondary = secondaryTypeScore(group["secondary-types"]);

    const why: string[] = [];
    if (title >= 0.99) why.push("Title matches exactly");
    else if (title < 0.5) why.push("Title does not match");
    if (credit >= 0.99) why.push("Artist matches exactly");
    else if (credit < 0.5) why.push("Artist mismatch");
    if (group["primary-type"] != null && group["primary-type"] !== "") {
      why.push(
        `Filed as a ${group["primary-type"]}${
          primary < 0.5 ? `, which is a poor shape for ${String(videoCount)} videos` : ""
        }`,
      );
    }
    for (const type of group["secondary-types"] ?? []) why.push(`Secondary type ${type}`);

    scored.push({
      id: group.id,
      title: group.title ?? "",
      artist: artistName,
      primaryType: group["primary-type"] ?? null,
      secondaryTypes: [...(group["secondary-types"] ?? [])],
      firstReleaseDate: group["first-release-date"] ?? null,
      score: round3(unit((title * 0.36 + credit * 0.34 + primary * 0.2) * (0.7 + 0.3 * secondary))),
      why,
    });
  }

  return scored.sort(
    (a, b) =>
      b.score - a.score || (a.firstReleaseDate ?? "").localeCompare(b.firstReleaseDate ?? ""),
  );
}

/* ------------------------------------------------------------------ */
/* level two: the groups, once their releases have been scored         */
/* ------------------------------------------------------------------ */

/** Everything we learned about a group from the search, keyed by MBID. */
export type GroupIndex = ReadonlyMap<string, GroupSearchScore>;

/**
 * Fold scored releases back into their release groups, best group first.
 *
 * A release with no group (MusicBrainz does have a few, and a hand-pasted MBID looked up in
 * isolation can arrive without one) lands in a single `id: null` bucket rather than being
 * dropped: step 2 must be able to show every card the ranking holds.
 *
 * The group's own score is the score of its best release. Two consequences, both wanted: the
 * order of the groups and the order of the flat list agree, so the preselected release is
 * always inside the preselected group; and a group nobody looked up cannot outrank one that
 * was examined, because that property is already true of the releases inside them.
 */
export function group(
  candidates: readonly ReleaseCandidate[],
  index: GroupIndex = new Map(),
): ReleaseGroupRanking {
  const buckets = new Map<string, ReleaseCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.releaseGroupId ?? "";
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const groups: ReleaseGroupCandidate[] = [];
  for (const [key, bucket] of buckets) {
    const releases = [...bucket].sort(
      (a, b) =>
        Number(b.detailed) - Number(a.detailed) ||
        b.score - a.score ||
        b.fit - a.fit ||
        a.id.localeCompare(b.id),
    );
    const best = releases[0];
    if (best === undefined) continue;
    const known = key === "" ? undefined : index.get(key);
    const detailedCount = releases.filter((release) => release.detailed).length;

    const why: string[] = [];
    if (known !== undefined) why.push(...known.why);
    why.push(
      `${String(releases.length)} release${releases.length === 1 ? "" : "s"} in this group, ` +
        `${String(detailedCount)} with a tracklist read`,
    );
    if (best.detailed) {
      why.push(
        `Best pressing: ${best.title}${best.year === null ? "" : ` (${String(best.year)})`}, ` +
          `${String(best.tracks)} tracks, fit ${String(best.fit)}/${String(best.fitOf)}`,
      );
    }

    groups.push({
      id: key === "" ? null : key,
      title: known?.title ?? best.title,
      artist: known?.artist ?? best.artist,
      primaryType: known?.primaryType ?? best.type,
      secondaryTypes: known?.secondaryTypes ?? best.secondary,
      firstReleaseDate: known?.firstReleaseDate ?? best.date,
      year: yearOf(known?.firstReleaseDate ?? best.date),
      score: best.score,
      searchScore: known?.score ?? best.score,
      releases,
      detailedCount,
      preselected: false,
      why,
    });
  }

  const ranked = groups.sort(
    (a, b) =>
      b.detailedCount - a.detailedCount ||
      b.score - a.score ||
      (a.id ?? "").localeCompare(b.id ?? ""),
  );
  const withFlag = ranked.map((entry, position) => ({ ...entry, preselected: position === 0 }));
  const first = withFlag[0];
  const second = withFlag[1];

  return {
    groups: withFlag,
    preselected: first ?? null,
    margin: first === undefined || second === undefined ? null : round3(first.score - second.score),
  };
}
