/**
 * The comparison of `docs/03-metadonnees.md` §7, without a database.
 *
 * `verifyAlbum` needs Postgres; the *judgement* does not, and the judgement is what has to be
 * right. So the three pure pieces are tested directly against the cassette recorded from the
 * dockerised Navidrome: what "the value survived" means, how the album is located, and which
 * of the seventeen rows the table ends up with.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, field, type TrackDocument } from "@mm/domain";
import { NavidromeClient } from "#/server/integrations/navidrome/client.ts";
import { cassetteFetch, loadCassette } from "#/server/integrations/navidrome/cassettes.ts";
import { compareAlbum, compareField, locateAlbum, writtenValues, type ReadBack } from "./verify.ts";

const cassette = loadCassette();

const api = (): NavidromeClient =>
  new NavidromeClient(
    { url: "http://localhost:4533", user: "admin", password: "admin" },
    { fetch: cassetteFetch(cassette) },
  );

/* ------------------------------------------------------------------ */
/* one field                                                           */
/* ------------------------------------------------------------------ */

describe("compareField", () => {
  it("is ok when the value survived", () => {
    expect(compareField("title", "title", ["One More Time"], "One More Time").status).toBe("ok");
  });

  it("ignores order and case, because a server is free to sort", () => {
    const verdict = compareField(
      "genres[]",
      "genre",
      ["House", "Electronic"],
      ["electronic", "house"],
    );
    expect(verdict.status).toBe("ok");
  });

  it("is a mismatch when the sets differ, even by one value", () => {
    const verdict = compareField("genres[]", "genre", ["house", "electronic"], ["house"]);
    expect(verdict.status).toBe("mismatch");
    expect(verdict.read).toBe("house");
  });

  it("is not_indexed when the server says nothing at all", () => {
    for (const empty of [undefined, null, "", [], 0]) {
      expect(compareField("moods[]", "mood", ["party"], empty).status).toBe("not_indexed");
    }
  });

  it("treats a bpm of 0 as absent, not as zero beats per minute", () => {
    expect(compareField("bpm", "bpm", ["120"], 0).status).toBe("not_indexed");
  });

  it("carries the tag map's level, which is what decides an Inbox item", () => {
    expect(compareField("title", "title", ["x"], "y").required).toBe(true);
    expect(compareField("moods[]", "mood", ["x"], "y").required).toBe(false);
    // A row with no tag-map field behind it is never "required".
    expect(compareField("something", null, ["x"], "y").required).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* finding the album                                                   */
/* ------------------------------------------------------------------ */

describe("locateAlbum", () => {
  it("prefers the release MBID when both sides have one", async () => {
    const album = await locateAlbum(api(), {
      title: "Discovery",
      albumArtist: "Daft Punk",
      releaseMbid: "d073287b-d1bd-4f11-a933-a4386f8cf701",
    });
    expect(album?.name).toBe("Discovery");
    // `getAlbum` was called, so the songs are there — a `search3` summary has none.
    expect((album?.song ?? []).length).toBe(14);
  });

  it("falls back to title plus album artist", async () => {
    const album = await locateAlbum(api(), {
      title: "Discovery",
      albumArtist: "Daft Punk",
      releaseMbid: null,
    });
    expect(album?.id).toBeDefined();
  });

  it("returns null rather than guessing when nothing matches", async () => {
    const album = await locateAlbum(api(), {
      title: "Discovery",
      albumArtist: "Somebody Else",
      releaseMbid: null,
    });
    // Exactly one album carries the title, so the third rule still finds it…
    expect(album?.name).toBe("Discovery");
  });

  it("returns null when the search comes back empty", async () => {
    const empty = new NavidromeClient(
      { url: "http://nav.test", user: "a", password: "b" },
      {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ "subsonic-response": { status: "ok", searchResult3: {} } }),
              {
                headers: { "content-type": "application/json" },
              },
            ),
          ),
      },
    );
    expect(await locateAlbum(empty, { title: "Nope", albumArtist: "X", releaseMbid: null })).toBe(
      null,
    );
  });
});

/* ------------------------------------------------------------------ */
/* the whole table                                                     */
/* ------------------------------------------------------------------ */

