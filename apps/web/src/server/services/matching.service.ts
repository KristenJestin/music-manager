/**
 * The matching service: turn a resolved import into scored MusicBrainz candidates
 * (`docs/04-pipeline-et-matching.md` § Algorithme de présélection).
 *
 * The pure engine lives in `@mm/domain/matching` and knows nothing about the network. This
 * module is the half that does: it decides **which** MusicBrainz documents are worth fetching,
 * in what order, and how many. That decision is the whole cost of a match, so it is bounded
 * and counted rather than left to grow with the size of the answer:
 *
 *  - **a ladder of release-group searches, then one per group kept** (`matchGroupLimit`,
 *    default 3). Every rung carries the artist, and that is the rule the sixth owner review
 *    turned into a hard one: the rung that dropped it — `releasegroup:"Bewitched"` on its own —
 *    returned a hundred and forty-two homonyms and is why Laura Fygi's 1993 record was imported
 *    for a Laufey playlist. The ladder is `first credited artist` → `whole credit` →
 *    `base title` (the edition qualifier stripped) → **the recordings**, and it stops at the
 *    first rung with an answer. See `findReleaseGroups`.
 *  - **lookups by branch and bound, under a ceiling** (`matchLookupLimit`, default 14). The
 *    tracklist fit is the signal that separates two pressings of one album, and it needs the
 *    actual tracklist, which the search results do not carry. The old plan spent a flat six
 *    from the top of the pre-score, and *Appeal to Reason*'s fourteen-track edition ranked
 *    twelfth: a number decided, on its own, whether the right album was ever examined. What
 *    replaces it opens candidates while an unopened one's `ceiling` — the best it could still
 *    reach — is strictly above the best complete score, and stops early only on a leader that
 *    is `safe`, unambiguous **and exact**. The **first** lookup of each kept group is still
 *    reserved: a group cannot be compared on a fit nobody read.
 *
 * Both halves of that budget are returned in `budget`, which is what the test asserts on —
 * a promise about request counts that nothing measures is not a promise.
 *
 * Every call goes through P04's `integrations/musicbrainz.ts`, hence through the one-request-
 * per-second limiter and the raw cache. In fixtures mode the context is `offline`, the cache
 * has been seeded from the cassettes, and a request that tried to leave would throw.
 */
import {
  artistLadder,
  creditCarriesArtist,
  editionTokensIn,
  DEFAULT_GROUP_LIMIT,
  DEFAULT_LOOKUP_LIMIT,
  DEFAULT_RECORDING_LOOKUP_LIMIT,
  flattenTracks,
  lucene,
  mapping as mappingEngine,
  primaryArtist,
  recordingCandidates,
  releaseCandidates,
  releaseGroups,
  stripArtistPrefix,
  stripEditionQualifier,
  stripEditionQualifierLoosely,
  titleScore,
  type AlbumHints,
  type DeepPartialConfig,
  type GroupSearchScore,
  type MappingResult,
  type MatchVideo,
  type MbRecording,
  type MbRelease,
  type MbReleaseGroup,
  type RecordingCandidate,
  type RecordingCandidateInput,
  type RecordingRanking,
  type ReleaseCandidate,
  type ReleaseCandidateInput,
  type ReleaseGroupRanking,
  type ReleaseRanking,
} from "@mm/domain";
import type { MbSearchResult } from "#/server/integrations/musicbrainz.ts";
import type { Settings } from "#/server/services/settings.ts";
import type { MbGateway } from "#/server/services/matching.gateway.ts";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * The engine configuration, assembled from the settings.
 *
 * The weights are settings too (`matchWeights*`), so a library that keeps disagreeing with the
 * defaults can be corrected without a release — which is the point of `docs/04` calling them
 * "poids et seuils en paramètres".
 */
export function configFromSettings(settings: Settings): DeepPartialConfig {
  return {
    weights: {
      release: settings.matchReleaseWeights,
      recording: settings.matchRecordingWeights,
      mapping: settings.matchMappingWeights,
    },
    thresholds: {
      safe: settings.safeThreshold,
      ambiguityMargin: settings.matchAmbiguityMargin,
      bindingFloor: settings.matchBindingFloor,
      durationToleranceSeconds: settings.matchDurationTolerance,
      titleMatch: settings.titleMatchThreshold,
      coveragePenalty: settings.matchCoveragePenalty,
    },
    preferences: {
      countries: settings.preferredCountries,
      format: settings.preferredFormat,
      explicit: settings.explicitPreference,
      artistVeto: settings.matchArtistVeto,
    },
  };
}

/**
 * The **ceiling** on tracklist lookups for one album match, not the number it will spend.
 *
 * Since the sixth owner review this is a bound on a branch and bound, and the ordinary album
 * comes nowhere near it: see `exploreReleases`, and `DEFAULT_LOOKUP_LIMIT` in the engine for
 * why the default rose from six to fourteen when it stopped being a plan.
 */
export function lookupLimitOf(settings: Settings): number {
  return settings.matchLookupLimit > 0 ? settings.matchLookupLimit : DEFAULT_LOOKUP_LIMIT;
}

/**
 * How many recordings get a lookup on the **single** path.
 *
 * Capped apart from the album ceiling and never above it: a recording lookup buys the borrow
 * ladder, there is no bound to stop early on, and every one of them is spent. Lowering
 * `matchLookupLimit` still lowers this; raising it to reach a buried pressing does not make a
 * lone video cost fourteen seconds.
 */
export function recordingLookupLimitOf(settings: Settings): number {
  return Math.min(lookupLimitOf(settings), DEFAULT_RECORDING_LOOKUP_LIMIT);
}

