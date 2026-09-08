/**
 * v1's playlists, exported once and then let go (§ Étapes 5).
 *
 * v2 has no playlist model and is not getting one in this phase: playlists live in Navidrome,
 * which reads M3U files, and duplicating them in a second database would create two answers
 * to one question. So the migration writes each `UserPlaylist` out as an `.m3u8` next to the
 * library, records that it did, and stores nothing.
 *
 * `.m3u8` rather than `.m3u` because the extension is what tells a player the file is UTF-8,
 * and a v1 library is full of names that are not ASCII.
 *
 * The paths written are **relative to the playlist file**, which is what every player
 * resolves against. A song v1 never downloaded has no file, so it is emitted as a comment
 * rather than as a broken line: the playlist stays loadable and the information is still
 * there for whoever reads it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { toPosix } from "#/server/paths.ts";
import type { V1Playlist, V1PlaylistSong, V1Song } from "./schema.ts";

/**
 * `<library>/_archive/v1-playlists` — the default of § Étapes 5.
 *
 * Inside the library on purpose: it is the only directory a production container is
 * guaranteed to write to. The previous default, `<library>/../_archive`, resolved to `/_archive`
 * when the library is mounted at `/library`, which uid 10001 cannot create (owner report,
 * 2026-09-08). Navidrome can read the M3U files from there through `ND_PLAYLISTSPATH`.
 */
export function defaultPlaylistDir(libraryRoot: string): string {
  return resolve(libraryRoot, "_archive", "v1-playlists");
}

export interface PlaylistExportInput {
  readonly playlists: readonly V1Playlist[];
  readonly links: readonly V1PlaylistSong[];
  /** Every v1 song, by id. */
  readonly songs: ReadonlyMap<number, V1Song>;
  /** Library-relative path of the file each migrated song ended up at, by v1 song id. */
  readonly files: ReadonlyMap<number, string>;
  readonly libraryRoot: string;
  readonly targetDir: string;
}

export interface ExportedPlaylist {
  readonly name: string;
  /** Absolute path of the file written. */
  readonly path: string;
  readonly entries: number;
  /** Songs in the playlist that have no file, emitted as comments. */
  readonly missing: number;
}

/**
 * File-name safety for a playlist name.
 *
 * Not v1's sanitiser — this file is ours, not v1's, so it takes the strict rule: every
 * character Windows forbids becomes a dash, the run of spaces that leaves collapses, and a
 * name that empties out falls back to its position in the list.
 */
export function playlistFileName(name: string, index: number): string {
  const cleaned = name
    // The control range is the point of the rule here, exactly as in @mm/domain s
    // sanitizeSegment: a playlist name arriving with a stray U+0001 out of a v1 row is
    // precisely what must not reach a file name.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const stem = cleaned === "" ? `playlist-${String(index)}` : cleaned;
  return `${stem}.m3u8`;
}

/** Render one playlist. Pure, so the format is a unit test rather than a file on disk. */
export function renderPlaylist(
  playlist: V1Playlist,
  entries: readonly { song: V1Song; path: string | null }[],
  options: { pathPrefix: string },
): { body: string; missing: number } {
  const lines = ["#EXTM3U", `#PLAYLIST:${playlist.name}`];
  if (playlist.description !== null && playlist.description !== "") {
    lines.push(`# ${playlist.description.replace(/\r?\n/g, " ")}`);
  }

  let missing = 0;
  for (const entry of entries) {
    const artist = entry.song.albumArtists[0] ?? entry.song.artist ?? "";
    const title = entry.song.title ?? entry.song.sourceTitle ?? `v1 song ${String(entry.song.id)}`;
    // v1 stores milliseconds; EXTINF wants whole seconds, and -1 means "unknown".
    const seconds =
      entry.song.duration === null ? -1 : Math.max(0, Math.round(entry.song.duration / 1000));
    lines.push(`#EXTINF:${String(seconds)},${artist === "" ? title : `${artist} - ${title}`}`);
    if (entry.path === null) {
      missing += 1;
      lines.push(`# not migrated (${entry.song.downloadStatus}): ${entry.song.sourceUrl}`);
      continue;
    }
    lines.push(`${options.pathPrefix}${entry.path}`);
  }

  return { body: `${lines.join("\n")}\n`, missing };
}

/**
 * Write every v1 playlist out.
 *
 * `dryRun` renders exactly the same content and writes nothing, so the preview in Tools shows
 * the real counts rather than an estimate.
 */
export function exportPlaylists(
  input: PlaylistExportInput,
  options: { dryRun?: boolean } = {},
): readonly ExportedPlaylist[] {
  const dryRun = options.dryRun ?? false;
  if (input.playlists.length === 0) return [];

  const byPlaylist = new Map<number, V1PlaylistSong[]>();
  for (const link of input.links) {
    const bucket = byPlaylist.get(link.playlistId);
    if (bucket === undefined) byPlaylist.set(link.playlistId, [link]);
    else bucket.push(link);
  }

  // From the playlist file to the library root, in POSIX form: `../../library/`.
  const prefixRaw = relative(input.targetDir, input.libraryRoot);
  const prefix = prefixRaw === "" ? "" : `${toPosix(prefixRaw)}/`;

  if (!dryRun) mkdirSync(input.targetDir, { recursive: true });

  const out: ExportedPlaylist[] = [];
  input.playlists.forEach((playlist, index) => {
    const links = [...(byPlaylist.get(playlist.id) ?? [])].sort((a, b) => a.order - b.order);
    const entries = links.flatMap((link) => {
      const song = input.songs.get(link.songId);
      return song === undefined ? [] : [{ song, path: input.files.get(link.songId) ?? null }];
    });

    const { body, missing } = renderPlaylist(playlist, entries, { pathPrefix: prefix });
    const target = join(input.targetDir, playlistFileName(playlist.name, index + 1));
    if (!dryRun) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, "utf8");
    }
    out.push({ name: playlist.name, path: target, entries: entries.length, missing });
  });

  return out;
}
