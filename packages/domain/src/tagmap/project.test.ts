import { describe, expect, it } from "vitest";

import { field, merge, type PerformerCredit, type TrackDocument } from "../metadata/document.ts";
import { creditFromRelation } from "../metadata/resolvers/relations.ts";
import { oneMoreTime } from "../testing/discovery.ts";
import { formatProjection, projectDocument } from "./project.ts";

const at = "2026-09-05T22:00:00.000Z";

function documentWith(fields: Record<string, ReturnType<typeof field>>): TrackDocument {
  return merge([{ fields }], { schemaVersion: 1 });
}

describe("PERFORMER rendering (§2.3)", () => {
  const performers: PerformerCredit[] = [
    { name: "Romanthony", role: "vocal" },
    { name: "Nile Rodgers", role: "guitar" },
  ];
  const document = documentWith({ performer: field(performers, "musicbrainz", at) });

  it("renders 'Name (role)' in Vorbis, one tag per credit", () => {
    const lines = projectDocument(document, "vorbis").filter((tag) => tag.key === "PERFORMER");
    expect(lines.map((line) => line.value)).toEqual([
      "Romanthony (vocal)",
      "Nile Rodgers (guitar)",
    ]);
  });

  it("puts the role in the frame name and the name in the value for ID3's TMCL", () => {
    const lines = projectDocument(document, "id3v24").filter((tag) => tag.field === "performer");
    expect(lines).toEqual([
      { key: "TMCL:vocal", value: "Romanthony", field: "performer" },
      { key: "TMCL:guitar", value: "Nile Rodgers", field: "performer" },
    ]);
  });

  it("drops the credits entirely in MP4, which has no atom for them", () => {
    expect(projectDocument(document, "mp4").filter((tag) => tag.field === "performer")).toEqual([]);
  });

  it("uses the instrument attribute as the role when MusicBrainz gives one", () => {
    const credit = creditFromRelation({
      "target-type": "artist",
      type: "instrument",
      attributes: ["guitar"],
      artist: { id: "a", name: "Nile Rodgers", "sort-name": "Rodgers, Nile" },
    });
    expect(credit).toMatchObject({ field: "performer", name: "Nile Rodgers", role: "guitar" });
  });

  it("falls back to the relation type when there is no attribute", () => {
    const credit = creditFromRelation({
      "target-type": "artist",
      type: "vocal",
      attributes: [],
      artist: { id: "b", name: "Romanthony" },
    });
    expect(credit).toMatchObject({ field: "performer", role: "vocal" });
  });
});

describe("roles Picard does not map (§2.3)", () => {
  it("sends a performance role to PERFORMER", () => {
    const credit = creditFromRelation({
      "target-type": "artist",
      type: "programming",
      artist: { id: "c", name: "Someone" },
    });
    expect(credit).toMatchObject({ field: "performer", role: "programming" });
  });

  it("keeps a non-performance role out of the projection entirely", () => {
    for (const type of ["art direction", "photography", "booking", "misc", "design"]) {
      expect(
        creditFromRelation({ "target-type": "artist", type, artist: { name: "X" } }),
      ).toBeNull();
    }
  });

  it("does not silently invent a tag for such a role", () => {
    // The Discovery release credits art direction and photography; neither may appear anywhere.
    const projected = formatProjection(projectDocument(oneMoreTime(), "vorbis"));
    expect(projected).not.toContain("Mitchell Feinberg"); // photography
    expect(projected).not.toContain("Cédric Hervet"); // art direction
    // Mastering, on the other hand, is an engineer sub-role and must be present.
    expect(projected).toContain("ENGINEER=Nilesh Patel");
  });
});

describe("multi-valued fields", () => {
  it("repeats the key once per value in every format", () => {
    const document = documentWith({ genre: field(["house", "electronic"], "musicbrainz", at) });
    expect(projectDocument(document, "vorbis").map((tag) => `${tag.key}=${tag.value}`)).toEqual([
      "GENRE=house",
      "GENRE=electronic",
    ]);
    expect(projectDocument(document, "id3v24").map((tag) => tag.value)).toEqual([
      "house",
      "electronic",
    ]);
    expect(projectDocument(document, "mp4").map((tag) => tag.value)).toEqual([
      "house",
      "electronic",
    ]);
  });

  it("keeps document order, which is MusicBrainz credit order", () => {
    const document = documentWith({ artists: field(["B", "A", "C"], "musicbrainz", at) });
    expect(projectDocument(document, "vorbis").map((tag) => tag.value)).toEqual(["B", "A", "C"]);
  });
});

describe("scalar rendering", () => {
  it("writes a boolean as 1", () => {
    const document = documentWith({ compilation: field(true, "musicbrainz", at) });
    expect(projectDocument(document, "vorbis")[0]?.value).toBe("1");
  });

  it("escapes newlines so a golden file stays line-oriented", () => {
    const document = documentWith({
      lyrics: field({ synced: "[00:01.00] a\n[00:02.00] b", plain: null }, "lrclib", at),
    });
    expect(formatProjection(projectDocument(document, "vorbis"))).toBe(
      "LYRICS=[00:01.00] a\\n[00:02.00] b",
    );
  });
});

describe("projection order", () => {
  it("follows the tag map, not the document's insertion order", () => {
    const shuffled = documentWith({
      genre: field(["house"], "musicbrainz", at),
      title: field("One More Time", "musicbrainz", at),
      album: field("Discovery", "musicbrainz", at),
    });
    expect(projectDocument(shuffled, "vorbis").map((tag) => tag.key)).toEqual([
      "TITLE",
      "ALBUM",
      "GENRE",
    ]);
  });
});
