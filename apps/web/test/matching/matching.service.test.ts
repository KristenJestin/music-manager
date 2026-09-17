/**
 * The matching service, replayed against the recorded scenarios.
 *
 * What this suite is for, and what the pure-engine suite in `packages/domain` is not for: the
 * **orchestration**. Which searches are made, in which order, how many documents are fetched,
 * and whether the whole thing still holds together when the answers come off a cassette
 * instead of a socket. The scoring itself is proved next door, against the same recordings.
 *
 * No database, no network, no toolbox: the cassette gateway answers from the recorded
 * documents under the same cache keys the live client computes. A key the cassette does not
 * hold is an error, so a change to the request pattern breaks a test rather than silently
 * making a different match.
 */
import { describe, expect, it } from "vitest";
import { albumHints, type AlbumHints, type MbRelease } from "@mm/domain";
import { cassetteGateway, type MbGateway } from "#/server/services/matching.gateway.ts";
import {
  cassetteNameOf,
  cassetteNames,
  loadCassette,
  type Cassette,
} from "#/server/services/matching.cassettes.ts";
import type { MbSearchResult } from "#/server/integrations/musicbrainz.ts";
import {
  artistVerdict,
  configFromSettings,
  describeFallback,
  groupLimitOf,
  lookupLimitOf,
  matchAlbum,
  matchSingle,
} from "#/server/services/matching.service.ts";
import { defaults, type Settings } from "#/server/services/settings.ts";

const settings: Settings = defaults();

function cassette(name: string): Cassette {
  const found = loadCassette(name);
  if (found === null) throw new Error(`no cassette "${name}"`);
  return found;
}

/** The same derivation the `match` step uses — anything else would test a different match. */
function albumInput(recorded: Cassette): {
  videos: Cassette["videos"];
  hints: AlbumHints;
} {
  return { videos: recorded.videos, hints: albumHints(recorded.videos) };
}

/* ------------------------------------------------------------------ */
/* the cassettes themselves                                            */
/* ------------------------------------------------------------------ */

describe("the recorded scenarios", () => {
  it("holds the four the phase specification names, plus the owner review counter-examples", () => {
    expect(cassetteNames()).toEqual([
      "bad-ideas",
      "bewitched",
      "currents",
      "discovery",
      "formidable",
      "pure-heroine",
      "rise-against",
      "skinny-love",
      "the-heist",
    ]);
  });

  it("recognises a fixture URL, with or without a query or a fragment", () => {
    expect(cassetteNameOf("fixture://discovery")).toBe("discovery");
    expect(cassetteNameOf("fixture://discovery?fp=mismatch")).toBe("discovery");
    expect(cassetteNameOf("fixture://discovery#3")).toBe("discovery");
    expect(cassetteNameOf("https://music.youtube.com/playlist?list=x")).toBeNull();
  });

  it("refuses a document it did not record, rather than answering nothing", async () => {
    const gateway = cassetteGateway(cassette("discovery"));
    await expect(gateway.lookupRelease("not-a-recorded-mbid")).rejects.toThrow(/no document for/);
  });
});

/* ------------------------------------------------------------------ */
/* the request budget                                                  */
/* ------------------------------------------------------------------ */