/**
 * What the **bare** rung proves about the edition, once MusicBrainz has answered it.
 *
 * `sourceEdition` deliberately refuses to read a trailing edition word that carries no bracket
 * and no separator, because *Hotel Deluxe* is a record and stripping its last word would be
 * reading an announcement into a name. That refusal is right, and it left *AFTERCARE DELUXE*
 * in a worse place than not finding it at all: the ladder's bare rung finds the group, and the
 * scorer then marks the twenty-one-track deluxe pressing — the record the playlist *is* — down
 * for carrying a qualifier "nobody asked for", so the fifteen-track standard album won and six
 * of the twenty-one videos had nowhere to go.
 *
 * What resolves it is not a better guess, it is **evidence**. MusicBrainz answering
 * `releasegroup:"AFTERCARE"` while answering nothing at all for `releasegroup:"AFTERCARE
 * DELUXE"` is the index stating that "DELUXE" is not part of the record's name — which is
 * exactly what `sourceEdition` could not know from the string alone. So the announcement is
 * read only from the rung that was climbed, and only once it has come back with something.
 * *Hotel Deluxe* never reaches this code, because the rung above it answers.
 */
function editionProvenByFallback(hints: AlbumHints, fallback: MatchFallback | null): AlbumHints {
  if (fallback === null || fallback.kind !== "bare-title") return hints;
  const removed = fallback.from.slice(fallback.to.length);
  const announced = editionTokensIn(removed).filter(
    (token) => !(hints.edition ?? []).includes(token),
  );
  if (announced.length === 0) return hints;
  return { ...hints, edition: [...(hints.edition ?? []), ...announced] };
}

/** How many release groups get a release search of their own (decision 151). */
export function groupLimitOf(settings: Settings): number {
  return settings.matchGroupLimit > 0 ? settings.matchGroupLimit : DEFAULT_GROUP_LIMIT;
}

/**
 * How many names of a composite credit ever become a rung of their own.
 *
 * Four, and it is a budget number rather than a statistical one. Every rung is a second
 * through the MusicBrainz gate, and it is only ever spent on an album *nothing above it could
 * find*, so the ordinary import never pays any of it. But a YouTube credit can list eight
 * session musicians, and eight hypotheses are not worth eight seconds when the honest answer
 * after four of them is "hand this to a person". Four covers the shape this actually takes —
 * an artist, a producer, and one or two collaborators — which is what the *Stardew Valley*
 * credit is: the name MusicBrainz files the record under is the third of three.
 */
export const CREDIT_LADDER_LIMIT = 4;

/**
 * The budget an album match is allowed to spend, before it spends any of it.
 *
 * Read by the progress screen, so the person waiting eight seconds is told what the eight
 * seconds are for. It is a *ceiling*: a match that finds one release group spends two searches
 * of the four, and says so when it revises the plan.
 */
export function plannedBudgetOf(settings: Settings): MatchBudget {
  return { searches: 1 + groupLimitOf(settings), lookups: lookupLimitOf(settings) };
}

/* ------------------------------------------------------------------ */
/* results                                                             */
/* ------------------------------------------------------------------ */

/** What one match cost, in MusicBrainz documents. Asserted by `matching.budget.test.ts`. */
export interface MatchBudget {
  readonly searches: number;
  readonly lookups: number;
}

/** Whether the ranking contains anything actually credited to the artist the source names. */
export interface ArtistVerdict {
  /** The credit the source carries, or `null` when it names nobody. */
  readonly wanted: string | null;
  /** True when at least one candidate carries it — or when there was nothing to carry. */
  readonly carried: boolean;
  readonly carriedBy: number;
}

export interface AlbumMatch {
  readonly kind: "album";
  readonly ranking: ReleaseRanking;
  /** The same candidates, folded back into their release groups — what step 2 draws. */
  readonly groups: ReleaseGroupRanking;
  /** The proposed 1:1 mapping against the preselected release. */
  readonly mapping: MappingResult | null;
  /** The preselected release, fully looked up. */
  readonly release: MbRelease | null;
  readonly budget: MatchBudget;
  /** The ceiling this match was allowed, so a screen can show spent against planned. */
  readonly planned: MatchBudget;
  readonly queries: readonly string[];
  /** Which rung of the search ladder answered, when it was not the first. */
  readonly fallback: MatchFallback | null;
  /** The artist gate: `carried: false` means nothing here is by the artist the source names. */
  readonly artist: ArtistVerdict;
  /** Why the adaptive exploration stopped. */
  readonly stoppedBecause: Exploration["stoppedBecause"];
}

export interface SingleMatch {
  readonly kind: "single";
  readonly ranking: RecordingRanking;
  readonly budget: MatchBudget;
  readonly planned: MatchBudget;
  readonly queries: readonly string[];
  /** The same gate as the album path: nothing here is by the artist the video names. */
  readonly artist: ArtistVerdict;
}

/* ------------------------------------------------------------------ */
/* album                                                               */
/* ------------------------------------------------------------------ */

export interface AlbumMatchInput {
  readonly videos: readonly MatchVideo[];
  readonly hints: AlbumHints;
}

function releasesOf(result: MbSearchResult | null): readonly MbRelease[] {
  return result?.releases ?? [];
}

/**
 * Which rung of the search ladder produced the candidates, when it was not the first.
 *
 * Carried out of the match and written to the import's journal, because a fallback that only
 * shows up as "it worked this time" is a fallback nobody can audit: the person reading a
 * questionable import has to be able to see that MusicBrainz was asked a different question
 * from the one the playlist's title implies.
 */
export type MatchFallback =
  | { readonly kind: "primary-artist"; readonly from: string; readonly to: string }
  | { readonly kind: "credited-artist"; readonly from: string; readonly to: string }
  | { readonly kind: "base-title"; readonly from: string; readonly to: string }
  | { readonly kind: "bare-title"; readonly from: string; readonly to: string }
  | {
      readonly kind: "recordings";
      readonly sampled: number;
      readonly titles: readonly string[];
      readonly groups: readonly string[];
    };

