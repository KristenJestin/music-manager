/**
 * Resized copies of the library's own pictures — what `/api/cover` and `/api/artist-image`
 * answer with when the caller asks for something smaller than the file on disk.
 *
 * A placed `cover.jpg` is 1200×1200 or larger, because that is the size worth keeping and the
 * size a player embeds. The Console never draws one at more than 160 CSS pixels outside an
 * album header, so every list used to pull a megabyte per tile for a 36 px square. This module
 * is the other half of that: the browser names a size, the server answers with a JPEG of that
 * size, and the expensive part happens once.
 *
 * ## The closed set
 *
 * `size` is one of **64, 160, 320, 640** or **original**, and nothing else. An arbitrary
 * integer would be a cache the first curious visitor could turn into ten thousand files and an
 * hour of Pillow; five values cannot be. The five are the ones the tiles actually need
 * (`components/cover.tsx`'s slot table), each already doubled for a 2× display.
 *
 * ## Where the variants live
 *
 * `<library>/.mm-cache/images/`, dot-prefixed for exactly the reason `.mm-work` and
 * `.mm-archive` are: Navidrome's scanner skips a directory whose name starts with a dot, so
 * the derived files are inside the mount both sides already share and outside the tree
 * Navidrome walks.
 *
 * The alternative — a `cover-320.jpg` beside the original — survives a restart just as well
 * and was rejected on what a real Navidrome does with it. Given a library of 8 artists and 24
 * albums, one of which held a `cover-320.jpg` next to its `cover.jpg`, its scanner logged
 * `imageCount=2` for that folder and wrote `folder.image_files = ["cover.jpg",
 * "cover-320.jpg"]`, while `.mm-cache/` never appeared in its `folder` table at all. So a
 * derived file beside the original is indexed, re-stat'd on every scan, and one custom
 * `ND_COVERARTPRIORITY` away from being the album art Feishin is served — four times over,
 * once per size. The library belongs to the owner and to the players that read it; our cache
 * does not belong in it.
 *
 * A dedicated Docker volume would work too, and costs a volume, a mount and a second path to
 * translate. The library mount is already there and already shared with the toolbox, which is
 * the process that does the resizing.
 *
 * ## The key
 *
 * `sha256(path | mtimeMs | bytes | size)`. The original's mtime and length are in it, so a
 * re-tag that rewrites `cover.jpg` produces a different key and the old variant is simply
 * never asked for again. Nothing has to invalidate anything.
 *
 * ## Who resizes
 *
 * The toolbox, through `POST /artwork/prepare`. Pillow lives there, the TypeScript side has no
 * image library at all, and inventing one to avoid a round trip would be the wrong trade: the
 * round trip happens **once per (picture, size)** and every request after it is a `readFile`
 * of a file that is already the right size. A grid of sixty albums costs sixty calls the first
 * time it is ever drawn and none of them afterwards. Concurrent callers asking for the same
 * key share one call (`inFlight`), so a page that mounts the same tile twice still resizes
 * once.
 *
 * A toolbox that is down or refuses the file is not an error here: `variantFor` answers `null`
 * and the endpoint falls back to the original bytes. A thumbnail is an optimisation; a broken
 * toolbox must not empty the Console of covers.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { hostPath, toToolbox, type PathMap } from "#/server/paths.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";

/** The widths a variant may be asked for, in CSS pixels × 2 for a retina display. */
export const IMAGE_VARIANT_SIZES = [64, 160, 320, 640] as const;

export type ImageVariantSize = (typeof IMAGE_VARIANT_SIZES)[number];

/** What the `size` query parameter accepts: one of the four, or the file as it is on disk. */
export const imageSizeSchema = z
  .enum(["64", "160", "320", "640", "original"])
  .default("original")
  .transform((value): ImageVariantSize | "original" =>
    value === "original" ? "original" : (Number(value) as ImageVariantSize),
  );

export type ImageSizeRequest = ImageVariantSize | "original";

/**
 * Read `?size=` off a URL.
 *
 * A missing parameter means `original`, so every link written before this existed keeps
 * answering exactly what it used to. Anything outside the set is a `400`, not a silent
 * rounding: a caller asking for 321 pixels has a bug, and answering 320 hides it.
 */
export function parseImageSize(raw: string | null | undefined): ImageSizeRequest | null {
  const parsed = imageSizeSchema.safeParse(raw ?? undefined);
  return parsed.success ? parsed.data : null;
}

/** Where the derived files go, relative to the library root. */
export const IMAGE_CACHE_DIR = ".mm-cache/images";

