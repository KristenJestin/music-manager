/**
 * What `import_tracks.raw` remembers about a file that was adopted rather than downloaded.
 *
 * `raw` is the yt-dlp entry, kept verbatim (`docs/03-metadonnees.md` § raw cache), and it is
 * what `services/documents.ts` rebuilds a track's metadata document from — months later, with
 * no network, which is what makes the background re-tag of §8 possible. So the fact that the
 * audio did **not** come from YouTube has to live in the same row: a provenance that is only
 * true until the next rebuild is not a provenance.
 *
 * It is a sibling key of the yt-dlp fields rather than a replacement for them. The video is
 * still the identity of the track — it is where the title, the description credits and the
 * `MUSICMANAGER_SOURCEURL` come from, and on a deleted or age-checked video it is still the
 * thing the owner is importing. What changed is only where the bytes came from, and `COMMENT`
 * is where a person reads that (see `packages/domain/.../resolvers/youtube.ts`).
 *
 * Its own module, and a very small one, because both `services/adopt.ts` (which writes it) and
 * `services/documents.ts` (which reads it) need it, and `adopt.ts` reaches the job machine
 * that `documents.ts` is reached *from*. One tiny module with no imports of its own is the
 * cheapest way for that not to be a cycle.
 */
import { z } from "zod";

/** The key this record sits under inside `import_tracks.raw`. Namespaced: yt-dlp owns the rest. */
export const ADOPTION_KEY = "mm_adoption";

export const adoptionSchema = z.object({
  /** RFC 3339. When the file was taken over. */
  adoptedAt: z.string().min(1),
  /** The file's own name when it was adopted — basename only, never a path. */
  originalName: z.string().min(1),
  /** How the bytes arrived: a path on the server, or an upload through the API. */
  via: z.enum(["path", "upload"]),
  /** Size of the adopted file, in bytes. */
  bytes: z.number().int().min(0),
  /** `.opus`, `.flac`… the container it was adopted in. */
  container: z.string().min(1),
  /** What ffprobe said the audio codec was, when it said anything. */
  codec: z.string().nullable(),
  /** Who asked: `console`, `api`, `cli adopt`, `mcp`. Same vocabulary as `confirmedBy`. */
  adoptedBy: z.string().min(1),
});

export type Adoption = z.infer<typeof adoptionSchema>;

/**
 * Read the adoption record out of a `raw` payload, or `null` when the track was downloaded.
 *
 * Parsed rather than cast even though we wrote it ourselves: a row from an older version has
 * no such key, and a row from a *newer* one may have a shape this build does not know. Both
 * must read as "no adoption record I can use" instead of throwing inside a document rebuild.
 */
export function adoptionOf(raw: unknown): Adoption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const held = (raw as Record<string, unknown>)[ADOPTION_KEY];
  if (held === undefined) return null;
  const parsed = adoptionSchema.safeParse(held);
  return parsed.success ? parsed.data : null;
}