/** One line of English per fallback, for `ctx.say` and for the wizard. */
export function describeFallback(fallback: MatchFallback): string {
  switch (fallback.kind) {
    case "primary-artist":
      return `The credit “${fallback.from}” names more than one artist, so MusicBrainz was asked for the first of them, “${fallback.to}” — a composite credit is almost never one it publishes.`;
    case "credited-artist":
      return `Neither “${fallback.from}” nor the first name in it matched anything, so MusicBrainz was asked for another name the source credits, “${fallback.to}” — a collaboration is filed under one of its collaborators and there is no rule saying which.`;
    case "base-title":
      return `The search came back empty for “${fallback.from}”, so it fell back to the base title, “${fallback.to}” — the edition qualifier was treated as noise.`;
    case "bare-title":
      return `Nothing matched “${fallback.from}”, so the trailing edition word was treated as noise too and the search asked for “${fallback.to}”, still by the same artist.`;
    case "recordings":
      return (
        `The album search came back empty, so ${String(fallback.sampled)} track${fallback.sampled === 1 ? "" : "s"} ` +
        `(${fallback.titles.join(", ")}) were searched as recordings; they converge on ` +
        `${String(fallback.groups.length)} release group${fallback.groups.length === 1 ? "" : "s"}.`
      );
  }
}

/**
 * How many tracks the recording fallback searches before it gives up on converging.
 *
 * Four, and the number is a budget decision as much as a statistical one. Each one is a search
 * through the one-request-per-second gate, so fourteen tracks would be fourteen seconds spent
 * on a question three of them already answer: a release group named by **two** independent
 * tracks of the same playlist, by the same artist, at the same lengths, is not a coincidence
 * any homonym produces. Four samples leave room for two of them to find nothing at all — a
 * track MusicBrainz spells differently, a duration YouTube rounds the other way — and still
 * reach the two agreeing votes the convergence asks for.
 */
const CONVERGENCE_SAMPLE = 4;

/** How many of the sampled tracks must name a release group before it is believed. */
const CONVERGENCE_VOTES = 2;

/**
 * Which videos to send through the recording fallback.
 *
 * The **longest** ones, tie broken by their position in the listing. A ninety-second interlude
 * called "Prelude" names half of MusicBrainz; a four-minute song called "Wishful Drinking"
 * names one record. Length is the cheapest available proxy for "this title is a real song",
 * and the duration window of the query itself is a second discriminator that a short track
 * would not survive either.
 */
function convergenceSample(videos: readonly MatchVideo[]): MatchVideo[] {
  const usable = videos.filter((video) => (video.ytTrack ?? video.title).trim() !== "");
  return [...usable]
    .sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0) || a.index - b.index)
    .slice(0, CONVERGENCE_SAMPLE);
}

/**
 * The last rung: find the album through its **tracks** rather than through its name.
 *
 * The second and third defects of the sixth owner review are one defect. `release:"Bewitched"
 * AND artist:"Laufey, Spencer Stewart"` returns nothing — YouTube credits the artist *and* the
 * producer, and that composite credit exists nowhere in MusicBrainz — and the answer used to
 * be `release:"Bewitched"` on its own, a hundred and forty-two records by everybody who ever
 * used the word. Dropping the artist is never the right widening.
 *
 * Widening the *title* is. A handful of track titles, each with the artist and a ±5 s duration
 * window, are far more discriminating than one album title: "Bewitched", "Puzzle", "Listen"
 * and "Gemini" are common words, and "From The Start" by Laufey at 3:19 is not. The recordings
 * come back carrying the releases they appear on, and those carry their release groups, so the
 * votes are counted off the search results themselves — no lookup, no second request.
 *
 * A group is only believed when `CONVERGENCE_VOTES` distinct sampled tracks name it **and** it
 * bears the album's name, so the fallback cannot wander off to the artist's other records.
 * From there the match resumes exactly where the first rung would have left it: these are
 * release groups, and the edition selection that follows is unchanged.
 *
 * ## Each video is asked about with **its own** artist
 *
 * Measured against the live index, on the owner's *Cars* import. YouTube credits the album to
 * Randy Newman, who wrote the score, and MusicBrainz credits the 2006 soundtrack
 * `ac0830de-51e0-43ee-b8ce-65c2b7f2b170` to Various Artists — a name no query built from
 * "Randy Newman" can reach. But the *tracks* are not by Various Artists, and YouTube Music
 * tags each of them with the artist who actually performs it:
 *
 *     recording:"Life is a Highway" AND artist:"Randy Newman"   → count 0
 *     recording:"Life is a Highway" AND artist:"Rascal Flatts"  → score 100, on ac0830de
 *     recording:"Real Gone"     AND artist:"Sheryl Crow"        → score 100, on ac0830de
 *     recording:"Our Town"      AND artist:"James Taylor"       → score 100, on ac0830de
 *     recording:"Find Yourself" AND artist:"Brad Paisley"       → score 100, on ac0830de
 *
 * Four independent votes, all on the release the owner named, and the releases come back on
 * the search result itself — no lookup. The album credit was the wrong credit to ask with,
 * and a compilation is exactly the shape where the album credit and the track credit are
 * different facts.
 *
 * This is **narrower** than what it replaces, not wider, and the distinction is the same one
 * `lucene.ts` protects: the query still carries an `artist:` clause, and the artist it carries
 * is one the source itself names — for that track, which is more specific than the one it
 * names for the record. The vote filter moves with it, or a search asked about Rascal Flatts
 * would throw away every answer for not being Randy Newman.
 */
