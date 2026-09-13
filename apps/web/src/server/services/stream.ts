/**
 * Serving one audio file out of the library, to one browser, with seeking.
 *
 * The library is a directory on the host and a browser cannot read it, so playing a track we
 * own needs the same kind of endpoint `api.cover.ts` gives a cover — with one difference that
 * is the whole reason this module exists: **an `<audio>` element seeks with HTTP `Range`**.
 * Answer 200 with the whole body and Chromium will play from the start and refuse to move the
 * cursor; answer 206 with a `Content-Range` and the scrub bar works. So the range parsing is
 * here, tested on its own, rather than improvised in a route handler.
 *
 * Two rules hold the security side:
 *
 *  - the caller gives a **track id**, never a path, exactly as the cover endpoint does; and
 *  - `resolveInLibrary` still refuses anything that resolves outside the library root, because
 *    a row's `path` column is only as trustworthy as whatever last wrote it, and "it came from
 *    the database" is the reasoning every traversal bug has been built on.
 *
 * Pure functions plus one `fs` read. No database here: the caller resolves the row.
 */
import { createReadStream, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { hostPath, toPosix, type PathMap } from "#/server/paths.ts";

/**
 * What we tell the browser a file is.
 *
 * Opus is the one worth getting right: the library's own format is `.opus`, and it is an Ogg
 * container, so `audio/ogg` is what Chromium and Firefox both accept. `audio/opus` is not a
 * registered type and Safari treats an unknown one as "cannot play".
 */
export const AUDIO_TYPES: Readonly<Record<string, string>> = {
  opus: "audio/ogg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  wv: "audio/x-wavpack",
};

export function audioContentType(path: string): string {
  const at = path.lastIndexOf(".");
  if (at === -1) return "application/octet-stream";
  return AUDIO_TYPES[path.slice(at + 1).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A library-relative path turned into an absolute host path, **or `null` if it escapes**.
 *
 * `..` segments, an absolute path, a UNC path and a Windows drive letter are all refused. The
 * check is done on the resolved result rather than on the input's spelling, so no encoding
 * trick survives it: whatever the string looked like, the answer is either inside the library
 * root or it is nothing.
 */
export function resolveInLibrary(map: PathMap, relativePath: string): string | null {
  const clean = toPosix(relativePath).trim();
  if (clean === "") return null;
  if (isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.startsWith("//")) return null;

  const root = resolve(map.host);
  const candidate = resolve(hostPath(map, clean));
  const inside = relative(root, candidate);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  return candidate;
}

/** A byte interval, inclusive at both ends, as `Range` means it. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse a single-range `Range` header against a known size.
 *
 * `undefined` means "no range asked for" (send 200), `null` means "asked for something this
 * file cannot satisfy" (send 416). Multi-range requests are answered as if no range had been
 * asked: no browser's audio element sends one, and a wrong multipart body is worse than a
 * whole file.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | undefined {
  if (header === null || header.trim() === "") return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;

  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return undefined;

  if (rawStart === "") {
    // `bytes=-500`: the last 500 bytes.
    const wanted = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(wanted) || wanted <= 0) return null;
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = rawEnd === "" ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** What the route needs to know about the file it is about to send. */
export interface StreamFile {
  /** Absolute host path. Already proven to be inside the library. */
  readonly file: string;
  readonly contentType: string;
}

/**
 * The response for one file and one request: 200, 206 or 416.
 *
 * The body is a stream rather than a buffer on purpose — a FLAC album track is thirty
 * megabytes and a seek asks for a slice of it, so reading the whole file to answer a
 * `bytes=28000000-` would be both slow and silly.
 */
export function fileResponse(request: Request, target: StreamFile): Response {
  const stats = statSync(target.file);
  const size = stats.size;
  const etag = `W/"${size.toString(16)}-${stats.mtimeMs.toString(16)}"`;

  const common: Record<string, string> = {
    "Content-Type": target.contentType,
    "Accept-Ranges": "bytes",
    ETag: etag,
    // Private: it is the owner's library, not something a proxy may keep for anyone.
    "Cache-Control": "private, max-age=0, must-revalidate",
  };

  if (request.headers.get("if-none-match") === etag && request.headers.get("range") === null) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const range = parseRange(request.headers.get("range"), size);
  if (range === null) {
    return new Response("range not satisfiable", {
      status: 416,
      headers: { ...common, "Content-Range": `bytes */${String(size)}` },
    });
  }

  if (request.method === "HEAD") {
    return new Response(null, { headers: { ...common, "Content-Length": String(size) } });
  }

  if (range === undefined) {
    return new Response(bodyOf(target.file, 0, size - 1), {
      headers: { ...common, "Content-Length": String(size) },
    });
  }

  return new Response(bodyOf(target.file, range.start, range.end), {
    status: 206,
    headers: {
      ...common,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
    },
  });
}

/**
 * The whole of `GET /api/stream`, minus the session check and the database.
 *
 * The route is four lines because this is where the behaviour is, and this is where it is
 * testable: `resolve` is the only thing that needs a row, so a test can hand it a temporary
 * file and prove the 400, the 404, the 206 and the `Content-Range` without a container.
 */
export async function streamResponse(
  request: Request,
  resolve: (trackId: string) => Promise<StreamFile | null>,
): Promise<Response> {
  const trackId = new URL(request.url).searchParams.get("track") ?? "";
  if (trackId === "") return new Response("track id required", { status: 400 });

  const target = await resolve(trackId);
  if (target === null) return new Response("no playable file for this track", { status: 404 });

  return fileResponse(request, target);
}

function bodyOf(file: string, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    createReadStream(file, { start, end }),
  ) as unknown as ReadableStream<Uint8Array>;
}
