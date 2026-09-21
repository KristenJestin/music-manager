/**
 * `[no label]`, `[unknown]`, `[none]` — the rows MusicBrainz uses to say “there is no such
 * thing” (issue #6).
 *
 * Each scenario of the issue's Spec is one test below, named after it, and every input is the
 * recorded Discovery fixture with one thing changed — so the assertions are facts about real
 * MusicBrainz data, and a re-record that changes an answer fails loudly.
 *
 * The guideline is explicit that these are entities and not values: they have MBIDs, they are
 * documented, and the brackets are there to tell a human reading the database that the name is
 * not a name. `Various Artists` is the deliberate exception, and the last test says why.
 */

import { describe, expect, it } from "vitest";

import { trackCompleteness } from "../completeness/index.ts";
import { keyFor, tagByField, TAG_FORMATS } from "../tagmap/tags.ts";
import { projectDocument } from "../tagmap/project.ts";
import { FETCHED_AT, IMPORT_ID, recording, release, video } from "../testing/discovery.ts";
import { resolveTrackDocument } from "./resolve.ts";
import {
  fromMusicBrainzRecording,
  fromMusicBrainzRelease,
  type MbArtistCreditEntry,
  type MbRelease,
} from "./resolvers/index.ts";
import {
  isCatalogueNumberPlaceholder,
  isSpecialPurposeArtist,
  isSpecialPurposeLabel,
  specialPurposeEntity,
  SPECIAL_PURPOSE_ARTIST_REASON,
  SPECIAL_PURPOSE_LABEL_REASON,
} from "./special-purpose.ts";

const at = FETCHED_AT;

/* The MBIDs the Special_Purpose_Artist / Special_Purpose_Label documents give. */
const NO_LABEL = "157afde4-4bf5-4039-8ad2-5a15acc85176";
const UNKNOWN_ARTIST = "125ec42a-7229-4250-afc5-e057484327fe";
const VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377";
/* Real entities whose name happens to be bracketed — why D6-01 is keyed by MBID, not by a
 * pattern: `[PIAS]` is a label and `[adult swim]` is an artist. */
const PIAS = "da314fb6-6f98-4ac6-8ef1-890fc5ddf4e0";
const ADULT_SWIM = "13f3e8cb-7bda-4261-be4b-19dff00f87c1";

const unknownArtist: MbArtistCreditEntry = {
  name: "[unknown]",
  artist: { id: UNKNOWN_ARTIST, name: "[unknown]", "sort-name": "[unknown]" },
};

/** The Discovery release with another `label-info`; everything else stays the fixture's. */
function withLabelInfo(labelInfo: MbRelease["label-info"]): MbRelease {
  return { ...release, "label-info": labelInfo };
}

/** The Discovery release with another artist credit. */
function withCredit(credit: readonly MbArtistCreditEntry[]): MbRelease {
  return { ...release, "artist-credit": credit };
}

/** The Discovery release whose first track is credited to one artist entry. */
function withTrackCredit(credit: readonly MbArtistCreditEntry[]): MbRelease {
  const media = (release.media ?? []).map((medium, mediumIndex) =>
    mediumIndex !== 0
      ? medium
      : {
          ...medium,
          tracks: (medium.tracks ?? []).map((track, trackIndex) =>
            trackIndex !== 0 ? track : { ...track, "artist-credit": credit },
          ),
        },
  );
  return { ...release, media };
}

function releasePatch(value: MbRelease) {
  return fromMusicBrainzRelease(value, { trackPosition: 1, fetchedAt: at });
}

/** The document of Discovery's track 1, with one release replaced. */
function documentOf(value: MbRelease) {
  return resolveTrackDocument({
    release: { data: value, fetchedAt: at, trackPosition: 1 },
    recording: { data: recording, fetchedAt: at },
    app: {
      importId: IMPORT_ID,
      sourceUrl: video.webpage_url ?? "",
      tagSchemaVersion: 1,
      fetchedAt: at,
    },
  });
}