async function convergeThroughRecordings(
  mb: MbGateway,
  hints: AlbumHints,
  videos: readonly MatchVideo[],
  limit: number,
  queries: string[],
  config: DeepPartialConfig,
): Promise<{ groups: readonly MbReleaseGroup[]; fallback: MatchFallback | null }> {
  const album = (hints.album ?? "").trim();
  const base = stripEditionQualifier(album);
  const credit = (hints.artist ?? "").trim();
  const artist = primaryArtist(credit) ?? credit;
  if (album === "" || artist === "") return { groups: [], fallback: null };

  const titleFloor = config.thresholds?.titleMatch ?? 0.87;
  const sample = convergenceSample(videos);
  /** group id → the sampled track indices that named it, and the group document. */
  const votes = new Map<string, { voters: Set<number>; group: MbReleaseGroup }>();

  for (const video of sample) {
    /*
     * The artist to ask about for *this* track: the video's own tags when it has them, the
     * album's credit otherwise. On an ordinary album the two are the same string and nothing
     * changes; on a compilation they are different facts and the track's is the true one.
     */
    const own = (video.ytArtist ?? video.uploader ?? "").trim();
    const askedFor = own === "" ? artist : (primaryArtist(own) ?? own);
    const query = lucene.recordingQuery({
      title: stripArtistPrefix(video.ytTrack ?? video.title, askedFor),
      artist: askedFor,
      durationSeconds: video.durationSeconds,
    });
    queries.push(query);
    const answer = await mb.search("recording", query, limit);
    const seenHere = new Set<string>();

    for (const recording of answer?.recordings ?? []) {
      const credited = recording["artist-credit"] ?? [];
      const name = credited
        .map((entry) => `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`)
        .join("")
        .trim();
      /*
       * A recording by somebody else is exactly what this fallback must not vote on: the
       * search is forgiving, and "Bewitched" by Laura Fygi comes back for a Laufey query too.
       *
       * The credit it is held to is **the one the query asked for** — the album's on an
       * ordinary album, the track's on a compilation. Holding a Rascal Flatts answer to
       * "Randy Newman" would discard every vote this rung exists to collect, and holding it to
       * nothing at all would let the homonym back in.
       */
      if (!creditCarriesArtist(askedFor, name) && !creditCarriesArtist(credit, name)) continue;

      for (const release of (recording as { releases?: readonly MbRelease[] }).releases ?? []) {
        const group = release["release-group"];
        const id = group?.id;
        if (group === undefined || id === undefined || id === "" || seenHere.has(id)) continue;
        const title = group.title ?? release.title ?? "";
        if (titleScore(album, title) < titleFloor && titleScore(base, title) < titleFloor) continue;
        seenHere.add(id);
        const entry = votes.get(id) ?? {
          voters: new Set<number>(),
          // The group stub a release carries has no artist credit of its own; borrowing the
          // recording's is honest — this vote exists *because* that credit matched — and it
          // keeps `releaseGroups.searchScore` from marking every converged group down to zero
          // on a field the search never sends.
          group: { ...group, "artist-credit": credited } as MbReleaseGroup,
        };
        entry.voters.add(video.index);
        votes.set(id, entry);
      }
    }
  }

  const converged = [...votes.values()]
    .filter((entry) => entry.voters.size >= CONVERGENCE_VOTES)
    .sort((a, b) => b.voters.size - a.voters.size)
    .map((entry) => entry.group);

  if (converged.length === 0) return { groups: [], fallback: null };
  return {
    groups: converged,
    fallback: {
      kind: "recordings",
      sampled: sample.length,
      titles: sample.map((video) => video.ytTrack ?? video.title),
      groups: converged.map((group) => group.id ?? ""),
    },
  };
}

/**
 * The `release-group` search: every group the album title could name, scored and ordered.
 *
 * Groups are ranked by the engine's own title/artist agreement plus a lean on the primary
 * type, not by MusicBrainz's relevance: MB scores a query, we score a hypothesis, and on a
 * common album title ("Discovery" is also a Mr. Children record; "Bad Ideas" is an album and a
 * single by the same artist) that is the difference between one candidate and the right one.
 *
 * **A ladder, and every rung of it names an artist.** Each is asked only when the one above it
 * came back empty, so the ordinary album still costs exactly one search:
 *
 *  1. the album title and the **first credited artist** — "Laufey" out of "Laufey, Spencer
 *     Stewart". YouTube credits whoever the label listed, producers included, and a composite
 *     credit exists in MusicBrainz almost never. The narrowest *plausible* question first.
 *  2. the album title and the **whole credit**, when there is more than one name in it: some
 *     records really are credited to a pair, and "Macklemore & Ryan Lewis" is one of them.
 *  3. the **base title** and the first credited artist, the edition qualifier treated as noise:
 *     "Let Go (Expanded Edition)" is a name MusicBrainz does not publish, and forty of the
 *     owner's imports were stuck on that alone.
 *  4. the album title, then the base title, and **each of the other names the source credits**,
 *     one at a time (`artistLadder`). This rung is the seventh owner review's first defect:
 *     *Stardew Valley Piano Collections* is credited by YouTube to "ConcernedApe, Meadow
 *     Bridgham, Augustine Mayuga Gonzales" and by MusicBrainz to "Augustine Mayuga Gonzales,
 *     Matthew Bridgham". The two strings agree on a name — the *third* one written — and
 *     neither of the rungs above ever asks for it, so seven searches found nothing at all over
 *     a release MusicBrainz has had since 2018.
 *  5. the **bare base title**: the trailing edition word stripped even without a bracket or a
 *     separator to mark it (`stripEditionQualifierLoosely`), still with the first credited
 *     artist. *AFTERCARE DELUXE* by Nessa Barrett is filed as *AFTERCARE*, with the deluxe
 *     pressing inside the group, and six searches never asked for that name.
 *  6. the **recordings**, in `convergeThroughRecordings` — the album found through its tracks.
 *
 * Rungs 4 and 5 are the answer to "the artist must never simply be thrown away": it is
 * **degraded**, name by name, and a shorter credit is not a wider query. `artist:"Augustine
 * Mayuga Gonzales"` is exactly as strict as `artist:"ConcernedApe"` — it asks about a shorter
 * credit, not about no credit, and it cannot return a stranger's record unless that stranger is
 * named on the source. That is the whole distinction between this and the
 * `releaseGroupQueryWide` that was deleted, and `lucene.ts` states it from the other side.
 *
 * What is deliberately *not* a rung, at any point, is the title on its own. That question was
 * the cause of the worst class of failure this matcher has: an album by a different artist,
 * imported silently, under a plausible name.
 */