describe("the request budget", () => {
  it("spends the whole ceiling on Discovery, which is the shape the ceiling is for", async () => {
    const recorded = cassette("discovery");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), settings);

    // Decision 151: `1 + matchGroupLimit` is the ceiling, and it is what the screen is told.
    expect(result.planned.searches).toBe(1 + groupLimitOf(settings));
    expect(result.budget.searches).toBeLessThanOrEqual(result.planned.searches);
    expect(result.budget.searches).toBeGreaterThan(1);
    /*
     * The expensive case, and worth having one in the suite. *Discovery* is twenty-three
     * pressings of one record, and the playlist carries a radio edit — so no candidate is ever
     * *exact*, the early stop never fires, and the leader's fit is 13/14 because "Face to
     * Face" is 2.2 s out on every pressing. Any unopened pressing could have had a 238-second
     * "Face to Face", so the bound is right to keep looking and right to find nothing. This is
     * what `matchLookupLimit` is a ceiling *for*: everything else in the corpus costs three.
     */
    expect(result.budget.lookups).toBe(lookupLimitOf(settings));
    expect(result.stoppedBecause).toBe("ceiling");
    // The counter on the gateway is the ground truth; `budget` must not be able to drift.
    expect(gateway.calls).toEqual(result.budget);
  });

  it("gives every group it searched at least one tracklist lookup", async () => {
    /*
     * The property the allocation exists for. Without it the flat pre-score — title, artist
     * and track counts, i.e. exactly the signals that made a one-track single look like an
     * album — would spend all six lookups inside one group, and the groups would then be
     * compared on a fit only one of them had.
     */
    const recorded = cassette("bad-ideas");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);
    for (const group of result.groups.groups) {
      expect(group.detailedCount, `group ${group.title} has no tracklist read`).toBeGreaterThan(0);
    }
  });

  it("honours a lower ceiling, and never exceeds it", async () => {
    const recorded = cassette("discovery");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), {
      ...settings,
      matchLookupLimit: 3,
    });

    expect(result.budget.lookups).toBeLessThanOrEqual(3);
    expect(result.budget.searches).toBeLessThanOrEqual(1 + groupLimitOf(settings));
    expect(
      result.ranking.candidates.filter((candidate) => candidate.detailed).length,
    ).toBeLessThanOrEqual(3);
  });

  it("spends three lookups on Currents, where it used to spend six", async () => {
    const recorded = cassette("currents");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), settings);
    expect(result.budget.lookups).toBe(3);
    expect(result.budget.searches).toBeLessThanOrEqual(1 + groupLimitOf(settings));
  });

  it("stops at the exploration floor once the leader is an exact fit", async () => {
    /*
     * *Pure Heroine*: one release group, and the best pre-scored pressing of it turns out to
     * cover all ten videos with nothing left over on either side. `durations`, `coverage` and
     * `exactness` are all 1, so nothing unopened can beat it on the three signals worth 0.49
     * between them — further lookups could only ever buy a different barcode. It stops at
     * three rather than at one because step 2 is a list somebody chooses from, and a list with
     * one real card is worse than the six the flat plan used to leave. Three, not six.
     */
    const recorded = cassette("pure-heroine");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);
    expect(result.budget.lookups).toBe(3);
    expect(result.stoppedBecause).toBe("safe");
    expect(result.ranking.preselected?.uncovered).toBe(0);
    expect(result.ranking.preselected?.leftOver).toBe(0);
  });

  it("honours a lower group limit, and searches exactly that many groups", async () => {
    const recorded = cassette("bad-ideas");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), {
      ...settings,
      matchGroupLimit: 1,
    });
    expect(result.budget.searches).toBe(2);
    expect(result.planned.searches).toBe(2);
  });

  it("spends two searches on a lone video: one narrow, one wide", async () => {
    const recorded = cassette("skinny-love");
    const video = recorded.videos[0];
    expect(video).toBeDefined();
    const gateway = cassetteGateway(recorded);
    const result = await matchSingle(gateway, { video: video! }, settings);

    expect(result.budget.searches).toBe(2);
    expect(result.budget.lookups).toBeLessThanOrEqual(lookupLimitOf(settings));
    expect(result.queries[0]).toContain("dur:[");
    // The wide one is what surfaces the same-title recordings by other artists.
    expect(result.queries[1]).toBe('recording:"Skinny Love"');
  });
});

/* ------------------------------------------------------------------ */
/* the scenarios, through the service                                  */
/* ------------------------------------------------------------------ */

describe("Discovery, through the service", () => {
  it("searches the release group first, then that group's releases", async () => {
    const recorded = cassette("discovery");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), settings);

    expect(result.queries[0]).toBe('releasegroup:"Discovery" AND artist:"Daft Punk"');
    expect(result.queries[1]).toMatch(/^rgid:[0-9a-f-]+ AND status:Official$/);
  });

  it("preselects the 2001 French CD and proposes the full mapping", async () => {
    const recorded = cassette("discovery");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.ranking.preselected?.id).toBe("d073287b-d1bd-4f11-a933-a4386f8cf701");
    expect(result.release?.id).toBe("d073287b-d1bd-4f11-a933-a4386f8cf701");
    expect(result.mapping?.bound).toBe(14);
    expect(result.mapping?.extraVideos).toHaveLength(1);
    expect(result.mapping?.uncoveredTracks).toHaveLength(0);
    expect(result.ranking.ambiguous).toBe(false);
  });
});

