#!/usr/bin/env bun
/**
 * `bun run fixtures/v1/build-library.ts` — materialise the v1 fixture library.
 *
 * Every file is a copy of the toolbox's bundled five-second Opus sample, tagged through
 * `POST /tag` with **exactly** the tag set v1's `ApplyID3TagsInternal` writes — no more, no
 * fewer, in v1's spelling. That is the whole point of the fixture: if we tagged these files
 * with v2's own projection, the migration would be reading its own output and the test would
 * prove nothing.
 *
 * The v1 tag set, as TagLib# renders it into Vorbis comments on an Ogg/Opus file:
 *
 *   TITLE · ARTIST (one per performer) · ALBUMARTIST (one per album artist) · ALBUM ·
 *   TRACKNUMBER · TRACKTOTAL · DATE (the year alone) · GENRE (one per genre) ·
 *   DESCRIPTION (`Source: <url>` — TagLib's Xiph field for `Tag.Comment`; ffprobe reports it
 *   back as COMMENT) · SUBTITLE · ISRC ·
 *   ORGANIZATION (the publisher) · DISCNUMBER · DISCTOTAL (both always written, `0` when
 *   unknown) · MUSICBRAINZ_ARTISTID · MUSICBRAINZ_ALBUMARTISTID · MUSICBRAINZ_ALBUMID ·
 *   MUSICBRAINZ_RELEASEGROUPID · **MUSICBRAINZ_TRACKID holding the *recording* id** ·
 *   RELEASESTATUS · RELEASECOUNTRY.
 *
 * `MUSICBRAINZ_TRACKID` holding the recording id is not a bug: it is Picard's naming, which
 * v1 followed and which v2's tag map follows too. What v1 does *not* write is
 * `MUSICBRAINZ_RELEASETRACKID`, the release-track id — v2 adds that, and its appearance in a
 * file is one way to tell a migrated file from an untouched one.
 *
 * Environment:
 *   MM_LIBRARY_ROOT          where to build, on this side of the bridge
 *   MM_TOOLBOX_LIBRARY_ROOT  the same directory as the toolbox sees it (default `/library`)
 *   MM_TOOLBOX_URL           default `http://localhost:8100`
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_ORPHANS, filesToBuild, type FixtureSong } from "./dataset.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SAMPLE = join(REPO_ROOT, "services/toolbox/src/toolbox/fixtures/data/sample.opus");

const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
const HOST_ROOT = resolve(
  process.env["MM_LIBRARY_ROOT"] ?? join(REPO_ROOT, ".local", "library", ".mm-migrate"),
);
const CONTAINER_ROOT = (process.env["MM_TOOLBOX_LIBRARY_ROOT"] ?? "/library").replace(/\/+$/, "");

interface Tag {
  readonly key: string;
  readonly value: string;
}

/** The tags v1 would have written into this song's file. */
export function v1Tags(song: FixtureSong): Tag[] {
  const tags: Tag[] = [];
  const put = (key: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined) return;
    const text = String(value);
    if (text === "") return;
    tags.push({ key, value: text });
  };

  put("TITLE", song.title);
  for (const performer of song.performers) put("ARTIST", performer);
  // v1 falls back to the performers when there is no album artist.
  const albumArtists = song.albumArtists.length > 0 ? song.albumArtists : song.performers;
  for (const artist of albumArtists) put("ALBUMARTIST", artist);
  put("ALBUM", song.album);
  if (song.trackNumber !== null && song.trackNumber > 0) put("TRACKNUMBER", song.trackNumber);
  if (song.trackCount !== null && song.trackCount > 0) put("TRACKTOTAL", song.trackCount);
  if (song.year !== null && song.year > 0) put("DATE", song.year);
  for (const genre of song.genres) put("GENRE", genre);
  // `Tag.Comment = $"Source: {youtubeUrl}"` — the only provenance a v1 file carries.
  put("DESCRIPTION", `Source: ${song.sourceUrl}`);
  put("SUBTITLE", song.subtitle);
  put("ISRC", song.isrc);
  put("ORGANIZATION", song.publisher);
  // v1 writes both unconditionally, `?? 0`.
  put("DISCNUMBER", song.discNumber ?? 0);
  put("DISCTOTAL", song.discCount ?? 0);
  put("MUSICBRAINZ_ARTISTID", song.artistMbid);
  put("MUSICBRAINZ_ALBUMARTISTID", song.albumArtistMbid);
  put("MUSICBRAINZ_ALBUMID", song.releaseMbid);
  put("MUSICBRAINZ_RELEASEGROUPID", song.releaseGroupMbid);
  // Picard's naming: the *recording* id goes into the *track* id tag. v2 does the same.
  put("MUSICBRAINZ_TRACKID", song.recordingMbid);
  put("RELEASESTATUS", song.releaseStatus);
  put("RELEASECOUNTRY", song.releaseCountry);

  return tags;
}

async function tagFile(relative: string, tags: readonly Tag[]): Promise<void> {
  const response = await fetch(`${TOOLBOX_URL}/tag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: `${CONTAINER_ROOT}/${relative}`,
      format: "auto",
      tags,
      pictures: [],
      lyrics_lrc: null,
      sidecar_lrc: false,
      clear: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`toolbox /tag failed for ${relative}: HTTP ${String(response.status)}`);
  }
}

export interface BuildResult {
  readonly root: string;
  readonly files: number;
  readonly orphans: number;
}

export async function buildFixtureLibrary(options: { clean?: boolean } = {}): Promise<BuildResult> {
  if (!existsSync(SAMPLE)) {
    throw new Error(`the toolbox sample is missing: ${SAMPLE}`);
  }
  /*
   * Empty the directory, do not delete it.
   *
   * The library root is a Docker bind mount. Deleting and recreating the mounted directory
   * itself makes Docker Desktop on Windows lose track of it: the host sees the new directory,
   * the container keeps looking at the old inode, and every /tag call comes back
   * "No such file" for a file that is plainly there. Clearing the contents leaves the inode
   * alone and is exactly as clean.
   */
  mkdirSync(HOST_ROOT, { recursive: true });
  if (options.clean !== false) {
    for (const entry of readdirSync(HOST_ROOT)) {
      rmSync(join(HOST_ROOT, entry), { recursive: true, force: true });
    }
  }

  let files = 0;
  for (const { song, path } of filesToBuild()) {
    const target = join(HOST_ROOT, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(SAMPLE, target);
    await tagFile(path, v1Tags(song));
    files += 1;
  }

  for (const orphan of FIXTURE_ORPHANS) {
    const target = join(HOST_ROOT, orphan.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(SAMPLE, target);
    await tagFile(
      orphan.path,
      Object.entries(orphan.tags).map(([key, value]) => ({ key, value })),
    );
  }

  return { root: HOST_ROOT, files, orphans: FIXTURE_ORPHANS.length };
}

if (import.meta.main) {
  const result = await buildFixtureLibrary();
  console.log(
    `built the v1 fixture library at ${result.root}: ` +
      `${String(result.files)} tagged file(s) + ${String(result.orphans)} orphan(s)`,
  );
}
