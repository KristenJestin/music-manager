/**
 * Renderings of the tag map for humans.
 *
 * These exports exist for documentation and for cross-checking against the two references we
 * follow — Picard's tag table and Navidrome's `mappings.yaml`. **Production never reads
 * them**: the pipeline projects a document with `projectDocument` and hands the result to the
 * toolbox. Both functions are pure and deterministic so their output can be diffed in CI.
 */

import { PROFILES, type ConsumerProfile } from "./profiles.ts";
import { TAGS, type TagDefinition, type TagFormat } from "./tags.ts";

/** Picard variable name for a field, when Picard has one under a different spelling. */
const PICARD_VARIABLE: Readonly<Record<string, string>> = {
  totaltracks_alias: "totaltracks",
  totaldiscs_alias: "totaldiscs",
  musicbrainz_recordingid: "musicbrainz_recordingid",
  musicbrainz_releasetrackid: "musicbrainz_trackid",
  musicbrainz_albumid: "musicbrainz_albumid",
  musicbrainz_releasegroupid: "musicbrainz_releasegroupid",
  musicbrainz_artistid: "musicbrainz_artistid",
  musicbrainz_albumartistid: "musicbrainz_albumartistid",
  musicbrainz_workid: "musicbrainz_workid",
  albumcomment: "_releasecomment",
  explicit: "_explicit",
  front_cover: "_coverart",
  back_cover: "_coverart",
  lyrics_synced: "lyrics",
};

/** Fields no Picard variable can supply — they come from us or from a non-MusicBrainz source. */
const NOT_IN_PICARD = new Set([
  "musicmanager_tagschema",
  "musicmanager_importid",
  "musicmanager_sourceurl",
  "encodersettings",
  "originalfilename",
  "r128_track_gain",
  "r128_album_gain",
  "replaygain_track_range",
  "replaygain_album_range",
  "replaygain_reference_loudness",
  "musicbrainz_originalalbumid",
  "musicbrainz_originalartistid",
  "key",
]);

/**
 * A Picard tagger script that writes our superset from Picard's own variables. Paste it into
 * Picard to compare, by hand, what Picard would produce with what we produce.
 */
export function exportPicardScript(): string {
  const lines: string[] = [
    "$noop(",
    "  Music Manager — superset tag script, generated from packages/domain/src/tagmap/tags.ts.",
    "  Documentation and cross-checking only: the importer does not run Picard.",
    `  ${TAGS.length} fields, of which ${TAGS.filter((tag) => NOT_IN_PICARD.has(tag.field)).length} have no Picard variable.`,
    ")",
    "",
  ];

  let group = "";
  for (const tag of TAGS) {
    if (tag.group !== group) {
      group = tag.group;
      lines.push(`$noop(--- ${group} ---)`);
    }
    if (NOT_IN_PICARD.has(tag.field)) {
      lines.push(`$noop(${tag.vorbis}: written by Music Manager — ${tag.source})`);
      continue;
    }
    const variable = PICARD_VARIABLE[tag.field] ?? tag.field;
    lines.push(`$set(${tag.vorbis},%${variable}%)`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * A `mappings.yaml`-shaped rendering of the tag map, in Navidrome's own vocabulary: for each
 * field, the keys a server would have to accept in the three formats. Compare it against the
 * `resources/mappings.yaml` of the deployed Navidrome to see what it will and will not index.
 */
export function exportNavidromeMappings(): string {
  const navidrome = PROFILES.find((profile) => profile.id === "navidrome");
  const reads = new Set(navidrome?.reads ?? []);

  const lines: string[] = [
    "# Music Manager — tag map rendered as Navidrome mappings.",
    "# Generated from packages/domain/src/tagmap/tags.ts; documentation only, never loaded.",
    `# ${TAGS.length} fields, ${reads.size} of them read by the Navidrome profile.`,
    "main:",
  ];

  for (const tag of TAGS) {
    lines.push(`  ${tag.field}:`);
    lines.push(`    aliases: [${aliasesOf(tag).map(quote).join(", ")}]`);
    lines.push(`    type: ${tag.multi ? "list" : "string"}`);
    lines.push(`    level: ${tag.level}`);
    lines.push(`    albumScope: ${String(tag.albumScope)}`);
    lines.push(`    indexed: ${String(reads.has(tag.field))}`);
  }

  return `${lines.join("\n")}\n`;
}

function aliasesOf(tag: TagDefinition): readonly string[] {
  return [tag.vorbis, tag.id3, tag.mp4].filter((key): key is string => key !== null);
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** One line per tag that exists in `format` — the table the `tagmap` CLI prints. */
export function exportFormatTable(format: TagFormat): string {
  const rows = TAGS.flatMap((tag) => {
    const key = format === "vorbis" ? tag.vorbis : format === "id3v24" ? tag.id3 : tag.mp4;
    if (key === null) return [];
    const flags = [tag.multi ? "multi" : "", tag.albumScope ? "album" : ""].filter(Boolean).join(",") || "-";
    return [[key, tag.field, tag.level, flags, tag.source] as const];
  });

  const width = Math.max(...rows.map((row) => row[0].length));
  return `${rows
    .map((row) => `${row[0].padEnd(width)}  ${row[1].padEnd(30)} ${row[2].padEnd(12)} ${row[3].padEnd(12)} ${row[4]}`)
    .join("\n")}\n`;
}

/** A one-line summary of a profile, for the CLI and the Console's “visible in X” list. */
export function describeProfile(profile: ConsumerProfile): string {
  return `${profile.name} (${profile.status}): reads ${String(profile.reads.length)} of ${String(TAGS.length)} fields via ${profile.via}`;
}