describe("the special-purpose table", () => {
  it("says which entity an MBID is, and for which kind", () => {
    expect(specialPurposeEntity(NO_LABEL)?.name).toBe("[no label]");
    expect(specialPurposeEntity(NO_LABEL)?.kind).toBe("label");
    expect(specialPurposeEntity(UNKNOWN_ARTIST)?.kind).toBe("artist");
    expect(isSpecialPurposeLabel(NO_LABEL)).toBe(true);
    expect(isSpecialPurposeArtist(UNKNOWN_ARTIST)).toBe(true);

    // The two kinds share one spelling: `[unknown]` is an artist *and* a label.
    expect(specialPurposeEntity(UNKNOWN_ARTIST)?.name).toBe("[unknown]");
    expect(isSpecialPurposeArtist(ADULT_SWIM)).toBe(false);
    expect(isSpecialPurposeLabel(PIAS)).toBe(false);
    expect(specialPurposeEntity(undefined)).toBeUndefined();
    expect(specialPurposeEntity("0f4b1a3e-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("takes `[none]` for what it is, and nothing else", () => {
    expect(isCatalogueNumberPlaceholder("[none]")).toBe(true);
    expect(isCatalogueNumberPlaceholder(" [None] ")).toBe(true);
    expect(isCatalogueNumberPlaceholder("none")).toBe(false);
    expect(isCatalogueNumberPlaceholder("8496062")).toBe(false);
  });
});

describe("special-purpose labels are not labels", () => {
  it("leaves `label` n/a on a self-released album, and keeps its catalogue number", () => {
    const patch = releasePatch(
      withLabelInfo([{ "catalog-number": "8496062", label: { id: NO_LABEL, name: "[no label]" } }]),
    );

    expect(patch.fields?.["label"]).toBeUndefined();
    expect(patch.na?.["label"]?.reason).toBe(SPECIAL_PURPOSE_LABEL_REASON);
    // The catalogue number describes the pressing, not the label: dropping one drops neither.
    expect(patch.fields?.["catalognumber"]?.value).toEqual(["8496062"]);
  });

  it("keeps a real label whose name is bracketed", () => {
    const patch = releasePatch(
      withLabelInfo([{ "catalog-number": "PIASR 001", label: { id: PIAS, name: "[PIAS]" } }]),
    );

    expect(patch.fields?.["label"]?.value).toEqual(["[PIAS]"]);
    expect(patch.na?.["label"]).toBeUndefined();
  });

  it("keeps the real label when a special-purpose one sits beside it", () => {
    const patch = releasePatch(
      withLabelInfo([
        { "catalog-number": null, label: { id: NO_LABEL, name: "[no label]" } },
        { "catalog-number": "V 2940", label: { id: PIAS, name: "[PIAS]" } },
      ]),
    );

    expect(patch.fields?.["label"]?.value).toEqual(["[PIAS]"]);
    expect(patch.na?.["label"]).toBeUndefined();
  });

  it("does not take `[none]` for a catalogue number", () => {
    const patch = releasePatch(
      withLabelInfo([{ "catalog-number": "[none]", label: { id: PIAS, name: "[PIAS]" } }]),
    );

    expect(patch.fields?.["catalognumber"]).toBeUndefined();
    expect(patch.na?.["catalognumber"]?.reason).toBe("the release has no catalogue number");
    expect(patch.fields?.["label"]?.value).toEqual(["[PIAS]"]);
  });
});

describe("special-purpose artists are not artists", () => {
  it("drops an unknown track credit, and says why", () => {
    const patch = releasePatch(withTrackCredit([unknownArtist]));

    expect(patch.fields?.["artist"]).toBeUndefined();
    expect(patch.na?.["artist"]?.reason).toBe(SPECIAL_PURPOSE_ARTIST_REASON);
    // The sort-name and the MBID come from that same credit: none of them is knowable.
    for (const field of ["artists", "artistsort", "musicbrainz_artistid"]) {
      expect(patch.na?.[field]?.reason).toBe(SPECIAL_PURPOSE_ARTIST_REASON);
    }
    expect(patch.na?.["artist"]?.reason).not.toBe("MusicBrainz has no artist on this track");
  });

  it("drops an unknown recording credit, and says why", () => {
    const patch = fromMusicBrainzRecording(
      { ...recording, "artist-credit": [unknownArtist] },
      { fetchedAt: at },
    );

    expect(patch.fields?.["artist"]).toBeUndefined();
    expect(patch.na?.["artist"]?.reason).toBe(SPECIAL_PURPOSE_ARTIST_REASON);
    // Everything else the recording states is untouched: only the credit was about nobody.
    expect(patch.fields?.["title"]?.value).toBe("One More Time");
  });

  it("keeps the real artist beside an unknown one, and leaves no dangling `&`", () => {
    const credited = release["artist-credit"]?.[0] ?? { name: "Daft Punk" };
    const patch = releasePatch(withCredit([{ ...credited, joinphrase: " & " }, unknownArtist]));

    // The join phrase belongs to the entry before it; `Daft Punk & ` is not an artist name.
    expect(patch.fields?.["albumartist"]?.value).toBe("Daft Punk");
    expect(patch.fields?.["albumartists"]?.value).toEqual(["Daft Punk"]);
    expect(patch.fields?.["musicbrainz_albumartistid"]?.value).toEqual([credited.artist?.id ?? ""]);
    expect(patch.na?.["albumartist"]).toBeUndefined();
  });

  it("keeps `Various Artists` on a compilation", () => {
    const patch = releasePatch(
      withCredit([
        {
          name: "Various Artists",
          artist: { id: VARIOUS_ARTISTS, name: "Various Artists", "sort-name": "Various Artists" },
        },
      ]),
    );

    expect(patch.fields?.["albumartist"]?.value).toBe("Various Artists");
    expect(patch.fields?.["compilation"]?.value).toBe(true);
    expect(patch.na?.["compilation"]).toBeUndefined();
  });
});

describe("the document says which kind of nothing it is", () => {
  it("scores a `[no label]` album exactly like one with no label-info at all", () => {
    const absent = documentOf({ ...release, "label-info": [] });
    const special = documentOf(
      withLabelInfo([{ "catalog-number": "[none]", label: { id: NO_LABEL, name: "[no label]" } }]),
    );

    // Two different facts — “MusicBrainz has no label for this” and “MusicBrainz says there is
    // no label” — and the document says which one it is.
    expect(absent.na["label"]?.reason).toBe("the release carries no label");
    expect(special.na["label"]?.reason).toBe(SPECIAL_PURPOSE_LABEL_REASON);

    // But the score is the same, which is the whole point: nobody is punished for a fact
    // nobody has (§6).
    const scored = trackCompleteness(special);
    const unscored = trackCompleteness(absent);
    expect(scored.score).toBe(unscored.score);
    expect(scored.earned).toBe(unscored.earned);
    expect(scored.na).toContain("label");
    expect(scored.missing).not.toContain("label");
    expect(scored.present).not.toContain("label");
  });

  it("writes neither LABEL nor CATALOGNUMBER", () => {
    const document = documentOf(
      withLabelInfo([{ "catalog-number": "[none]", label: { id: NO_LABEL, name: "[no label]" } }]),
    );

    for (const field of ["label", "catalognumber"]) {
      const tag = tagByField(field);
      if (tag === undefined) throw new Error(`the tag map has no \`${field}\` field`);
      for (const format of TAG_FORMATS) {
        const key = keyFor(tag, format);
        expect(projectDocument(document, format).map((projected) => projected.key)).not.toContain(
          key,
        );
      }
    }
  });

  it("feeds the four fields the tag map spells that way", () => {
    // `setArtistCredit` derives them from `artist`/`albumartist`; this is the assertion that the
    // derivation is the tag map's spelling and not a near miss.
    for (const field of [
      "artist",
      "artists",
      "artistsort",
      "musicbrainz_artistid",
      "albumartist",
      "albumartists",
      "albumartistsort",
      "musicbrainz_albumartistid",
    ]) {
      expect(tagByField(field), `${field} is a tag-map field`).toBeDefined();
    }
  });
});