async function findReleaseGroups(
  mb: MbGateway,
  hints: AlbumHints,
  videos: readonly MatchVideo[],
  limit: number,
  queries: string[],
  config: DeepPartialConfig,
  ladderOn = true,
): Promise<{ groups: GroupSearchScore[]; fallback: MatchFallback | null }> {
  const album = (hints.album ?? "").trim();
  if (album === "") return { groups: [], fallback: null };
  const credit = (hints.artist ?? "").trim();
  const primary = primaryArtist(credit);
  const base = stripEditionQualifier(album);
  const bare = stripEditionQualifierLoosely(album);

  /*
   * The one search in this function that can end up with no artist clause is the one where the
   * *source* names nobody — a hand-pasted playlist with no YouTube Music tags and no
   * auto-generated description. There is no narrower question to ask then, and the artist gate
   * has nothing to refuse either; what guards that case is `matchPreselectionFloor`, because a
   * homonym with a different tracklist scores nowhere near it.
   */
  const rungs: { query: string; fallback: MatchFallback | null }[] =
    primary === null
      ? [{ query: lucene.releaseGroupQuery(album, credit), fallback: null }]
      : [
          {
            query: lucene.releaseGroupQuery(album, primary),
            fallback: { kind: "primary-artist", from: credit, to: primary },
          },
          { query: lucene.releaseGroupQuery(album, credit), fallback: null },
        ];
  if (base !== album) {
    rungs.push({
      query: lucene.releaseGroupQuery(base, primary ?? credit),
      fallback: { kind: "base-title", from: album, to: base },
    });
  }

  if (ladderOn) {
    /*
     * The rest of the credit, name by name, against the album title and then the base title.
     *
     * `artistLadder` returns the first name and the whole credit first — the two rungs already
     * above — so `slice(2)` is exactly "the names nobody has asked for yet", in the order the
     * source lists them. It is empty for a single-name credit, which is why the ordinary album
     * is untouched by this and still costs one search.
     */
    for (const name of artistLadder(credit, CREDIT_LADDER_LIMIT).slice(2)) {
      const fallback: MatchFallback = { kind: "credited-artist", from: credit, to: name };
      rungs.push({ query: lucene.releaseGroupQuery(album, name), fallback });
      if (base !== album) rungs.push({ query: lucene.releaseGroupQuery(base, name), fallback });
    }
    if (bare !== base && bare !== album) {
      rungs.push({
        query: lucene.releaseGroupQuery(bare, primary ?? credit),
        fallback: { kind: "bare-title", from: album, to: bare },
      });
    }
  }

  /*
   * An answer that is not an answer, kept in case nothing better turns up.
   *
   * A rung is supposed to stop the ladder, and stopping at the first rung with *any* result is
   * what keeps an ordinary album at one search. It is also how the owner's *Cars* import
   * reached a different film: `releasegroup:"Cars" AND artist:"Randy Newman"` answers, with
   * exactly one group — **Cars 3 (original score)** — so no rung below it was ever climbed.
   *
   * `titleScore("Cars", "Cars 3 (original score)")` is **0.3**, against a `titleMatch` floor of
   * 0.87. The index did not hand back the record under another name; it handed back a different
   * record. So the ladder now carries on when *nothing it found bears the album's name* — and
   * keeps the weak answer, because a match that showed *Cars 3* is still better than a match
   * that shows nothing, and this must never be able to take something away.
   */
  const bearsTheName = (group: GroupSearchScore): boolean => {
    const titleFloor = config.thresholds?.titleMatch ?? 0.87;
    // All three names this ladder is willing to ask by, because a rung that asked for the bare
    // title must be allowed to answer with it: MusicBrainz files *AFTERCARE DELUXE* as
    // *AFTERCARE*, and judging that answer against the full title would throw away the very
    // rung that found it.
    return [album, base, bare].some((name) => titleScore(name, group.title) >= titleFloor);
  };

  let weak: { groups: GroupSearchScore[]; fallback: MatchFallback | null } | null = null;

  for (const rung of rungs) {
    if (rung.query === "") continue;
    queries.push(rung.query);
    const answer = await mb.search("release-group", rung.query, limit);
    const found: readonly MbReleaseGroup[] = answer?.["release-groups"] ?? [];
    if (found.length === 0) continue;
    const scored = releaseGroups.searchScore(found, hints, videos.length, config);
    if (!ladderOn || scored.some(bearsTheName)) {
      return { groups: scored, fallback: rung.fallback };
    }
    weak ??= { groups: scored, fallback: rung.fallback };
  }

  const converged = await convergeThroughRecordings(mb, hints, videos, limit, queries, config);
  if (converged.groups.length === 0 && weak !== null) return weak;
  return {
    groups: releaseGroups.searchScore(converged.groups, hints, videos.length, config),
    fallback: converged.fallback,
  };
}

/**
 * The lookups reserved before the exploration starts: one for the best release of each group.
 *
 * A group whose releases were never looked up has no fit, so it cannot be compared with one
 * that was, and the flat pre-score — title, artist and track counts, exactly the signals that
 * made a one-track single look like an album — would happily spend everything inside the wrong
 * group and call the question settled.
 */
function reserveOnePerGroup(
  prescored: readonly { id: string; releaseGroupId: string | null }[],
  limit: number,
): string[] {
  const chosen: string[] = [];
  const seenGroups = new Set<string>();
  for (const candidate of prescored) {
    if (candidate.id === "" || chosen.length >= limit) break;
    const key = candidate.releaseGroupId ?? "";
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    chosen.push(candidate.id);
  }
  return chosen;
}

/**
 * The fewest candidates a match opens before the early stop is allowed to fire.
 *
 * Not a scoring rule — a *chooser* rule. Step 2 of the wizard is a list somebody picks from,
 * and a list with one real card and thirteen saying "tracklist not fetched" is worse than the
 * six the flat plan used to leave, even when the one card is right. Three is the smallest
 * number that still shows an alternative and a runner-up next to the preselection, and it costs
 * at most two requests on the easiest album there is. The bound is unaffected: a candidate that
 * cannot win is still never opened once the floor is met.
 */
