/**
 * `bun run --cwd packages/domain tagmap --format vorbis|id3|mp4|picard|navidrome`
 *
 * Prints the tag map. There is no other way to see it: the table lives in TypeScript, and the
 * documentation in `docs/03-metadonnees.md` §2 is what it is checked against
 * (`src/tagmap/tags.doc.test.ts`).
 *
 *   --format vorbis|id3|mp4   one line per tag: key, field, level, flags, source
 *   --format picard           a Picard tagger script writing the same superset
 *   --format navidrome        the map rendered as a Navidrome-style mappings.yaml
 */

import {
  exportFormatTable,
  exportNavidromeMappings,
  exportPicardScript,
} from "../src/tagmap/export.ts";
import type { TagFormat } from "../src/tagmap/tags.ts";

const FORMATS = ["vorbis", "id3", "mp4", "picard", "navidrome"] as const;
type Format = (typeof FORMATS)[number];

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

function parseFormat(argv: readonly string[]): Format {
  const index = argv.findIndex((argument) => argument === "--format" || argument === "-f");
  const raw = index === -1 ? undefined : argv[index + 1];
  if (raw === undefined) {
    console.error(`usage: tagmap --format ${FORMATS.join("|")}`);
    process.exit(2);
  }
  if (!isFormat(raw)) {
    console.error(`unknown format: ${raw}\nusage: tagmap --format ${FORMATS.join("|")}`);
    process.exit(2);
  }
  return raw;
}

const TAG_FORMATS: Readonly<Record<"vorbis" | "id3" | "mp4", TagFormat>> = {
  vorbis: "vorbis",
  id3: "id3v24",
  mp4: "mp4",
};

const format = parseFormat(process.argv.slice(2));

const output =
  format === "picard"
    ? exportPicardScript()
    : format === "navidrome"
      ? exportNavidromeMappings()
      : exportFormatTable(TAG_FORMATS[format]);

process.stdout.write(output);
