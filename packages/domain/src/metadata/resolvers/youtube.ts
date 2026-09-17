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

/**
 * The audio was taken over from a file on disk instead of being downloaded.
 *
 * Deleted videos, videos behind an age check, and a library being handed to this application
 * track by track: three cases where the entry below is still the right *identity* for the
 * track — the title, the description credits, the source URL — and where no byte of the file
 * came from YouTube. Saying "Source: youtu.be/…" on such a file would be false in the one
 * field a human reads to find out where their music came from.
 */
export interface AdoptedFile {
  /** The name the file had when it was adopted. Basename, never a path. */
  readonly originalName: string;
  /** `YYYY-MM-DD`. */
  readonly adoptedOn: string;
}

export interface YouTubeResolverOptions {
  readonly fetchedAt: string;
  /** yt-dlp's own version string, written to `ENCODEDBY`. */
  readonly ytdlpVersion?: string;
  /** Application version, for the `COMMENT` stamp. */
  readonly appVersion: string;
  /** The instant of the import, as it appears in `COMMENT`. `YYYY-MM-DD`. */
  readonly importedOn: string;
  /** Present when the file was adopted from disk rather than downloaded. See `AdoptedFile`. */
  readonly adopted?: AdoptedFile;
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
  /*
   * `youtu.be/<id>` only when the entry really came from YouTube.
   *
   * A **folder import**'s entries are files: `webpage_url` is a `file://` URL and `id` is a
   * digest of the file's name, so the old unconditional `youtu.be/${entry.id}` would have
   * invented a video that does not exist and printed it in `COMMENT` — the one field a human
   * reads to find out where their music came from. The id is still perfectly good as an
   * identifier; it is simply not a YouTube one, and only `webpage_url` can say which.
   */
  const fromYouTube =
    entry.webpage_url === undefined || /(?:youtube\.com|youtu\.be)\//i.test(entry.webpage_url);
  const shortUrl = entry.id !== undefined && fromYouTube ? `youtu.be/${entry.id}` : url;
  const adopted = options.adopted;

  if (adopted !== undefined) {
    /*
     * An adopted file says so, in the field a person actually reads.
     *
     * The sentence names the file, the day, and the video the bytes are *not* from — because
     * "this came from somewhere else" and "this is which track it is" are two facts and the
     * owner needs both: a deleted video is exactly the case where the only remaining evidence
     * of what the track was is the id in this line.
     *
     * `MUSICMANAGER_SOURCEURL` below is deliberately left as the video's URL. It is the
     * machine-readable *identity* of the track — what the v1 reconciliation, the library scan
     * and the re-tag match on — and rewriting it to say "a file" would break every one of them
     * to restate something `COMMENT` has just said in words.
     */
    patch.set(
      "comment",
      `Adopted local file "${adopted.originalName}" on ${adopted.adoptedOn}` +
        // "not downloaded from <a file on the same disk>" is a sentence about nothing. The
        // clause exists to name the video the bytes are *not* from — which on a folder import
        // there never was, because the file itself is the source.
        (shortUrl === null || !fromYouTube ? "" : ` · not downloaded from ${shortUrl}`) +
        ` · imported ${options.importedOn} by Music Manager ${options.appVersion}`,
      { confidence: 1 },
    );
    // The file's own name, which is the honest answer here and is more use than `<id>.<ext>`:
    // on a take-over it is how the owner finds the track again in the library it came from.
    patch.set("originalfilename", adopted.originalName, { confidence: 1 });
    // Neither of these is knowable: nothing of ours encoded this file.
    patch.setOrNa("encodedby", undefined, "the file was adopted from disk, not downloaded");
    patch.setOrNa("encodersettings", undefined, "the file was adopted from disk, not downloaded");
  } else {
    if (shortUrl !== null) {
      patch.set(
        "comment",
        `Source: ${shortUrl} · imported ${options.importedOn} by Music Manager ${options.appVersion}`,
        { confidence: 1 },
      );
    }
    if (entry.id !== undefined && entry.ext !== undefined) {
      patch.set("originalfilename", `${entry.id}.${entry.ext}`, { confidence: 1 });
    }
    patch.setOrNa(
      "encodedby",
      options.ytdlpVersion,
      "the download did not report a yt-dlp version",
    );
    patch.setOrNa("encodersettings", encoderSettings(entry), "yt-dlp reported no format details");
  }

  patch.set("musicmanager_sourceurl", url, { confidence: 1 });

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
