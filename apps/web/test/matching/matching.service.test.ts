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
import { albumHints, type AlbumHints } from "@mm/domain";
import { cassetteGateway } from "#/server/services/matching.gateway.ts";
import {
  cassetteNameOf,
  cassetteNames,
  loadCassette,
  type Cassette,
} from "#/server/services/matching.cassettes.ts";
import {
  configFromSettings,
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
  it("holds the four the phase specification names, plus the owner review counter-example", () => {
    expect(cassetteNames()).toEqual([
      "bad-ideas",
      "currents",
      "discovery",
      "formidable",
      "skinny-love",
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
  it("spends one group search, one search per group kept, and N lookups", async () => {
    const recorded = cassette("discovery");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), settings);

    // Decision 151: `1 + matchGroupLimit` is the ceiling, and it is what the screen is told.
    expect(result.planned.searches).toBe(1 + groupLimitOf(settings));
    expect(result.budget.searches).toBeLessThanOrEqual(result.planned.searches);
    expect(result.budget.searches).toBeGreaterThan(1);
    expect(result.budget.lookups).toBeLessThanOrEqual(lookupLimitOf(settings));
    expect(result.budget.lookups).toBe(6);
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

  it("honours a lower lookup limit, and looks up exactly that many", async () => {
    const recorded = cassette("discovery");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), {
      ...settings,
      matchLookupLimit: 3,
    });

    expect(result.budget.lookups).toBe(3);
    expect(result.budget.searches).toBeLessThanOrEqual(1 + groupLimitOf(settings));
    expect(result.ranking.candidates.filter((candidate) => candidate.detailed)).toHaveLength(3);
  });

  it("spends the same budget on Currents", async () => {
    const recorded = cassette("currents");
    const gateway = cassetteGateway(recorded);
    const result = await matchAlbum(gateway, albumInput(recorded), settings);
    expect(result.budget.lookups).toBe(6);
    expect(result.budget.searches).toBeLessThanOrEqual(1 + groupLimitOf(settings));
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
