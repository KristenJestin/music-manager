/**
 * `mm discover list`, the human form.
 *
 * Only the naming is pinned here, because it is the only part with a decision in it: the three
 * blocks share one row renderer, and a similar-artist row *is* its artist, so the generic
 * `artist — title` printed `Cassius — Cassius` — a record nobody made. Everything else in the
 * command is `discoverList`, which `discover.ts` already owns.
 */
import { describe, expect, it } from "vitest";
import type { DiscoverItemView } from "#/server/services/discover.ts";
import { labelOf } from "./discover.ts";

const item = (over: Partial<DiscoverItemView>): DiscoverItemView =>
  ({
    id: "dsc_1",
    kind: "recommendation",
    status: "open",
    subject: "release-group:rg-1",
    title: "Homework",
    artist: "Daft Punk",
    albumTitle: "Homework",
    artistMbid: null,
    releaseGroupMbid: "rg-1",
    recordingMbid: null,
    year: 1997,
    primaryType: "Album",
    secondaryTypes: [],
    score: 0.5,
    reason: "because you played Daft Punk 192× this month",
    source: "ListenBrainz",
    inLibrary: false,
    payload: {},
    ...over,
  }) satisfies DiscoverItemView;

describe("labelOf", () => {
  it("names a record by its artist and its title", () => {
    expect(labelOf(item({}))).toBe("Daft Punk — Homework");
  });

  it("names an artist once, not twice", () => {
    expect(labelOf(item({ kind: "similar_artist", title: "Cassius", artist: "Cassius" }))).toBe(
      "Cassius",
    );
  });

  it("does not repeat a record that happens to be named after its artist", () => {
    expect(labelOf(item({ title: "Air", artist: "Air" }))).toBe("Air");
  });
});