describe("Currents, through the service", () => {
  it("leaves two tracks uncovered, which is what raises the Inbox item", async () => {
    const recorded = cassette("currents");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.mapping?.bound).toBe(11);
    expect(result.mapping?.extraVideos).toHaveLength(0);
    expect(result.mapping?.uncoveredTracks.map((track) => track.title)).toEqual([
      "Gossip",
      "Disciples",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Bad Ideas — the third owner review's counter-example                 */
/* ------------------------------------------------------------------ */

describe("Bad Ideas — an album and a one-track single of the same name", () => {
  const ALBUM_2019 = "06cadffd-7930-4b56-a392-ab427188b56c";

  it("proposes the eleven-track 2019 album, not the single", async () => {
    /*
     * The exact case the owner reported: eleven videos, and MusicBrainz files "Bad Ideas" as
     * a 2019 album, a 2022 deluxe pressing in the same group, a 2019 EP, and a 2020 one-track
     * single. The version before decision 151 kept one release group, picked the single's,
     * offered one card at 94 %, and never proposed the album at all.
     */
    const recorded = cassette("bad-ideas");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.ranking.preselected?.id).toBe(ALBUM_2019);
    expect(result.ranking.preselected?.tracks).toBe(11);
    expect(result.ranking.preselected?.year).toBe(2019);
    expect(result.ranking.preselected?.score).toBeGreaterThanOrEqual(0.95);
    expect(result.mapping?.bound).toBe(11);
    expect(result.mapping?.extraVideos).toHaveLength(0);
    expect(result.mapping?.uncoveredTracks).toHaveLength(0);
  });

  it("keeps a one-track single facing eleven videos under 30 %", async () => {
    const recorded = cassette("bad-ideas");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    const singles = result.ranking.candidates.filter(
      (candidate) => candidate.detailed && candidate.tracks === 1,
    );
    expect(singles.length).toBeGreaterThan(0);
    for (const single of singles) {
      expect(single.score, `${single.title} (${String(single.date)})`).toBeLessThanOrEqual(0.3);
      // And it says so in words, not only in a number.
      expect(single.why.join(" | ")).toMatch(/1 of your 11 videos would find a track here/);
      expect(single.why.join(" | ")).toMatch(/10 videos would be left over/);
    }
  });

  it("groups the candidates, best group first, best release inside it preselected", async () => {
    const recorded = cassette("bad-ideas");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.groups.groups.length).toBeGreaterThan(1);
    const best = result.groups.preselected;
    expect(best?.primaryType).toBe("Album");
    expect(best?.releases[0]?.id).toBe(ALBUM_2019);
    expect(best?.releases[0]?.id).toBe(result.ranking.preselected?.id);

    // Every group is ordered by its best release, so the list of groups and the flat ranking
    // can never disagree about which record wins.
    const scores = result.groups.groups.map((group) => group.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    // The single is present — the user may still pick it — and it is last, well behind.
    const singleGroup = result.groups.groups.find((group) => group.primaryType === "Single");
    expect(singleGroup).toBeDefined();
    expect(singleGroup?.score).toBeLessThanOrEqual(0.3);
    expect(singleGroup?.preselected).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Pure Heroine — the fifth owner review's counter-example              */
/* ------------------------------------------------------------------ */

describe("Pure Heroine — two pressings, one of them with no picture", () => {
  /** The 2014 worldwide Universal pressing: the same ten tracks, and a front cover. */
  const XW_2014 = "002022bb-276c-455a-8cb9-2848b77c37b8";
  /** The 2013 US Lava pressing: the same ten tracks, and "No images available". */
  const US_2013 = "f546b766-4b04-4781-b058-3d5e7dabc37d";

  it("preselects the pressing that has a cover, not the one a point ahead without one", async () => {
    /*
     * The screenshot the fifth review came with: `f546b766…` at 99 %, no image at all, sitting
     * directly on top of `002022bb…` at 98 % with one. Both fit 10/10 — there is nothing to
     * choose between them on the tracklist, which is exactly when the tie-breakers speak, and
     * until decision 167 none of them knew what a cover was. The coverless pressing is still
     * read, because the exploration floor of three keeps step 2 a list worth choosing from.
     */
    const recorded = cassette("pure-heroine");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.ranking.preselected?.id).toBe(XW_2014);
    expect(result.ranking.preselected?.coverArt?.front).toBe(true);
    expect(result.ranking.preselected?.fit).toBe(10);

    const without = result.ranking.candidates.find((c) => c.id === US_2013);
    expect(without?.coverArt).toEqual({ available: false, front: false, count: 0 });
    expect(without?.fit).toBe(10);
    expect(without?.score).toBeLessThan(result.ranking.preselected?.score ?? 0);
  });

  it("says it in words, on both cards", async () => {
    const recorded = cassette("pure-heroine");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    const withCover = result.ranking.candidates.find((c) => c.id === XW_2014);
    const without = result.ranking.candidates.find((c) => c.id === US_2013);
    expect(withCover?.why.join(" | ")).toMatch(/Cover art available on the Cover Art Archive/);
    expect(withCover?.why.join(" | ")).toMatch(/Exact fit/);
    expect(without?.why.join(" | ")).toMatch(/No cover art on MusicBrainz/);
  });

  it("leaves a candidate nobody looked up saying nothing about covers at all", async () => {
    // `null` is "we never asked", and it must not read as "there is none": a shallow candidate
    // has no `cover-art-archive` block, because MusicBrainz sends it on lookups only.
    const recorded = cassette("pure-heroine");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    const shallow = result.ranking.candidates.filter((c) => !c.detailed);
    expect(shallow.length).toBeGreaterThan(0);
    for (const candidate of shallow) {
      expect(candidate.coverArt).toBeNull();
      expect(candidate.why.join(" | ")).not.toMatch(/cover art/i);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Appeal to Reason — the sixth owner review's buried edition           */
/* ------------------------------------------------------------------ */

describe("Appeal to Reason — the edition that fits exactly, ranked twelfth", () => {
  /** XW, 2014-09-12, Digital Media, Geffen. Fourteen tracks, and the playlist is fourteen. */
  const XW_2014 = "46a691d9-67f7-42c1-bc91-7689b0a7fade";
  /** XW, 2008-10, Digital Media. Fifteen tracks, the last a live bonus nobody has a video for. */
  const XW_2008 = "b5ae03f1-0980-4c67-ae20-e9635b69f404";

  it("opens the buried edition and preselects it", async () => {
    /*
     * Both halves of the fix in one assertion. The fourteen-track edition ranked twelfth on
     * metadata alone — its own date is 2014 against a ℗ 2008 — so the flat six-lookup plan
     * never read its tracklist and it sat at "0 videos matched" for ever. The branch and bound
     * reaches it because a **fourteen**-track pressing facing fourteen videos has the highest
     * attainable exactness of anything in the list, and `exactness` is then what makes it win
     * once read: it is the only candidate here with no orphan track *and* no orphan video.
     */
    const recorded = cassette("rise-against");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.ranking.preselected?.id).toBe(XW_2014);
    expect(result.ranking.preselected?.uncovered).toBe(0);
    expect(result.ranking.preselected?.leftOver).toBe(0);
    expect(result.ranking.preselected?.signals.exactness).toBe(1);
    expect(result.mapping?.bound).toBe(14);
    expect(result.mapping?.uncoveredTracks).toHaveLength(0);
    expect(result.mapping?.extraVideos).toHaveLength(0);
  });

  it("beats the fifteen-track edition that places every video and keeps a bonus track", async () => {
    const recorded = cassette("rise-against");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    const fifteen = result.ranking.candidates.find((c) => c.id === XW_2008);
    expect(fifteen?.detailed).toBe(true);
    // The two signals that could not tell them apart, and the one that can.
    expect(fifteen?.signals.coverage).toBe(1);
    expect(result.ranking.preselected?.signals.coverage).toBe(1);
    expect(fifteen?.signals.exactness).toBeLessThan(1);
    expect(fifteen?.score).toBeLessThan(result.ranking.preselected?.score ?? 0);
    expect(fifteen?.uncovered).toBe(1);
  });

  it("finds it in three lookups, where the flat plan of six did not find it at all", async () => {
    /*
     * The measurement the review asked for, and the answer is the opposite of what "explore
     * more" suggests: **fewer** requests, not more. The old plan opened the first six of the
     * pre-score, which is metadata rank, and the fourteen-track edition sat twelfth in it. The
     * branch and bound opens by *attainable* score, and a fourteen-track pressing facing
     * fourteen videos is the most promising thing on the list before anybody reads a note of
     * it — so it is opened third, turns out to fit exactly, and the loop stops on the spot.
     */
    const recorded = cassette("rise-against");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), settings);

    expect(result.budget.lookups).toBe(3);
    expect(result.stoppedBecause).toBe("safe");
    expect(result.budget.lookups).toBeLessThanOrEqual(lookupLimitOf(settings));
    expect(gateway.calls).toEqual(result.budget);
  });

  it("finds it even with the ceiling held at the old plan's six", async () => {
    // The ceiling is a stop for a pathological record, not the thing that makes this work.
    const recorded = cassette("rise-against");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), {
      ...settings,
      matchLookupLimit: 6,
    });
    expect(result.budget.lookups).toBeLessThanOrEqual(6);
    expect(result.ranking.preselected?.id).toBe(XW_2014);
  });
});

/* ------------------------------------------------------------------ */
/* the artist gate                                                     */
/* ------------------------------------------------------------------ */

describe("Bewitched — the artist and her producer, in one credit", () => {
  it("asks MusicBrainz for the first credited artist when the whole credit finds nothing", async () => {
    /*
     * `releasegroup:"Bewitched" AND artist:"Laufey, Spencer Stewart"` really does answer
     * `count: 0` — YouTube credits the producer next to the artist and MusicBrainz files the
     * record under "Laufey". The rung that used to follow dropped the artist altogether and
     * returned a hundred and forty-two records by everybody who ever used the word.
     */
    const recorded = cassette("bewitched");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.queries[0]).toBe('releasegroup:"Bewitched" AND artist:"Laufey"');
    // And never, at any rung, the title on its own.
    for (const query of result.queries) expect(query).not.toBe('releasegroup:"Bewitched"');
    expect(result.fallback?.kind).toBe("primary-artist");
  });

  it("preselects Laufey's album and nothing of Laura Fygi's", async () => {
    const recorded = cassette("bewitched");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.ranking.preselected?.artist).toMatch(/laufey/i);
    expect(result.artist.carried).toBe(true);
    for (const candidate of result.ranking.candidates) {
      expect(candidate.artist, `${candidate.title} (${candidate.id})`).not.toMatch(/fygi/i);
    }
  });
});

describe("The Heist (Deluxe Edition) — a duo credit, an edition, and eighteen tracks", () => {
  it("asks for the first credited name and then for the base title", async () => {
    /*
     * Three rungs in one source string. `artist:"Macklemore & Ryan Lewis"` answers nothing —
     * MusicBrainz files the record under exactly that credit and still will not answer the
     * phrase — and `releasegroup:"The Heist (Deluxe Edition)"` answers nothing either, because
     * MusicBrainz names the *record* and puts the edition in a comment. The base title with
     * the first credited name is the question that finds it.
     */
    const recorded = cassette("the-heist");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);

    expect(result.queries[0]).toBe(
      'releasegroup:"The Heist (Deluxe Edition)" AND artist:"Macklemore"',
    );
    expect(result.queries).toContain('releasegroup:"The Heist" AND artist:"Macklemore"');
    expect(result.fallback?.kind).toBe("base-title");
    for (const query of result.queries) expect(query).toMatch(/artist:|^rgid:/);
  });

  it("preselects the deluxe pressing, and does not penalise it for being deluxe", async () => {
    /*
     * The owner's screenshot: eighteen videos, eighteen tracks, mean Δ 0.3 s, and 76 % because
     * of `Disambiguation contains "deluxe" (−20 %)`. The source *announced* deluxe.
     */
    const recorded = cassette("the-heist");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);
    const chosen = result.ranking.preselected;

    expect(chosen?.tracks).toBe(18);
    expect(chosen?.artist).toMatch(/macklemore/i);
    expect(chosen?.uncovered).toBe(0);
    expect(chosen?.leftOver).toBe(0);
    expect(chosen?.signals.exactness).toBe(1);
    expect(chosen?.penalties.map((penalty) => penalty.reason).join(" | ")).not.toMatch(/deluxe/i);
    expect(chosen?.score).toBeGreaterThan(0.9);
    // The owner's library has this album filed under "Crockett". Nothing like it may win.
    expect(result.artist.carried).toBe(true);
    for (const candidate of result.ranking.candidates) {
      expect(candidate.artist, candidate.title).toMatch(/macklemore/i);
    }
  });

  it("marks a standard pressing down for not being the edition asked for", async () => {
    const recorded = cassette("the-heist");
    const result = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);
    /*
     * The deduction is on the *known* half of a candidate — a disambiguation and a title come
     * back with the search — so it lands on the fifteen-track pressings without any of them
     * having to be opened. Which is the point: it is part of what keeps them from being.
     */
    const standard = result.ranking.candidates.find((candidate) => candidate.tracks === 15);
    expect(standard, "a fifteen-track pressing is among the candidates").toBeDefined();
    expect(standard?.penalties.map((penalty) => penalty.reason).join(" | ")).toMatch(
      /asks for the deluxe edition and this pressing does not say it is one/,
    );
    expect(standard?.score).toBeLessThan(result.ranking.preselected?.score ?? 0);
  });
});

describe("Skinny Love, through the service", () => {
  it("preselects Birdy and files it under her album", async () => {
    const recorded = cassette("skinny-love");
    const video = recorded.videos[0];
    const result = await matchSingle(cassetteGateway(recorded), { video: video! }, settings);

    expect(result.ranking.preselected?.artist).toBe("Birdy");
    expect(result.ranking.preselected?.borrow?.title).toBe("Birdy");
    expect(result.ranking.preselected?.borrow?.type).toBe("Album");
  });

  it("also answers the video the toolbox fixture serves, so the wizard replays offline", async () => {
    /*
     * `fixture://skinny-love` is Bon Iver's original, not Birdy's cover — a different artist
     * clause and a thirty-six second wider duration window, hence a different cache key. The
     * cassette carried no document for it, so the Console's step 2 threw for every single
     * import in fixtures mode (DRIVE-1 §A1). The scenario is unchanged; the entries are a
     * superset.
     */
    const recorded = cassette("skinny-love");
    const fromToolbox = {
      id: "MVzhTGx2Lec",
      index: 0,
      title: "Skinny Love",
      durationSeconds: 238,
      uploader: "Bon Iver - Topic",
      ytTrack: "Skinny Love",
      ytArtist: "Bon Iver",
      ytAlbum: "For Emma, Forever Ago",
      ytReleaseYear: 2007,
    };
    const result = await matchSingle(cassetteGateway(recorded), { video: fromToolbox }, settings);

    expect(result.ranking.preselected?.artist).toMatch(/bon iver/i);
    expect(result.ranking.preselected?.borrow).not.toBeNull();
  });

  it("brings back the other artists' versions, and puts them under 0.4", async () => {
    const recorded = cassette("skinny-love");
    const video = recorded.videos[0];
    const result = await matchSingle(cassetteGateway(recorded), { video: video! }, settings);

    const bonIver = result.ranking.candidates.filter((c) => /bon iver/i.test(c.artist));
    expect(bonIver.length).toBeGreaterThan(0);
    for (const candidate of bonIver) expect(candidate.score).toBeLessThan(0.4);
  });
});

/* ------------------------------------------------------------------ */
/* settings reach the engine                                           */
/* ------------------------------------------------------------------ */

describe("the settings", () => {
  it("carry every weight, threshold and preference the engine takes", () => {
    const config = configFromSettings(settings);
    expect(config.weights?.release).toEqual(settings.matchReleaseWeights);
    expect(config.weights?.recording).toEqual(settings.matchRecordingWeights);
    expect(config.weights?.mapping).toEqual(settings.matchMappingWeights);
    expect(config.thresholds?.safe).toBe(settings.safeThreshold);
    expect(config.preferences?.countries).toEqual(settings.preferredCountries);
  });

  it("change the ranking when the country preference changes", async () => {
    const recorded = cassette("discovery");
    const asShipped = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);
    const preferringBritain = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), {
      ...settings,
      preferredCountries: ["GB", "XW", "FR", "US"],
    });

    expect(asShipped.ranking.preselected?.country).toBe("FR");
    expect(preferringBritain.ranking.preselected?.country).toBe("GB");
  });

  it("widen the duration tolerance, which raises the fit", async () => {
    const recorded = cassette("discovery");
    const tight = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), settings);
    const loose = await matchAlbum(cassetteGateway(recorded), albumInput(recorded), {
      ...settings,
      matchDurationTolerance: 5,
    });

    // "Face to Face" is 2.2 s out on every pressing: inside 5 s, outside 2 s.
    expect(tight.ranking.preselected?.fit).toBe(13);
    expect(loose.ranking.preselected?.fit).toBe(14);
  });
});