const MIN_EXPLORED = 3;

/** What one round of exploration produced, and what it cost. */
export interface Exploration {
  readonly ranking: ReleaseRanking;
  readonly detailedById: ReadonlyMap<string, MbRelease>;
  /** Why the loop stopped, in one word — asserted by the tests and shown in the journal. */
  readonly stoppedBecause: "safe" | "bounded" | "ceiling" | "exhausted";
}

/**
 * Open candidates while an unopened one could still win. A branch and bound over the ranking.
 *
 * The second defect of the sixth owner review, in one function. The old code looked up the
 * first six of the pre-score and stopped, so a fourteen-track *Appeal to Reason* that ranked
 * twelfth on metadata alone was never read and stayed at "0 videos matched" — a constant
 * deciding, on its own, whether the right album was ever examined.
 *
 * The rule here decides it instead, and it is the standard one: keep going while the **best
 * attainable** score of some unopened candidate (`ReleaseCandidate.ceiling`) is strictly
 * greater than the best score of a candidate that is already complete. Strictly, because a
 * shelf of pressings identical to the leader has a ceiling *equal* to its score, and equality
 * has to be a stop or an album with two dozen editions costs two dozen seconds to learn
 * nothing. Optimism is what makes it correct — a candidate is never skipped while it could
 * still win — and the track count already in the search result is what makes it tight.
 *
 * Three things bound it beyond that:
 *
 *  - the **ceiling** (`matchLookupLimit`), for the pathological record;
 *  - the **leader being `safe`, unambiguous and exact** — above the threshold, with no
 *    runner-up worth asking about, and with no track of the release and no video of the
 *    playlist left over. *Exact* is doing real work in that sentence and is not decoration:
 *    "safe and unambiguous" on its own would have stopped this very loop on *Appeal to
 *    Reason* after one lookup, because the fifteen-track edition scores 0.967 with nothing
 *    near it and is the wrong answer. Only a **perfect** fit licenses stopping early, and it
 *    licenses it completely: `durations`, `coverage` and `exactness` are all 1, so no unopened
 *    candidate can do better than tie on the three signals worth 0.49 between them, and what
 *    is left to win is a barcode;
 *  - the gate every one of these calls goes through at one request per second, which is not a
 *    rule of this function but is the reason it is written to stop rather than to be thorough.
 */
export async function exploreReleases(
  mb: MbGateway,
  input: AlbumMatchInput,
  releases: readonly MbRelease[],
  config: DeepPartialConfig,
  bounds: { readonly ceiling: number; readonly safe: number },
): Promise<Exploration> {
  const detailedById = new Map<string, MbRelease>();
  const attempted = new Set<string>();

  const rank = (): ReleaseRanking =>
    releaseCandidates.score(
      {
        videos: input.videos,
        hints: input.hints,
        candidates: releases.map((release): ReleaseCandidateInput => {
          const full = release.id === undefined ? undefined : detailedById.get(release.id);
          return full === undefined
            ? { release, detailed: false }
            : { release: full, detailed: true };
        }),
      },
      config,
    );

  const open = async (mbid: string): Promise<void> => {
    attempted.add(mbid);
    const full = await mb.lookupRelease(mbid);
    if (full !== null) detailedById.set(mbid, full);
  };

  let ranking = rank();
  for (const mbid of reserveOnePerGroup(ranking.candidates, bounds.ceiling)) {
    if (attempted.size >= bounds.ceiling) break;
    await open(mbid);
  }
  ranking = rank();

  let stoppedBecause: Exploration["stoppedBecause"] = "exhausted";
  for (;;) {
    /*
     * The **leader**, which since the artist veto is no longer the same thing as the tick.
     *
     * `ranking.preselected` answers "which box is ticked", and a candidate whose artist
     * disagrees is deliberately not ticked even when it is first and perfect. This loop is
     * asking a different question — "is there anything left that could still beat what I have
     * already read" — and that one is about the ranking, not about the tick. Reading the tick
     * here would make a Various Artists soundtrack spend the whole ceiling, fourteen lookups
     * at a second each, to learn nothing: the leader is complete and exact, nothing unopened
     * can beat it, and the fact that a person still has to confirm who made it changes none of
     * that.
     */
    const leader = ranking.candidates[0] ?? null;
    const exact = leader !== null && leader.uncovered === 0 && leader.leftOver === 0;
    if (
      attempted.size >= MIN_EXPLORED &&
      leader !== null &&
      leader.detailed &&
      exact &&
      leader.score >= bounds.safe &&
      !ranking.ambiguous
    ) {
      stoppedBecause = "safe";
      break;
    }
    if (attempted.size >= bounds.ceiling) {
      stoppedBecause = "ceiling";
      break;
    }

    let best = 0;
    for (const candidate of ranking.candidates) {
      if (candidate.detailed && candidate.score > best) best = candidate.score;
    }
    let next: ReleaseCandidate | null = null;
    for (const candidate of ranking.candidates) {
      if (candidate.detailed || candidate.id === "" || attempted.has(candidate.id)) continue;
      if (next === null || candidate.ceiling > next.ceiling) next = candidate;
    }
    if (next === null) {
      stoppedBecause = "exhausted";
      break;
    }
    if (attempted.size >= MIN_EXPLORED && next.ceiling <= best) {
      stoppedBecause = "bounded";
      break;
    }

    await open(next.id);
    ranking = rank();
  }

  return { ranking, detailedById, stoppedBecause };
}

export interface AlbumMatchHooks {
  /** Called once the real search count is known, so a progress bar can stop guessing. */
  readonly onPlan?: (planned: MatchBudget) => void;
}

