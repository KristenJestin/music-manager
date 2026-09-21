/**
 * Special-purpose artists in *relations* — `[traditional]`, `[unknown]`, `[no artist]` reaching a
 * credit field (issue #19).
 *
 * #18 filtered the artist credits; the credits derived from relations (`COMPOSER`, `WRITER`,
 * `PERFORMER`…) went through `creditFromRelation`, which never looked at the artist's MBID — so a
 * folk song came out of the resolver as `COMPOSER=[traditional]`, with a `MUSICBRAINZ_COMPOSERID`
 * pointing at a placeholder. Each scenario of the issue's `Spec · metadata.resolve` is one test
 * below, named after it, and every input is the recorded Discovery fixture with one relation
 * changed — so the assertions are facts about real MusicBrainz data.
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
  joinArtistCredit,
  type MbArtistCreditEntry,
  type MbRelation,
  type MbRelease,
} from "./resolvers/index.ts";
import { SPECIAL_PURPOSE_ARTIST_REASON, SPECIAL_PURPOSE_LABEL_REASON } from "./special-purpose.ts";

const at = FETCHED_AT;

/* The MBIDs the Special_Purpose_Artist / Special_Purpose_Label documents give. */
const TRADITIONAL = "9be7f096-97ec-4615-8957-8d40b5dcbc41";
const UNKNOWN_ARTIST = "125ec42a-7229-4250-afc5-e057484327fe";
const NO_LABEL = "157afde4-4bf5-4039-8ad2-5a15acc85176";
/* Real entities the fixture already carries: Daft Punk's two members, and Discovery's label. */
const BANGALTER = "122a2714-24f8-4046-a532-64064b5076d2";
const GUY_MANUEL = "83886397-adf2-431a-b841-dc4af744a6cc";
const PIAS = "da314fb6-6f98-4ac6-8ef1-890fc5ddf4e0";

/** One artist relation, the shape MusicBrainz returns for a mapped or a performance role. */
function artistRelation(
  type: string,
  id: string,
  name: string,
  attributes?: readonly string[],
): MbRelation {
  return {
    type,
    "target-type": "artist",
    ...(attributes === undefined ? {} : { attributes }),
    artist: { id, name, "sort-name": name },
  };
}

/** `[traditional]` is where MusicBrainz puts the writer of a folk song, a hymn, a carol. */
const traditionalWriter = artistRelation("writer", TRADITIONAL, "[traditional]");
const bangalterComposer = artistRelation("composer", BANGALTER, "Thomas Bangalter");

const unknownArtist: MbArtistCreditEntry = {
  name: "[unknown]",
  artist: { id: UNKNOWN_ARTIST, name: "[unknown]", "sort-name": "[unknown]" },
};

function credited(name: string, id: string, joinphrase?: string): MbArtistCreditEntry {
  return joinphrase === undefined
    ? { name, artist: { id, name, "sort-name": name } }
    : { name, joinphrase, artist: { id, name, "sort-name": name } };
}

/** The recording with another relation list; the rest of the fixture is untouched. */
function recordingWith(relations: readonly MbRelation[]) {
  return { ...recording, relations };
}

function recordingPatch(relations: readonly MbRelation[]) {
  return fromMusicBrainzRecording(recordingWith(relations), { fetchedAt: at });
}

/**
 * Discovery's track 1, with the recording's relation list replaced. No `work` is passed, so the
 * credits come from that list alone — which is what these scenarios are about.
 */
function documentOf(relations: readonly MbRelation[]) {
  return resolveTrackDocument({
    release: { data: release, fetchedAt: at, trackPosition: 1 },
    recording: { data: recordingWith(relations), fetchedAt: at },
    app: {
      importId: IMPORT_ID,
      sourceUrl: video.webpage_url ?? "",
      tagSchemaVersion: 1,
      fetchedAt: at,
    },
  });
}

/** The Discovery release with another `label-info`; everything else stays the fixture's. */
function withLabelInfo(labelInfo: MbRelease["label-info"]): MbRelease {
  return { ...release, "label-info": labelInfo };
}

function releasePatch(value: MbRelease) {
  return fromMusicBrainzRelease(value, { trackPosition: 1, fetchedAt: at });
}

