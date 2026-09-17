/**
 * What an import is *of* — and why that stopped being "a URL".
 *
 * Until now the only thing this application could import was a YouTube link, so the field on
 * the row was called `url`, the function was called `createFromUrl`, and the validation was a
 * regular expression that said "starts with `http://`, `https://` or `fixture://`". All three
 * were true and all three have just stopped being the whole truth: a **folder of audio files**
 * is now a source too, because of three cases the owner actually has and which no URL can
 * express any more —
 *
 *  - **twenty official playlists that have vanished from YouTube** (273 tracks). The listing
 *    fails at `resolve`, before a single track row exists, so there is nothing to adopt a file
 *    *into*;
 *  - **eight albums behind an age check**, which fail the same way;
 *  - **an existing library** whose files are simply already on the disk.
 *
 * The design is deliberately narrow: **the entries stop being videos and become files, and
 * nothing else in the pipeline changes.** A folder is listed the way a playlist is listed,
 * matching runs on those entries exactly as on videos — the same problem with better signals,
 * an exact duration and a fingerprint — and each file is *adopted* rather than downloaded.
 *
 * ## One string, two schemes
 *
 * The submitted source stays **one string in one column**, `imports.url`, because everything
 * built on that column keeps working for free: the duplicate report ("this folder is already
 * imported"), `GET /imports?url=`, the journal, the Console's paste box. A folder is stored as
 * a `file://` URL, which is what a filesystem path *is* on the wire, and
 * `D:\Musique\Discovery` typed by a human is canonicalised into one here.
 *
 * `folderPathOf` is the reverse, and it is the only way back to a host path: everything else
 * in the application treats `imports.url` as opaque.
 */
import { isAbsolute, resolve as resolvePath } from "node:path";
import { MMError } from "@mm/contracts";
import { toPosix } from "#/server/paths.ts";

/** The URL schemes that name something to fetch over the network (or a recording of one). */
const REMOTE_SHAPE = /^(?:https?:\/\/|fixture:\/\/)/i;

/** `file://` — the scheme a folder on this server is stored under. */
export const FOLDER_SCHEME = "file://";

/** A Windows absolute path: `D:\Musique\…` or `D:/Musique/…`. */
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i;

export type ImportSource =
  | {
      readonly kind: "remote";
      /** Exactly what was typed, trimmed. */
      readonly url: string;
    }
  | {
      readonly kind: "folder";
      /** The canonical `file://…` form, which is what `imports.url` stores. */
      readonly url: string;
      /** The absolute path on this server, with the platform's own separators. */
      readonly path: string;
    };

/**
 * Turn whatever was submitted into a source, or refuse it.
 *
 * Accepted, in the order they are recognised:
 *
 *  - `https://…`, `http://…`, `fixture://…` — a remote listing, unchanged;
 *  - `file:///srv/musique/album` — a folder, already canonical;
 *  - `/srv/musique/album`, `D:\Musique\album` — a folder, typed the way a person types one.
 *
 * **A relative path is refused**, and that is not pedantry: the process's working directory is
 * the repository root in development, `/app` in the image, and whichever directory a cron ran
 * from in between. A source that resolves to three different folders depending on who asked is
 * worse than a source that is refused.
 *
 * Nothing here touches the filesystem. Whether the folder exists, and whether this application
 * is allowed to read it, are two separate questions answered by `resolveSourceFolder` against
 * `adoptSourceRoots` — and they must be answered *there*, once, so the allow-list has a single
 * enforcement point.
 */
export function parseImportSource(raw: string): ImportSource {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new MMError("INVALID_INPUT", "No source was given.", {
      hint: "Paste a YouTube link, or give the absolute path of a folder of audio files.",
      action: "Check the source",
    });
  }
  if (REMOTE_SHAPE.test(trimmed)) return { kind: "remote", url: trimmed };

  if (trimmed.toLowerCase().startsWith(FOLDER_SCHEME)) {
    const path = pathFromFileUrl(trimmed);
    return { kind: "folder", url: folderUrl(path), path };
  }

  if (WINDOWS_ABSOLUTE.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\\\")) {
    const path = resolvePath(trimmed);
    return { kind: "folder", url: folderUrl(path), path };
  }

  throw new MMError("INVALID_INPUT", `“${trimmed}” is not a source this app can import.`, {
    hint:
      "Paste a YouTube link, give the **absolute** path of a folder of audio files " +
      "(`/srv/musique/album`, `D:\\Musique\\album`), or use `fixture://discovery` to run " +
      "offline. A relative path is refused on purpose: it would mean a different folder " +
      "depending on which process resolved it.",
    action: "Check the source",
  });
}

/**
 * The absolute host path behind a `file://` source, or `null` for anything else.
 *
 * `null` rather than a throw, because every reader of `imports.url` asks this question in
 * order to find out *whether* the row is a folder import at all.
 */
export function folderPathOf(url: string): string | null {
  if (!url.trim().toLowerCase().startsWith(FOLDER_SCHEME)) return null;
  try {
    return pathFromFileUrl(url.trim());
  } catch {
    return null;
  }
}

/** True when this source is a folder on the server rather than something to fetch. */
export function isFolderSource(url: string): boolean {
  return folderPathOf(url) !== null;
}

/**
 * An absolute host path as a `file://` URL.
 *
 * Deliberately hand-rolled rather than `pathToFileURL`, for one reason: that function percent-
 * encodes spaces and every accent, and the value it produces is the one a human reads in the
 * Console's job list, in `mm jobs` and in the journal. `file:///D:/Musique/Édith Piaf` says
 * what was imported; `file:///D:/Musique/%C3%89dith%20Piaf` makes somebody decode it. Round
 * tripping is exact either way because `pathFromFileUrl` decodes only when it has to.
 */
export function folderUrl(absolutePath: string): string {
  const posix = toPosix(absolutePath).replace(/\/+$/, "");
  return `${FOLDER_SCHEME}/${posix.replace(/^\/+/, "")}`;
}

/**
 * `file:///D:/Musique/album` → `D:\Musique\album`, `file:///srv/musique` → `/srv/musique`.
 *
 * Percent-escapes are decoded when they are there, because a URL built by something other than
 * `folderUrl` — a client, a script, `pathToFileURL` — is a perfectly legitimate thing to be
 * handed and would otherwise name a directory with a literal `%20` in it.
 */
function pathFromFileUrl(url: string): string {
  const withoutScheme = url.slice(FOLDER_SCHEME.length);
  // `file://host/share` is a UNC path on Windows and nothing we can resolve elsewhere; only
  // the empty (localhost) authority is accepted, which is the form every tool writes.
  if (!withoutScheme.startsWith("/")) {
    throw new MMError("INVALID_INPUT", `“${url}” names a host, and only local folders work.`, {
      hint: "Write `file:///srv/musique/album` — three slashes, no host.",
      action: "Check the source",
    });
  }
  const decoded = withoutScheme.includes("%") ? safeDecode(withoutScheme) : withoutScheme;
  const bare = decoded.replace(/^\/+/, "");
  const candidate = WINDOWS_ABSOLUTE.test(bare) ? bare : decoded;
  if (!isAbsolute(resolvePath(candidate))) {
    throw new MMError("INVALID_INPUT", `“${url}” does not name an absolute folder.`, {
      action: "Check the source",
    });
  }
  return resolvePath(candidate);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray `%` is not an escape; the string is then already what it means.
    return value;
  }
}