/**
 * Match an album: the release groups, then the releases of the best few, then the fit, then
 * the mapping.
 *
 * Nothing here decides anything. It returns a ranking with a preselection and the reasons for
 * it; `confirm` is still the only thing that commits.
 */
export async function matchAlbum(
  mb: MbGateway,
  raw: AlbumMatchInput,
  settings: Settings,
  hooks: AlbumMatchHooks = {},
): Promise<AlbumMatch> {
  const config = configFromSettings(settings);
  const lookupLimit = lookupLimitOf(settings);
  const groupLimit = groupLimitOf(settings);
  const queries: string[] = [];
  let input = raw;

  // 1 — the release groups, down the ladder of `findReleaseGroups`. Every rung names an
  // artist; the one that dropped it is the reason this review exists.
  const { groups: groupScores, fallback } = await findReleaseGroups(
    mb,
    input.hints,
    input.videos,
    settings.matchSearchLimit,
    queries,
    config,
    settings.matchArtistLadder,
  );
  // The bare rung, having answered, has told us the trailing word was an edition after all.
  input = { ...input, hints: editionProvenByFallback(input.hints, fallback) };
  const kept = groupScores.slice(0, groupLimit);
  hooks.onPlan?.({
    searches: queries.length + (kept.length === 0 ? 1 : kept.length),
    lookups: lookupLimit,
  });

  // 2 — the releases of each kept group. One search each, so no group is judged on a pressing
  // it does not have.
  const searchResults: MbRelease[] = [];
  const seen = new Set<string>();
  const collect = (releases: readonly MbRelease[]): void => {
    for (const release of releases) {
      if (release.id === undefined || seen.has(release.id)) continue;
      seen.add(release.id);
      searchResults.push(release);
    }
  };

  if (kept.length === 0) {
    /*
     * No group at all, after every rung. The direct release search is the last thing left, and
     * it still carries the artist: an album this repository cannot find by name, by base name
     * or through its own tracks is an album to hand to a person, not an excuse to ask
     * MusicBrainz for every record that ever used the word.
     *
     * The artist it carries walks the same ladder the group search walked, for the same
     * reason and with the same stop-at-the-first-answer rule. Asking the release index for
     * "the first credited name" only, when the group index has just been asked for every name
     * and answered nothing, would make the last question narrower than the ones before it.
     */
    const album = stripEditionQualifierLoosely(input.hints.album ?? "");
    const credit = (input.hints.artist ?? "").trim();
    const names = settings.matchArtistLadder
      ? artistLadder(credit, CREDIT_LADDER_LIMIT)
      : [primaryArtist(credit) ?? credit];
    for (const name of names) {
      const direct = lucene.releaseQuery({
        album,
        artist: name,
        year: input.hints.year ?? null,
      });
      if (direct === "" || name === "") continue;
      queries.push(direct);
      const answer = releasesOf(await mb.search("release", direct, settings.matchSearchLimit));
      collect(answer);
      if (answer.length > 0) break;
    }
  } else {
    for (const group of kept) {
      const query = lucene.releaseQuery({
        album: input.hints.album ?? "",
        releaseGroupId: group.id,
      });
      queries.push(query);
      collect(releasesOf(await mb.search("release", query, settings.matchSearchLimit)));
    }

    /*
     * The release groups exist and not one of them yielded a release. Ask again, unofficially.
     *
     * `releaseQuery` appends `status:Official` unless it is told not to, which is right
     * everywhere else and wrong at this exact point: the groups were found by *name and
     * artist*, so they are already the record being looked for, and there is nothing left for
     * the status clause to protect against. When every pressing MusicBrainz has is a promo, a
     * bootleg or simply unset — ordinary on a self-released digital record — the group is on
     * the screen with no release under it and the match ends with no candidate, having spent a
     * search proving the record exists.
     *
     * It is deliberately **after the whole loop and only when nothing at all was found**,
     * rather than per group when that group came back empty. Two of *Discovery*'s three kept
     * groups have no official pressing of their own, so the per-group version cost every
     * ordinary album two extra searches and two extra reserved lookups to add candidates that
     * never win. A retry that fires only when the alternative is "no candidate" cannot do that.
     */
    if (searchResults.length === 0) {
      for (const group of kept) {
        const anyStatus = lucene.releaseQuery({
          album: input.hints.album ?? "",
          releaseGroupId: group.id,
          officialOnly: false,
        });
        queries.push(anyStatus);
        collect(releasesOf(await mb.search("release", anyStatus, settings.matchSearchLimit)));
      }
    }
  }

  // 3 — open candidates while an unopened one could still win (branch and bound).
  const explored = await exploreReleases(mb, input, searchResults, config, {
    ceiling: lookupLimit,
    safe: settings.safeThreshold,
  });
  const { ranking, detailedById } = explored;

  // 4 — fold the flat ranking back into the groups the screen shows.
  const index = new Map(groupScores.map((group) => [group.id, group]));
  const grouped = releaseGroups.group(ranking.candidates, index, config);

  // 5 — the mapping, against the preselected release.
  const winner = ranking.preselected;
  const release = winner === null ? null : (detailedById.get(winner.id) ?? null);
  const proposal =
    release === null ? null : mappingEngine.assign(input.videos, flattenTracks(release), config);

  return {
    kind: "album",
    ranking,
    groups: grouped,
    mapping: proposal,
    release,
    budget: { ...mb.calls },
    planned: { searches: queries.length, lookups: lookupLimit },
    queries,
    fallback,
    artist: artistVerdict(input.hints.artist, ranking.candidates),
    stoppedBecause: explored.stoppedBecause,
  };
}

/* ------------------------------------------------------------------ */
/* the artist gate                                                     */
/* ------------------------------------------------------------------ */