describe("special-purpose artists never become relation credits", () => {
  it("a traditional song", () => {
    const patch = recordingPatch([traditionalWriter]);

    expect(patch.fields?.["writer"]).toBeUndefined();
    expect(patch.na?.["writer"]?.reason).toBe(SPECIAL_PURPOSE_ARTIST_REASON);
    // `[traditional]` is why there is no composer either: the list named nobody, and the reason
    // says that rather than “no such credit relation on the recording” (D19-01).
    expect(patch.na?.["composer"]?.reason).toBe(SPECIAL_PURPOSE_ARTIST_REASON);
    expect(patch.fields?.["musicbrainz_composerid"]).toBeUndefined();

    // Nothing is lost by it: a field nobody can fill is `n/a`, not missing (§6), so the score is
    // the one of a recording with no writer relation at all.
    const traditional = documentOf([traditionalWriter]);
    const absent = documentOf([]);
    const scored = trackCompleteness(traditional);
    const unscored = trackCompleteness(absent);
    expect(scored.score).toBe(unscored.score);
    expect(scored.earned).toBe(unscored.earned);
    expect(scored.na).toContain("writer");
    expect(scored.na).toContain("composer");
    expect(scored.missing).not.toContain("writer");
    // The recording is the last MusicBrainz word on those fields, so the document — what the
    // Console reads — carries the same reason the patch does.
    expect(traditional.na["writer"]?.reason).toBe(SPECIAL_PURPOSE_ARTIST_REASON);

    // And no format writes it: the projection, not only the patch.
    for (const field of ["composer", "writer", "musicbrainz_composerid"]) {
      const tag = tagByField(field);
      if (tag === undefined) throw new Error(`the tag map has no \`${field}\` field`);
      for (const format of TAG_FORMATS) {
        const key = keyFor(tag, format);
        expect(
          projectDocument(traditional, format).map((projected) => projected.key),
        ).not.toContain(key);
      }
    }
  });

  it("a real composer beside a traditional co-writer", () => {
    const patch = recordingPatch([bangalterComposer, traditionalWriter]);

    // The `[traditional]` row is dropped on its own: it does not take the real composer with it.
    expect(patch.fields?.["composer"]?.value).toEqual(["Thomas Bangalter"]);
    expect(patch.fields?.["writer"]).toBeUndefined();
    expect(patch.fields?.["musicbrainz_composerid"]?.value).toEqual([BANGALTER]);
  });

  it("an unknown performer", () => {
    // A guitar performance is the `instrument` relation with the instrument in its attributes —
    // there is no bare `guitar` relation type. The scenario's `Real Artist` is the fixture's own.
    const patch = recordingPatch([
      artistRelation("vocal", UNKNOWN_ARTIST, "[unknown]"),
      artistRelation("instrument", BANGALTER, "Thomas Bangalter", ["guitar"]),
    ]);

    expect(patch.fields?.["performer"]?.value).toEqual([
      { name: "Thomas Bangalter", role: "guitar", mbid: BANGALTER },
    ]);
    // `[unknown]` did not sing: the MBID list holds the guitar player and nobody else.
    expect(patch.fields?.["musicbrainz_performerid"]?.value).toEqual([BANGALTER]);
  });
});

describe("join phrases follow the discarded entry", () => {
  it("a discarded middle entry", () => {
    // A join phrase belongs to the entry before it and goes only with the entry after it: the
    // “feat.” joined `[unknown]` and goes with it, the “&” joins A to B and stays.
    expect(
      joinArtistCredit([
        credited("A", BANGALTER, " feat. "),
        { ...unknownArtist, joinphrase: " & " },
        credited("B", GUY_MANUEL),
      ]),
    ).toBe("A & B");
  });

  it("a discarded last entry", () => {
    expect(joinArtistCredit([credited("A", BANGALTER, " & "), unknownArtist])).toBe("A");
  });
});

describe("the label reason is exact", () => {
  it("empty-named rows beside a special row", () => {
    const patch = releasePatch(
      withLabelInfo([
        { "catalog-number": "PIASR 001" },
        { "catalog-number": null, label: { id: NO_LABEL, name: "[no label]" } },
      ]),
    );

    expect(patch.fields?.["label"]).toBeUndefined();
    expect(patch.na?.["label"]?.reason).toBe(SPECIAL_PURPOSE_LABEL_REASON);
  });

  it("a real label beside a special row", () => {
    const patch = releasePatch(
      withLabelInfo([
        { "catalog-number": null, label: { id: NO_LABEL, name: "[no label]" } },
        { "catalog-number": "V 2940", label: { id: PIAS, name: "[PIAS]" } },
      ]),
    );

    expect(patch.fields?.["label"]?.value).toEqual(["[PIAS]"]);
    expect(patch.na?.["label"]).toBeUndefined();
  });

  it("ignores a row with no name on both sides (D19-03)", () => {
    // The one case D19-03 moves: a `[no label]` row that carries no name is not a reason of its
    // own, because a nameless row is ignored when the release's label is decided — so the answer
    // is the one of a release with no `label-info` at all.
    const patch = releasePatch(withLabelInfo([{ label: { id: NO_LABEL } }]));

    expect(patch.fields?.["label"]).toBeUndefined();
    expect(patch.na?.["label"]?.reason).toBe("the release carries no label");
  });
});