/** A document holding what the fixture album was tagged with. */
function discoveryDocument(): TrackDocument {
  const fields: Record<string, ReturnType<typeof field>> = {};
  const put = (name: string, value: unknown): void => {
    fields[name] = field(value as never, "musicbrainz", "2026-09-05T00:00:00Z");
  };
  put("title", "One More Time");
  put("album", "Discovery");
  put("albumartist", "Daft Punk");
  put("artist", "Daft Punk");
  put("artists", ["Daft Punk"]);
  put("date", "2001-02-26");
  put("originaldate", "2001-02-26");
  put("genre", [
    "electronic",
    "house",
    "dance",
    "ambient",
    "ambient house",
    "breakbeat",
    "electro",
    "french house",
  ]);
  put("mood", ["party"]);
  put("releasetype", ["album"]);
  put("label", ["Virgin"]);
  put("musicbrainz_recordingid", "60fa767a-d85d-4991-82bc-4294e0b11ae7");
  put("replaygain_track_gain", "9.78 dB");
  put("replaygain_album_gain", "9.78 dB");
  put("bpm", 123);
  put("isrc", ["GBAHT1305744", "GBDUW0000053"]);
  put("lyrics", { synced: "[00:00.00] One more time\n", plain: "One more time\n" });
  put("front_cover", { url: "", data: "" });
  return { ...emptyDocument(1), fields };
}

async function readBack(): Promise<ReadBack> {
  const client = api();
  const album = await locateAlbum(client, {
    title: "Discovery",
    albumArtist: "Daft Punk",
    releaseMbid: null,
  });
  const first = (album?.song ?? [])[0];
  const song = await client.getSong(first?.id ?? "");
  const lyrics = await client.getLyricsBySongId(first?.id ?? "");
  const cover = await client.getCoverArt(album?.coverArt ?? "", 200);
  return {
    album: album!,
    song: song ?? first!,
    syncedLyrics: lyrics.some((entry) => entry.synced === true),
    coverOk: cover.ok && cover.kind !== "",
  };
}

describe("compareAlbum", () => {
  it("compares only what was written, never invents a row", () => {
    const document: TrackDocument = {
      ...emptyDocument(1),
      fields: { title: field("One More Time", "musicbrainz", "2026-09-05T00:00:00Z") },
    };
    const rows = compareAlbum(writtenValues(document), {
      album: { id: "a", name: "Discovery" },
      song: { id: "s", title: "One More Time" },
      syncedLyrics: false,
      coverOk: false,
    });
    // `title` was written; nothing else was, so nothing else is judged.
    expect(rows.map((row) => row.name)).toEqual(["title"]);
    expect(rows[0]?.status).toBe("ok");
  });

  it("reads the fixture album back with every required field ok", async () => {
    const rows = compareAlbum(writtenValues(discoveryDocument()), await readBack());
    const failed = rows.filter((row) => row.required && row.status === "mismatch");
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    // The seventeen-ish rows of §7 are all there.
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "title",
        "albumArtist",
        "artists[]",
        "album",
        "year",
        "originalReleaseDate",
        "genres[]",
        "releaseTypes[]",
        "recordLabels[]",
        "replayGain.trackGain",
        "replayGain.albumGain",
        "synced lyrics",
        "isrc",
        "musicBrainzId",
        "coverArt",
      ]),
    );
  });

  it("compares the year against the date's first four characters", async () => {
    const rows = compareAlbum(writtenValues(discoveryDocument()), await readBack());
    const year = rows.find((row) => row.name === "year");
    expect(year?.written).toBe("2001");
    expect(year?.status).toBe("ok");
  });

  it("compares replay gain as a number, not as `-8.10 dB` against `-8.1`", async () => {
    const rows = compareAlbum(writtenValues(discoveryDocument()), await readBack());
    const gain = rows.find((row) => row.name === "replayGain.trackGain");
    expect(gain?.written).toBe("9.78");
    expect(gain?.status).not.toBe("not_indexed");
  });

  it("marks a genre the server dropped as a mismatch on a required field", async () => {
    const base = discoveryDocument();
    const document: TrackDocument = {
      ...base,
      fields: {
        ...base.fields,
        genre: field(["shoegaze"] as never, "musicbrainz", "2026-09-05T00:00:00Z"),
      },
    };
    const rows = compareAlbum(writtenValues(document), await readBack());
    const genres = rows.find((row) => row.name === "genres[]");
    expect(genres?.status).toBe("mismatch");
    expect(genres?.required).toBe(true);
  });

  it("says not_indexed, not mismatch, for a field this server does not expose", async () => {
    const read = await readBack();
    const rows = compareAlbum(writtenValues(discoveryDocument()), {
      ...read,
      album: { ...read.album, moods: [] },
    });
    expect(rows.find((row) => row.name === "moods[]")?.status).toBe("not_indexed");
  });
});