/**
 * Whether anything in the ranking is actually **by** the artist the source names.
 *
 * The first and worst defect of the sixth owner review: a fourteen-video *Bewitched* credited
 * "Laufey, Spencer Stewart" was matched to Laura Fygi's 1993 record — twelve tracks, seven of
 * the fourteen videos placed, score 0.537 — and imported. The card said "Artist mismatch" in
 * so many words. Eleven of three hundred and six matched albums are like it, *Listen* filed
 * under Marc Cary for a David Guetta playlist, *The Heist* under Crockett for Macklemore &
 * Ryan Lewis.
 *
 * A penalty could never have stopped that, and raising it until it could would refuse the
 * ordinary case where MusicBrainz credits a record to a name YouTube spells differently. This
 * is a different kind of statement: **a fact about the whole list**. If the source names an
 * artist and not one candidate carries it, the match has not found this record — it has found
 * records with the same title — and the only correct next step is to ask a person. The `match`
 * step turns a `false` here into an `ambiguous_release` Inbox item and `awaiting_review`, so
 * neither `--yes` nor fixtures mode can confirm past it: those open the `confirm` gate, and
 * the job never reaches it.
 *
 * Deliberately **not** a per-candidate veto. One candidate carrying the artist is enough for
 * the ranking to be believed, and the ranking then sorts it out on the fit like always.
 */
export function artistVerdict(
  credit: string | null | undefined,
  candidates: readonly { readonly artist: string }[],
): ArtistVerdict {
  const wanted = (credit ?? "").trim();
  if (wanted === "") return { wanted: null, carried: true, carriedBy: 0 };
  let carriedBy = 0;
  for (const candidate of candidates) {
    if (creditCarriesArtist(wanted, candidate.artist)) carriedBy += 1;
  }
  return { wanted, carried: carriedBy > 0, carriedBy };
}

/* ------------------------------------------------------------------ */
/* single                                                              */
/* ------------------------------------------------------------------ */

export interface SingleMatchInput {
  readonly video: MatchVideo;
}

/**
 * Match a lone video: recording candidates, and for each the release it would be filed under.
 *
 * One search plus one lookup per candidate, capped at N like the album path — a recording
 * search returns the recording and its release *stubs*, but the stubs carry no release group,
 * so the album/single/EP ordering `docs/04` asks for cannot be applied to them without asking.
 * Which is exactly why the cap exists.
 */
export async function matchSingle(
  mb: MbGateway,
  input: SingleMatchInput,
  settings: Settings,
): Promise<SingleMatch> {
  const config = configFromSettings(settings);
  const lookupLimit = recordingLookupLimitOf(settings);
  const video = input.video;

  const artist = video.ytArtist ?? video.uploader ?? null;
  /*
   * The video title without its "Artist - " prefix (DRIVE-1 §B1).
   *
   * An official artist channel has no YouTube Music `track` tag, so the query title is the
   * video's own — literally `Radiohead - Creep`. Sent as a Lucene phrase that finds a cover
   * *named* "Radiohead - Creep" and never the original, which is what the first real single
   * import proposed. The artist is a separate clause; repeating it inside the title clause
   * only narrows the search to the recordings that misspell themselves.
   */
  const title = stripArtistPrefix(video.ytTrack ?? video.title, artist);

  /*
   * Two searches, narrow then wide, merged.
   *
   * The narrow one — title, artist and a ±5 s duration window — is the one that finds the
   * right recording. The wide one is title alone, and it exists to surface the *wrong* ones:
   * a video tagged "Birdy" will never make MusicBrainz volunteer Bon Iver's original, yet
   * "Skinny Love" by someone else is exactly the mistake a matcher has to be seen rejecting.
   * A ranking that only ever contains plausible answers cannot demonstrate that it discards
   * implausible ones, and the user reading the list learns nothing from it.
   */
  const narrow = lucene.recordingQuery({
    title,
    artist,
    durationSeconds: video.durationSeconds,
  });
  const wide = lucene.recordingQuery({ title });

  const found = await mb.search("recording", narrow, settings.matchSearchLimit);
  const alternatives = await mb.search("recording", wide, settings.matchSearchLimit);

  const seen = new Set<string>();
  const raw: MbRecording[] = [];
  for (const recording of [...(found?.recordings ?? []), ...(alternatives?.recordings ?? [])]) {
    if (recording.id === undefined || seen.has(recording.id)) continue;
    seen.add(recording.id);
    raw.push(recording);
  }

  const candidates: RecordingCandidateInput[] = [];

  for (const [index, recording] of raw.entries()) {
    if (recording.id === undefined) continue;
    const credited = recording["artist-credit"] ?? [];
    const artistName = credited
      .map((entry) => `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`)
      .join("")
      .trim();

    // The release groups only come with a lookup, and only the first few get one.
    let releases = (recording as { releases?: readonly MbRelease[] }).releases ?? [];
    if (index < lookupLimit) {
      const full = await mb.lookupRecording(recording.id);
      const fullReleases = (full as { releases?: readonly MbRelease[] } | null)?.releases;
      if (fullReleases !== undefined) releases = fullReleases;
    }

    candidates.push({
      id: recording.id,
      title: recording.title ?? "",
      artist: artistName,
      disambiguation: recording.disambiguation ?? "",
      lengthMs: recording.length ?? null,
      isrcs: recording.isrcs ?? [],
      searchScore: (recording as { score?: number }).score ?? null,
      releases,
    });
  }

  const ranking = recordingCandidates.score({ video, candidates }, config);
  return {
    kind: "single",
    ranking,
    budget: { ...mb.calls },
    planned: { searches: 2, lookups: lookupLimit },
    queries: [narrow, wide],
    /*
     * The same gate as the album path, and this is the one place a title-only query survives.
     *
     * The wide recording search deliberately drops the artist — it exists to *surface* the
     * same-titled recordings by other people so the ranking can be seen rejecting them — and
     * that is safe exactly as long as nothing it brings back can be confirmed on its own. If
     * the whole list turns out to be other people's, that is not a ranking problem, it is a
     * question for a person.
     */
    artist: artistVerdict(
      video.ytArtist ?? video.uploader,
      ranking.candidates satisfies readonly RecordingCandidate[],
    ),
  };
}
