/**
 * Projection — layer 3 of `docs/03-metadonnees.md` §1: a document rendered into the key/value
 * pairs of one container format. The toolbox receives exactly this list and writes it with
 * mutagen; it knows nothing about MusicBrainz.
 *
 * The output is deterministic: tag-map order, then document order inside a multi-valued
 * field. That is what makes `golden/` files a meaningful regression test.
 */

import type {
  EmbeddedPicture,
  FieldValue,
  LyricsValue,
  PerformerCredit,
  TrackDocument,
} from "../metadata/document.ts";
import { keyFor, TAGS, type TagFormat } from "./tags.ts";

export interface ProjectedTag {
  readonly key: string;
  readonly value: string;
  /** The tag-map field this line came from — handy for diffs and for the Console. */
  readonly field: string;
}

/**
 * Fields the tag map gives a key in a format, but that the projection must not emit there
 * because another field already produces that exact key.
 *
 *  - `lyrics_synced` exists only to name ID3's SYLT frame; in Vorbis and MP4 the `lyrics`
 *    field already writes the same LRC to the same key.
 *  - `originalyear` shares ID3's TDOR with `originaldate`, which carries the full date.
 *  - `encodedby` shares MP4's `©too` with `encodersettings`, which is the more precise of
 *    the two — Picard does the same.
 */
const SUPPRESSED: Readonly<Record<TagFormat, readonly string[]>> = {
  vorbis: ["lyrics_synced"],
  id3v24: ["originalyear"],
  mp4: ["lyrics_synced", "encodedby"],
};

/**
 * Number/total pairs that ID3 and MP4 carry in a single "n/m" value, while Vorbis keeps them
 * in two separate keys (§2.1).
 */
const PAIRED: readonly {
  readonly number: string;
  readonly total: string;
  readonly formats: readonly TagFormat[];
}[] = [
  { number: "tracknumber", total: "totaltracks", formats: ["id3v24", "mp4"] },
  { number: "discnumber", total: "totaldiscs", formats: ["id3v24", "mp4"] },
  { number: "movementnumber", total: "movementtotal", formats: ["id3v24"] },
];

/** Fields carrying images. They are projected by `projectPictures`, never inline (§2.6). */
const PICTURE_FIELDS = ["front_cover", "back_cover"] as const;

/**
 * Project a document into `format`.
 *
 * Multi-valued fields produce one entry per value (a repeated Vorbis key, a repeated ID3
 * frame, a list element in MP4). `PERFORMER` renders as `Name (role)` in Vorbis and as a
 * `TMCL:role` / `Name` pair in ID3. Vorbis gets both `TRACKTOTAL` and `TOTALTRACKS`, as §2.1
 * demands. Images are excluded.
 */
export function projectDocument(
  document: TrackDocument,
  format: TagFormat,
): readonly ProjectedTag[] {
  const suppressed = new Set<string>([...SUPPRESSED[format], ...PICTURE_FIELDS]);
  const paired = PAIRED.filter((pair) => pair.formats.includes(format));
  for (const pair of paired) suppressed.add(pair.total);

  const out: ProjectedTag[] = [];

  for (const tag of TAGS) {
    if (suppressed.has(tag.field)) continue;
    const key = keyFor(tag, format);
    if (key === null) continue;
    const held = document.fields[tag.field];
    if (held === undefined) continue;

    const pair = paired.find((candidate) => candidate.number === tag.field);
    if (pair !== undefined) {
      const total = document.fields[pair.total];
      const number = renderScalar(held.value);
      out.push({
        key,
        value: total === undefined ? number : `${number}/${renderScalar(total.value)}`,
        field: tag.field,
      });
      continue;
    }

    if (tag.field === "performer") {
      out.push(...projectPerformers(held.value, key, format));
      continue;
    }

    for (const value of renderValues(held.value, format, tag.field)) {
      out.push({ key, value, field: tag.field });
    }
  }

  return out;
}

function projectPerformers(value: FieldValue, key: string, format: TagFormat): ProjectedTag[] {
  if (!isPerformerList(value)) return [];
  return value.map((credit) => ({
    // Vorbis puts the role in the value; ID3's TMCL puts it in the frame's role slot.
    key: format === "id3v24" ? `${key}:${credit.role}` : key,
    value: format === "id3v24" ? credit.name : `${credit.name} (${credit.role})`,
    field: "performer",
  }));
}

function renderValues(value: FieldValue, format: TagFormat, name: string): readonly string[] {
  if (isLyrics(value)) {
    // §2.6: LYRICS carries the synchronised LRC when LRCLIB has one, the plain text otherwise.
    // ID3 splits the row in two — USLT is unsynchronised by definition, so it takes the plain
    // text, and the separate `lyrics_synced` field carries the timestamps into SYLT.
    const text =
      name === "lyrics_synced"
        ? value.synced
        : format === "id3v24"
          ? (value.plain ?? value.synced)
          : (value.synced ?? value.plain);
    return text === null ? [] : [text];
  }
  if (Array.isArray(value)) {
    return (value as readonly FieldValue[]).map(renderScalar);
  }
  return [renderScalar(value)];
}

function renderScalar(value: FieldValue): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  // Objects never reach a scalar slot; render them stably rather than throwing mid-projection.
  return JSON.stringify(value);
}

/** The images to embed, front first (§2.6). Written as APIC/covr/METADATA_BLOCK_PICTURE. */
export function projectPictures(
  document: TrackDocument,
  format: TagFormat,
): readonly (EmbeddedPicture & {
  readonly key: string;
})[] {
  const out: (EmbeddedPicture & { key: string })[] = [];
  for (const name of PICTURE_FIELDS) {
    const tag = TAGS.find((candidate) => candidate.field === name);
    const held = document.fields[name];
    if (tag === undefined || held === undefined) continue;
    const key = keyFor(tag, format);
    if (key === null) continue;
    const value = held.value;
    if (!isPictureList(value)) continue;
    for (const picture of value) out.push({ ...picture, key });
  }
  return out;
}

/** Render a projection as the `KEY=value` text used by `golden/` and by the CLI. */
export function formatProjection(tags: readonly ProjectedTag[]): string {
  return tags.map((tag) => `${tag.key}=${escapeNewlines(tag.value)}`).join("\n");
}

/** Golden files are line-oriented, so an embedded newline is escaped rather than emitted. */
function escapeNewlines(value: string): string {
  return value.replace(/\r?\n/g, "\\n");
}

function isLyrics(value: FieldValue): value is LyricsValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "synced" in value;
}

function isPerformerList(value: FieldValue): value is readonly PerformerCredit[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null && "role" in item)
  );
}

function isPictureList(value: FieldValue): value is readonly EmbeddedPicture[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null && "kind" in item)
  );
}