/** The source file a variant is derived from, as `placedCover` already describes it. */
export interface VariantSource {
  /** Absolute host path of the original. */
  readonly file: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/**
 * The cache entry's name for one (picture, size) pair.
 *
 * Deterministic and collision-proof in the only way that matters here: two different originals,
 * or the same original written twice, never share a name. The size is in the hash *and* in the
 * prefix, the second only so a human looking at the directory can tell what they are seeing.
 */
export function variantKey(source: VariantSource, size: ImageVariantSize): string {
  const digest = createHash("sha256")
    .update(
      [
        source.file.replaceAll("\\", "/").toLowerCase(),
        String(source.mtimeMs),
        String(source.bytes),
        String(size),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
  return `${String(size)}-${digest}.jpg`;
}

/** The resized JPEG a request can be answered with. */
export interface ImageVariant {
  /** Absolute host path of the derived file. */
  readonly file: string;
  readonly bytes: number;
  /**
   * Strong, and it can be: the name it is derived from already carries the original's mtime
   * and length, so two responses with this ETag are byte-identical by construction.
   */
  readonly etag: string;
  /** False when this call is what produced the file. */
  readonly cached: boolean;
}

/** One promise per key, so sixty tiles of the same album resize once and not sixty times. */
const inFlight = new Map<string, Promise<ImageVariant | null>>();

export interface VariantOptions {
  readonly source: VariantSource;
  readonly size: ImageVariantSize;
  readonly paths: PathMap;
  readonly toolbox?: ToolboxClient;
}

function readCached(file: string): ImageVariant | null {
  if (!existsSync(file)) return null;
  const stats = statSync(file);
  if (!stats.isFile() || stats.size === 0) return null;
  return { file, bytes: stats.size, etag: etagOf(file), cached: true };
}

function etagOf(file: string): string {
  return `"${file.replaceAll("\\", "/").split("/").pop() ?? file}"`;
}

/**
 * The resized JPEG for this picture at this size, generating it if it is not there yet.
 *
 * `null` means "serve the original instead" — a toolbox that is down, a file Pillow cannot
 * read, a cache directory that cannot be written. None of those is worth a 500 on a thumbnail.
 */
export async function variantFor(options: VariantOptions): Promise<ImageVariant | null> {
  const { source, size, paths } = options;
  const name = variantKey(source, size);
  const file = hostPath(paths, `${IMAGE_CACHE_DIR}/${name}`);

  const hit = readCached(file);
  if (hit !== null) return hit;

  const running = inFlight.get(file);
  if (running !== undefined) return await running;

  const work = generate(file, options).finally(() => {
    inFlight.delete(file);
  });
  inFlight.set(file, work);
  return await work;
}

async function generate(file: string, options: VariantOptions): Promise<ImageVariant | null> {
  const { source, size, paths } = options;
  const client = options.toolbox ?? defaultToolbox();
  try {
    const prepared = await client.prepareArtwork({
      path: toToolbox(paths, source.file),
      size,
      // Not square: cropping a thumbnail would show a different picture from the header above
      // it. `/artwork/prepare` only ever shrinks — an original smaller than the requested size
      // comes back untouched, which is the right answer for a 64 px request too.
      square: false,
      // 82 rather than 90: at 320 px and below the difference is invisible and the file is a
      // third smaller. The original on disk keeps its own quality; this is a derived copy.
      quality: 82,
    });
    const bytes = Buffer.from(prepared.data_base64, "base64");
    if (bytes.length === 0) return null;

    mkdirSync(hostPath(paths, IMAGE_CACHE_DIR), { recursive: true });
    // Temp file then rename: two requests for two sizes of the same cover run concurrently,
    // and a reader must never see a half-written JPEG. The rename is atomic on one filesystem.
    const temp = `${file}.${String(process.pid)}-${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, bytes);
    try {
      renameSync(temp, file);
    } catch {
      // A concurrent writer got there first on a platform that refuses to clobber. Its copy is
      // the same bytes by construction, so drop ours and read theirs.
      rmSync(temp, { force: true });
    }
    return { file, bytes: bytes.length, etag: etagOf(file), cached: false };
  } catch {
    return null;
  }
}

/** Test seam: the in-flight table is module state, and a suite may want it empty. */
export function resetImageVariants(): void {
  inFlight.clear();
}

/* ------------------------------------------------------------------ */
/* the HTTP answer                                                     */
/* ------------------------------------------------------------------ */

/**
 * Answer one picture request — the body of both `/api/cover` and `/api/artist-image`, which
 * differ only in how they find the file.
 *
 * ## Cache headers
 *
 * `private` on both, always: it is the owner's library, and no shared proxy may keep a copy
 * for anyone else.
 *
 * A **variant** gets a strong ETag and `max-age=300, must-revalidate`. The file on disk really
 * is immutable — its name contains the original's mtime — but the *URL* is not: it says
 * `?album=…&size=320`, with no version token in it, so `immutable` would pin a stale thumbnail
 * in the browser for as long as we dared claim, and a re-tag would show the old cover until
 * someone hard-reloaded. Five minutes of freshness plus a strong validator is the honest
 * version: a revalidation inside a session is a 304 with an empty body, and the server answers
 * it from a `stat`, having already done the resizing once, ever.
 *
 * The **original** keeps the weak ETag and the same window it has always had.
 */
export async function respondWithImage(options: {
  readonly request: Request;
  readonly placed: VariantSource & { readonly contentType: string; readonly etag: string };
  readonly size: ImageSizeRequest;
  readonly paths: PathMap;
  readonly toolbox?: ToolboxClient;
  /** Injected so the route module keeps `node:fs` out of the client boundary test's way. */
  readonly read: (file: string) => Promise<Buffer>;
}): Promise<Response> {
  const { request, placed, size, paths } = options;

  const variant =
    size === "original"
      ? null
      : await variantFor({ source: placed, size, paths, toolbox: options.toolbox });

  const etag = variant?.etag ?? placed.etag;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const file = variant?.file ?? placed.file;
  const bytes = await options.read(file);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": variant === null ? placed.contentType : "image/jpeg",
      "Content-Length": String(bytes.length),
      ETag: etag,
      "Cache-Control": "private, max-age=300, must-revalidate",
      // What actually came back, so a measurement (and a bug report) can tell a served
      // thumbnail from a silent fallback to the original.
      "X-MM-Image-Size": variant === null ? "original" : String(size),
    },
  });
}
