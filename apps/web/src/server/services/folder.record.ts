/**
 * What `import_tracks.raw` remembers about a file a **folder import** listed.
 *
 * `raw` is the source entry, kept verbatim (`docs/03-metadonnees.md` § raw cache), and it is
 * what `services/documents.ts` rebuilds a track's metadata document from — months later, with
 * no network. For a YouTube import that entry is yt-dlp's; for a folder import there is no
 * yt-dlp, so the entry is built by `services/folder-source.ts` out of what ffprobe read, and
 * this record is the part of it that is *about the file rather than about the music*: where it
 * was, what container it is in, and every tag it already carried.
 *
 * Two readers, which is why it is a record and not four loose keys:
 *
 *  - **`download`** reads `path` and adopts the file instead of fetching a byte
 *    (`services/jobs/steps/download.ts`). That is the whole of "each file is adopted rather
 *    than downloaded";
 *  - **anything rebuilding the document** reads `tags`, which is the source's own metadata and
 *    therefore what the `untagged` fallback has to work from when MusicBrainz knows nothing.
 *
 * A sibling key of `mm_adoption`, not a replacement for it. `mm_adoption` says *the bytes were
 * taken over from disk*, and `adopt.ts` writes it when it actually copies them; this one says
 * *which file, and what it already said about itself*, and `resolve` writes it before anything
 * has been copied. Both end up in the same `raw`, and `COMMENT` / `ORIGINALFILENAME` come from
 * the first (`packages/domain/.../resolvers/youtube.ts`).
 *
 * Its own module, and a very small one, for the reason `adopt.record.ts` gives: the writer and
 * the readers sit on opposite sides of the job machine, and one tiny module with no imports
 * but zod is the cheapest way for that not to be a cycle.
 */
import { z } from "zod";

/** The key this record sits under inside `import_tracks.raw`. Namespaced, like `mm_adoption`. */
export const FOLDER_FILE_KEY = "mm_file";

export const folderFileSchema = z.object({
  /**
   * Absolute path on **this server**, already `realpath`-resolved against `adoptSourceRoots`.
   *
   * Absolute, and it has to be: every path this application *stores in a column* is
   * library-relative (`CLAUDE.md` § Code style) because the library is the one directory both
   * sides of the bridge agree on — and a source folder is by definition outside it. This is
   * not such a column. It is a field of the verbatim source payload, next to the tags the file
   * carried, and it names a place on a disk rather than a place in the library.
   *
   * `download` re-checks it against the allow-list before opening it (`adoptTrackFile`), so a
   * row written when a root was allowed does not survive that root being withdrawn.
   */
  path: z.string().min(1),
  /** The file's own name. Basename, never a path — this is what `ORIGINALFILENAME` becomes. */
  name: z.string().min(1),
  /** The folder it was listed from, absolute. The import's own source, restated per track. */
  folder: z.string().min(1),
  /** `.opus`, `.flac`… lower-cased, with the dot. */
  container: z.string().min(1),
  bytes: z.number().int().min(0),
  /** What ffprobe called the audio codec, when it said anything. */
  codec: z.string().nullable(),
  /** Seconds, as ffprobe measured them — an exact duration, not YouTube's rounded one. */
  durationSeconds: z.number().nullable(),
  /**
   * Every tag ffprobe reported, keys upper-cased — the file's own metadata, verbatim.
   *
   * Kept whole rather than reduced to the four fields the matcher reads, for the same reason
   * the yt-dlp payload is kept whole: it is the source data, and a rebuild in a year must be
   * able to see what a rebuild today saw. An existing library's files carry far more than four
   * fields — ISRC, MUSICBRAINZ_ALBUMID, COMPOSER, the publisher — and throwing them away at
   * listing time would make them unrecoverable without re-reading a disk that may be gone.
   */
  tags: z.record(z.string(), z.string()),
});

export type FolderFile = z.infer<typeof folderFileSchema>;

/**
 * Read the folder-file record out of a `raw` payload, or `null` when the track is a video.
 *
 * Parsed rather than cast even though we wrote it ourselves: a row from an older version has
 * no such key, and a row from a *newer* one may have a shape this build does not know. Both
 * must read as "not a folder file I can use" instead of throwing inside a step.
 */
export function folderFileOf(raw: unknown): FolderFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const held = (raw as Record<string, unknown>)[FOLDER_FILE_KEY];
  if (held === undefined) return null;
  const parsed = folderFileSchema.safeParse(held);
  return parsed.success ? parsed.data : null;
}
