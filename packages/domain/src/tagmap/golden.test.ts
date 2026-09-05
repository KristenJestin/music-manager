/**
 * Golden projections for Discovery, track 1.
 *
 * `golden/discovery/01-one-more-time.{vorbis,id3,mp4}.txt` is the complete projection of the
 * document assembled from `fixtures/`, one `KEY=value` per line, in tag-map order. It is the
 * regression test for everything upstream of it at once: the resolvers, the merge, the tag
 * map and the projection. A change to any of them shows up as a reviewable diff.
 *
 * Regenerate after an intended change:
 *
 *     MM_UPDATE_GOLDEN=1 bun run --cwd packages/domain test
 *
 * and read the diff — that is the review. A schema bump goes with it (metadata/schema.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { oneMoreTime } from "../testing/discovery.ts";
import { goldenPath } from "../testing/fixtures.ts";
import { formatProjection, projectDocument, projectPictures } from "./project.ts";
import { TAG_FORMATS, type TagFormat } from "./tags.ts";

const UPDATE = process.env["MM_UPDATE_GOLDEN"] === "1";

const FILE_OF: Readonly<Record<TagFormat, string>> = {
  vorbis: "discovery/01-one-more-time.vorbis.txt",
  id3v24: "discovery/01-one-more-time.id3.txt",
  mp4: "discovery/01-one-more-time.mp4.txt",
};

function renderGolden(format: TagFormat): string {
  const document = oneMoreTime();
  const tags = formatProjection(projectDocument(document, format));
  const pictures = projectPictures(document, format)
    .map((picture) => `${picture.key}=<${picture.kind} ${picture.mimeType}> ${picture.url}`)
    .join("\n");
  // Images are projected apart from the text tags (§2.6); the golden file lists them last so
  // the text block above stays byte-comparable with what the toolbox receives.
  return `${tags}\n${pictures}\n`;
}

describe("golden projections — Discovery, track 1", () => {
  for (const format of TAG_FORMATS) {
    it(`matches golden/${FILE_OF[format]}`, () => {
      const actual = renderGolden(format);
      const path = goldenPath(FILE_OF[format]);

      if (UPDATE) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, actual, "utf8");
      }

      const expected = readFileSync(path, "utf8");
      expect(actual).toBe(expected);
    });
  }

  it("is deterministic: two projections of the same document are identical", () => {
    expect(renderGolden("vorbis")).toBe(renderGolden("vorbis"));
  });

  it("writes both TRACKTOTAL and TOTALTRACKS in Vorbis, and a single TRCK in ID3 (§2.1)", () => {
    const document = oneMoreTime();
    const vorbis = projectDocument(document, "vorbis");
    expect(vorbis.filter((tag) => tag.key === "TRACKTOTAL")).toHaveLength(1);
    expect(vorbis.filter((tag) => tag.key === "TOTALTRACKS")).toHaveLength(1);
    expect(vorbis.find((tag) => tag.key === "TRACKNUMBER")?.value).toBe("1");

    const id3 = projectDocument(document, "id3v24");
    const trck = id3.filter((tag) => tag.key === "TRCK");
    expect(trck).toHaveLength(1);
    expect(trck[0]?.value).toBe("1/14");
    expect(id3.find((tag) => tag.key === "TPOS")?.value).toBe("1/1");
  });

  it("keeps images out of the text projection (§2.6)", () => {
    const document = oneMoreTime();
    for (const format of TAG_FORMATS) {
      const keys = projectDocument(document, format).map((tag) => tag.key);
      expect(keys).not.toContain("METADATA_BLOCK_PICTURE");
      expect(keys).not.toContain("covr");
      expect(keys.some((key) => key.startsWith("APIC"))).toBe(false);
    }
    expect(projectPictures(document, "vorbis").map((picture) => picture.kind)).toEqual([
      "front",
      "back",
    ]);
  });

  it("drops the fields a format has no key for", () => {
    const document = oneMoreTime();
    const mp4 = projectDocument(document, "mp4").map((tag) => tag.field);
    // §2.3: PERFORMER and WRITER have no MP4 atom; §2.6: R128 is Opus-only.
    expect(mp4).not.toContain("performer");
    expect(mp4).not.toContain("writer");
    expect(mp4).not.toContain("r128_track_gain");
    expect(projectDocument(document, "vorbis").map((tag) => tag.field)).toContain(
      "r128_track_gain",
    );
  });
});
