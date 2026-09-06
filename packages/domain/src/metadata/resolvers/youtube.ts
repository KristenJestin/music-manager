/**
 * yt-dlp entry → provenance fields (`docs/03-metadonnees.md` §2.6, §2.2).
 *
 * YouTube is where the audio comes from, so this is where `COMMENT`, `ORIGINALFILENAME` and
 * `ENCODEDBY` / `ENCODERSETTINGS` are written. It is also a *fallback* source of musical
 * metadata, through the auto-generated description: `COPYRIGHT` from the ℗ line, and
 * producer / composer / lyricist / performer credits when MusicBrainz has no relation. The
 * merge precedence puts MusicBrainz first, so those never override a real relation.
 */

import type { DocumentPatch, PerformerCredit } from "../document.ts";
import { parseYouTubeDescription } from "../../normalize/youtube-description.ts";
import { PatchBuilder } from "./patch.ts";

export interface YtdlpEntry {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly duration?: number;
  readonly uploader?: string;
  readonly channel?: string;
  readonly webpage_url?: string;
  readonly ext?: string;
  readonly format_id?: string;
  readonly acodec?: string;
  readonly abr?: number;
  readonly asr?: number;
  readonly track?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly release_year?: number;
  readonly playlist_index?: number | null;
}

export interface YouTubeResolverOptions {
  readonly fetchedAt: string;
  /** yt-dlp's own version string, written to `ENCODEDBY`. */
  readonly ytdlpVersion?: string;
  /** Application version, for the `COMMENT` stamp. */
  readonly appVersion: string;
  /** The instant of the import, as it appears in `COMMENT`. `YYYY-MM-DD`. */
  readonly importedOn: string;
}

/** The credit roles the description carries, mapped onto tag-map fields (§2.3). */
const DESCRIPTION_ROLE_FIELD: Readonly<Record<string, string>> = {
  composer: "composer",
  lyricist: "lyricist",
  writer: "writer",
  producer: "producer",
  "vocal producer": "producer",
  engineer: "engineer",
  "mixing engineer": "mixer",
  "recording engineer": "engineer",
  "mastering engineer": "engineer",
  "studio personnel": "engineer",
  arranger: "arranger",
  conductor: "conductor",
};

export function fromYouTubeEntry(
  entry: YtdlpEntry,
  options: YouTubeResolverOptions,
): DocumentPatch {
  const patch = new PatchBuilder("youtube", options.fetchedAt, 0.6);

  /* ---- provenance you can grep (§2.6) ---- */
  const url = entry.webpage_url ?? (entry.id === undefined ? null : `https://youtu.be/${entry.id}`);
  const shortUrl = entry.id === undefined ? url : `youtu.be/${entry.id}`;
  if (shortUrl !== null) {
    patch.set(
      "comment",
      `Source: ${shortUrl} · imported ${options.importedOn} by Music Manager ${options.appVersion}`,
      { confidence: 1 },
    );
  }
  patch.set("musicmanager_sourceurl", url, { confidence: 1 });

  if (entry.id !== undefined && entry.ext !== undefined) {
    patch.set("originalfilename", `${entry.id}.${entry.ext}`, { confidence: 1 });
  }
  patch.setOrNa("encodedby", options.ytdlpVersion, "the download did not report a yt-dlp version");
  patch.setOrNa("encodersettings", encoderSettings(entry), "yt-dlp reported no format details");

  /* ---- fallbacks read from the auto-generated description ---- */
  const parsed = parseYouTubeDescription(entry.description);

  /*
   * The YouTube Music tags themselves (P07a).
   *
   * yt-dlp lifts `track`, `artist`, `album` and `release_year` straight off a YouTube Music
   * entry, and until now they were read only by the *matcher* — the document ignored them,
   * because a matched import gets all four from MusicBrainz and the merge would drop them
   * anyway.
   *
   * "Import without MusicBrainz" is the case where nothing else provides them, and a document
   * with no TITLE is not a document: `place` would file every track of the album as
   * `Unknown Artist/Unknown Album/NN <video title>`. So they are resolved here, at this
   * resolver's low confidence, which means a real MusicBrainz value still wins every time —
   * the precedence of §1 has not changed, only the fallback has stopped being empty.
   *
   * `title` falls back to the video title, and `artist` to the uploader, because a channel
   * name is a worse answer than an artist tag and a better one than nothing.
   */
  patch.set("title", entry.track ?? entry.title ?? null);
  patch.set("artist", entry.artist ?? entry.uploader ?? entry.channel ?? null);
  patch.set("albumartist", entry.artist ?? entry.uploader ?? entry.channel ?? null);
  patch.set("album", entry.album ?? null);
  if (entry.playlist_index !== undefined && entry.playlist_index !== null) {
    patch.set("tracknumber", entry.playlist_index);
  }
  // The description's release date is more precise than a bare year, so it wins below.
  if (entry.release_year !== undefined && (parsed === null || parsed.releasedOn === null)) {
    patch.set("date", String(entry.release_year));
    patch.set("originalyear", entry.release_year);
  }

  if (parsed === null) return patch.build();

  patch.set("copyright", parsed.copyright);
  patch.set("label", parsed.label === null ? null : [parsed.label]);
  if (parsed.releasedOn !== null) {
    patch.set("date", parsed.releasedOn);
    patch.set("releasedate", parsed.releasedOn);
  }
  if (parsed.year !== null) patch.set("originalyear", parsed.year);

  const byField = new Map<string, string[]>();
  for (const credit of parsed.credits) {
    const target = DESCRIPTION_ROLE_FIELD[credit.role.toLowerCase()];
    if (target === undefined) continue;
    const held = byField.get(target);
    if (held === undefined) byField.set(target, [credit.name]);
    else if (!held.includes(credit.name)) held.push(credit.name);
  }
  for (const [name, values] of byField) patch.set(name, values);

  const performers: PerformerCredit[] = parsed.performers.map((name) => ({
    name,
    role: "performer",
  }));
  patch.set("performer", performers);

  return patch.build();
}

/** `ENCODERSETTINGS` — the yt-dlp format that produced the file (§2.6). */
function encoderSettings(entry: YtdlpEntry): string | null {
  const parts = [
    entry.format_id === undefined ? null : `yt-dlp format ${entry.format_id}`,
    entry.acodec === undefined || entry.acodec === "none" ? null : entry.acodec,
    entry.abr === undefined ? null : `${String(Math.round(entry.abr))} kbps`,
    entry.asr === undefined ? null : `${String(entry.asr)} Hz`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}