/* ------------------------------------------------------------------ */
/* the search ladder, rung by rung                                     */
/* ------------------------------------------------------------------ */

/**
 * A gateway with a script instead of a cassette.
 *
 * The last two rungs of the ladder are, by construction, the ones no recorded scenario reaches:
 * a cassette of a search that *worked* cannot demonstrate the search that did not. So this one
 * answers from a table keyed by query, records everything it was asked, and lets each rung be
 * driven on its own — an empty answer here is a real empty answer, which is the whole point.
 */
function scriptedGateway(script: {
  searches?: Record<string, MbSearchResult>;
  releases?: Record<string, MbRelease>;
}): MbGateway & { asked: string[] } {
  const asked: string[] = [];
  const calls = { searches: 0, lookups: 0 };
  return {
    asked,
    calls,
    search(_entity, query) {
      calls.searches += 1;
      asked.push(query);
      return Promise.resolve(script.searches?.[query] ?? {});
    },
    lookupRelease(mbid) {
      calls.lookups += 1;
      return Promise.resolve(script.releases?.[mbid] ?? null);
    },
    lookupRecording() {
      calls.lookups += 1;
      return Promise.resolve(null);
    },
  };
}

describe("the release-group search ladder", () => {
  const CREDIT = "Laufey, Spencer Stewart";
  const ALBUM = "Bewitched (Deluxe Edition)";
  const VIDEOS = [
    {
      id: "v1",
      index: 0,
      title: "Dreamer",
      durationSeconds: 210,
      ytArtist: CREDIT,
      ytAlbum: ALBUM,
    },
    {
      id: "v2",
      index: 1,
      title: "Promise",
      durationSeconds: 234,
      ytArtist: CREDIT,
      ytAlbum: ALBUM,
    },
    {
      id: "v3",
      index: 2,
      title: "From the Start",
      durationSeconds: 169,
      ytArtist: CREDIT,
      ytAlbum: ALBUM,
    },
    { id: "v4", index: 3, title: "Misty", durationSeconds: 209, ytArtist: CREDIT, ytAlbum: ALBUM },
  ];
  const input = { videos: VIDEOS, hints: albumHints(VIDEOS) };

  it("never asks for the title on its own, whatever comes back empty", async () => {
    const gateway = scriptedGateway({});
    await matchAlbum(gateway, input, settings);
    for (const query of gateway.asked) {
      expect(query, "a query that names no artist").toMatch(/artist:/);
    }
  });

  it("climbs first credited artist, whole credit, base title, and stops at an answer", async () => {
    const gateway = scriptedGateway({});
    const result = await matchAlbum(gateway, input, settings);

    // The album hint carries the edition qualifier; it is stripped for the *query* only, and
    // only once the two questions that keep the full title have come back empty.
    expect(gateway.asked.slice(0, 3)).toEqual([
      'releasegroup:"Bewitched (Deluxe Edition)" AND artist:"Laufey"',
      'releasegroup:"Bewitched (Deluxe Edition)" AND artist:"Laufey, Spencer Stewart"',
      'releasegroup:"Bewitched" AND artist:"Laufey"',
    ]);
    // And then the last rung, which found nothing here and so claims no fallback: a rung that
    // did not answer is not a rung the journal should say the match came back from.
    expect(gateway.asked.filter((query) => query.startsWith("recording:"))).toHaveLength(4);
    expect(result.fallback).toBeNull();
  });

  it("falls back through the recordings and converges on the group two tracks agree on", async () => {
    const group = {
      title: "Bewitched",
      "primary-type": "Album",
      "first-release-date": "2023-09-08",
    };
    const recording = (title: string, seconds: number, groupId: string, artist: string) => ({
      id: `rec-${title}`,
      title,
      length: seconds * 1000,
      "artist-credit": [{ name: artist }],
      releases: [
        {
          id: `rel-${groupId}`,
          title: "Bewitched",
          "release-group": { ...group, id: groupId },
        },
      ],
    });
    const gateway = scriptedGateway({
      searches: {
        // Two of the four sampled tracks name the same group; one names somebody else's record
        // and one names a group only once. Two votes is the bar.
        'recording:"Promise" AND artist:"Laufey" AND dur:[229000 TO 239000]': {
          recordings: [recording("Promise", 234, "rg-bewitched", "Laufey")],
        },
        'recording:"Dreamer" AND artist:"Laufey" AND dur:[205000 TO 215000]': {
          recordings: [recording("Dreamer", 210, "rg-bewitched", "Laufey")],
        },
        'recording:"Misty" AND artist:"Laufey" AND dur:[204000 TO 214000]': {
          recordings: [recording("Misty", 209, "rg-elsewhere", "Laura Fygi")],
        },
        'recording:"From the Start" AND artist:"Laufey" AND dur:[164000 TO 174000]': {
          recordings: [recording("From the Start", 169, "rg-single", "Laufey")],
        },
      },
    });

    const result = await matchAlbum(gateway, input, settings);
    expect(result.fallback).toEqual({
      kind: "recordings",
      sampled: 4,
      titles: ["Promise", "Dreamer", "Misty", "From the Start"],
      groups: ["rg-bewitched"],
    });
    // Laura Fygi's group never votes: the recording that named it is not credited to Laufey.
    expect(gateway.asked).not.toContain("rgid:rg-elsewhere AND status:Official");
    // And a group named by one track only is not a convergence.
    expect(gateway.asked).not.toContain("rgid:rg-single AND status:Official");
    expect(gateway.asked).toContain("rgid:rg-bewitched AND status:Official");
  });

  it("samples the four longest tracks, longest first", async () => {
    const gateway = scriptedGateway({});
    await matchAlbum(gateway, input, settings);
    const recordings = gateway.asked.filter((query) => query.startsWith("recording:"));
    expect(recordings).toHaveLength(4);
    expect(recordings[0]).toContain('recording:"Promise"'); // 234 s, the longest
    expect(recordings[3]).toContain('recording:"From the Start"'); // 169 s, the shortest
  });
});

