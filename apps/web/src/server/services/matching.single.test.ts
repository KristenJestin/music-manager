// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MbRecording, MbRelease } from "@mm/domain";
import type { MbSearchResult } from "#/server/integrations/musicbrainz.ts";
import type { MbGateway } from "#/server/services/matching.gateway.ts";
import { matchSingle } from "#/server/services/matching.service.ts";
import { defaults } from "#/server/services/settings.ts";

/**
 * The single path's MusicBrainz queries — DRIVE-1 §B1.
 *
 * The first real single import pasted Radiohead's official video, whose title is literally
 * `Radiohead - Creep`. That string went into the query as a Lucene *phrase*, so MusicBrainz
 * answered with the one recording that happens to be named that — a cover by another artist —
 * and never proposed the original. The credit belongs in the `artist` clause, not in the
 * title, and this is the test that says so.
 *
 * No network: the gateway is a recorder that returns nothing and remembers what it was asked.
 */
function recordingGateway(recordings: readonly MbRecording[] = []): MbGateway & {
  readonly queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    calls: { searches: 0, lookups: 0 },
    // eslint-disable-next-line @typescript-eslint/require-await
    async search(_entity, query): Promise<MbSearchResult | null> {
      queries.push(query);
      return { recordings } as unknown as MbSearchResult;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async lookupRelease(): Promise<MbRelease | null> {
      return null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async lookupRecording(): Promise<MbRecording | null> {
      return null;
    },
  };
}

const VIDEO = {
  id: "XFkzRNyygfk",
  index: 0,
  title: "Radiohead - Creep",
  durationSeconds: 236,
  uploader: "Radiohead",
  ytTrack: null,
  ytArtist: null,
  ytAlbum: null,
  ytReleaseYear: null,
  description: null,
};

describe("matchSingle queries", () => {
  it("searches the title without the uploader's own credit in front of it", async () => {
    const gateway = recordingGateway();
    await matchSingle(gateway, { video: VIDEO }, defaults());

    expect(gateway.queries).toHaveLength(2);
    for (const query of gateway.queries) {
      expect(query).not.toContain("Radiohead - Creep");
      expect(query).toContain('recording:"Creep"');
    }
    // The credit is still evidence — it is simply a clause of its own.
    expect(gateway.queries[0]).toContain('artist:"Radiohead"');
  });

  it("keeps a title whose leading segment is not the uploader", async () => {
    const gateway = recordingGateway();
    await matchSingle(
      gateway,
      { video: { ...VIDEO, title: "Creep - Radiohead", uploader: "Radiohead" } },
      defaults(),
    );
    expect(gateway.queries[0]).toContain('recording:"Creep - Radiohead"');
  });

  it("prefers the YouTube Music track tag when the video carries one", async () => {
    const gateway = recordingGateway();
    await matchSingle(
      gateway,
      { video: { ...VIDEO, ytTrack: "Creep", ytArtist: "Radiohead", uploader: "Radiohead - Topic" } },
      defaults(),
    );
    expect(gateway.queries[0]).toContain('recording:"Creep"');
  });
});