/* ------------------------------------------------------------------ */
/* the artist gate                                                     */
/* ------------------------------------------------------------------ */

describe("artistVerdict", () => {
  it("refuses a list in which nothing is by the artist the source names", () => {
    const verdict = artistVerdict("Laufey, Spencer Stewart", [
      { artist: "Laura Fygi" },
      { artist: "Eddie Higgins Trio" },
      { artist: "Gordon Jenkins" },
    ]);
    expect(verdict.carried).toBe(false);
    expect(verdict.carriedBy).toBe(0);
    expect(verdict.wanted).toBe("Laufey, Spencer Stewart");
  });

  it("accepts the list as soon as one candidate carries the artist", () => {
    const verdict = artistVerdict("Laufey, Spencer Stewart", [
      { artist: "Laura Fygi" },
      { artist: "Laufey" },
    ]);
    expect(verdict.carried).toBe(true);
    expect(verdict.carriedBy).toBe(1);
  });

  it("has nothing to refuse when the source names nobody", () => {
    expect(artistVerdict(null, [{ artist: "Laura Fygi" }]).carried).toBe(true);
    expect(artistVerdict("", []).carried).toBe(true);
  });

  it("refuses an empty list when the source does name somebody", () => {
    expect(artistVerdict("Laufey", []).carried).toBe(false);
  });
});

describe("describeFallback", () => {
  it("says which question was asked instead, in one line for the journal", () => {
    expect(
      describeFallback({ kind: "primary-artist", from: "Laufey, Spencer Stewart", to: "Laufey" }),
    ).toMatch(/names more than one artist, so MusicBrainz was asked for the first of them/);
    expect(
      describeFallback({ kind: "base-title", from: "Let Go (Expanded Edition)", to: "Let Go" }),
    ).toMatch(/base title/);
    expect(
      describeFallback({ kind: "recordings", sampled: 4, titles: ["A", "B"], groups: ["g"] }),
    ).toMatch(/searched as recordings/);
  });
});
