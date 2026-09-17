#!/usr/bin/env bun
/**
 * `bun run fixtures/folder/build-source.ts` — materialise a source folder for `mm import <folder>`.
 *
 * A folder import needs one thing no recording can provide: **real audio files with real tags
 * on a real disk**. So this builds them the way `fixtures/v1/build-library.ts` builds its own —
 * copies of the toolbox's bundled five-second Opus sample, tagged through `POST /tag`, which is
 * the only thing in this repository that writes a tag. No network, nothing stubbed: `resolve`
 * then reads these files back with the same ffprobe a production import would.
 *
 * Two folders, because two things need proving:
 *
 *  - **`album/`** — six files that agree on an ALBUM, an ALBUMARTIST and a year, numbered
 *    1…6 out of order on disk. That is the ordinary case, and the out-of-order filenames are
 *    the point: the listing has to come back in tracklist order because the *tags* say so, not
 *    because the directory happened to.
 *  - **`junk/`** — a folder with nothing importable in it: a subfolder, a `.txt`, a `.wav` the
 *    tagger cannot write to, and a JPEG wearing a `.mp3` extension. One folder, four different
 *    ways to be refused.
 *
 * Where it builds matters. The toolbox runs ffprobe **inside its container**, so the source has
 * to be somewhere the container can see; in development that means inside the library bind
 * mount, and `--root` defaults to a dot-prefixed directory under it (dot-prefixed so
 * Navidrome's scanner leaves it alone). In production the equivalent is `MM_ADOPT_PATH`, which
 * mounts a real library read-only at the same path in every container — `docs/deploy.md`
 * § « Monter une bibliothèque existante ».
 *
 * Environment:
 *   MM_LIBRARY_ROOT          the library on this side of the bridge
 *   MM_TOOLBOX_LIBRARY_ROOT  the same directory as the toolbox sees it (default `/library`)
 *   MM_TOOLBOX_URL           default `http://localhost:8100`
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SAMPLE = join(REPO_ROOT, "services/toolbox/src/toolbox/fixtures/data/sample.opus");

/** The album the fixture folder claims to be. Deliberately not a record MusicBrainz has. */
export const FIXTURE_ALBUM = "Salle Pleyel, 12 mars";
export const FIXTURE_ARTIST = "Le Quatuor Imaginaire";
export const FIXTURE_YEAR = 2019;

export interface FixtureTrack {
  /** The name on disk. Out of tracklist order on purpose — the tags are what order them. */
  readonly file: string;
  readonly track: number;
  readonly title: string;
}

/**
 * Six files, named so that a filename sort and a tracklist sort disagree.
 *
 * `10 - …` before `2 - …` is the classic string-sort failure, and `A-side` before `01` is what
 * a folder somebody organised by hand actually looks like. The listing must come back 1…6.
 */
export const FIXTURE_TRACKS: readonly FixtureTrack[] = [
  { file: "A-side.opus", track: 1, title: "Ouverture" },
  { file: "10 - encore.opus", track: 6, title: "Rappel" },
  { file: "2 - andante.opus", track: 2, title: "Andante" },
  { file: "third movement.opus", track: 3, title: "Scherzo" },
  { file: "04.opus", track: 4, title: "Adagio" },
  { file: "05 - finale.opus", track: 5, title: "Finale" },
] as const;

interface Tag {
  readonly key: string;
  readonly value: string;
}

/** The tags a file of this fixture album carries — what an existing library's files look like. */
export function fixtureTags(track: FixtureTrack): Tag[] {
  return [
    { key: "TITLE", value: track.title },
    { key: "ARTIST", value: FIXTURE_ARTIST },
    { key: "ALBUMARTIST", value: FIXTURE_ARTIST },
    { key: "ALBUM", value: FIXTURE_ALBUM },
    { key: "TRACKNUMBER", value: String(track.track) },
    { key: "TRACKTOTAL", value: String(FIXTURE_TRACKS.length) },
    { key: "DISCNUMBER", value: "1" },
    { key: "DATE", value: String(FIXTURE_YEAR) },
    { key: "GENRE", value: "Classical" },
  ];
}

/**
 * The two ends of the bridge, resolved **per call** rather than at module load.
 *
 * `bun run e2e-fixture` builds its library in a directory of its own and hands the child
 * processes an environment that names it; the script's own process does not carry it. Reading
 * `MM_TOOLBOX_LIBRARY_ROOT` at import time therefore tagged `/library/<album>` while the files
 * were written to `/library/.mm-e2e-fixture-<tag>/<album>`, and `/tag` answered 404 for a file
 * that was plainly there. Explicit options, with the environment as the fallback.
 */
interface Bridge {
  readonly toolboxUrl: string;
  readonly containerRoot: string;
}

function bridgeFrom(options: { toolboxUrl?: string; containerRoot?: string }): Bridge {
  return {
    toolboxUrl: options.toolboxUrl ?? process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100",
    containerRoot: (
      options.containerRoot ??
      process.env["MM_TOOLBOX_LIBRARY_ROOT"] ??
      "/library"
    ).replace(/\/+$/, ""),
  };
}

async function tagFile(bridge: Bridge, relative: string, tags: readonly Tag[]): Promise<void> {
  const response = await fetch(`${bridge.toolboxUrl}/tag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: `${bridge.containerRoot}/${relative}`,
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
  /** Absolute host path of the folder holding the six tagged files. */
  readonly album: string;
  /** Absolute host path of the folder holding nothing importable. */
  readonly junk: string;
  readonly files: number;
}

/**
 * Build both folders under `<library>/<subdir>`, and return their absolute host paths.
 *
 * `subdir` is **library-relative** because that is the only vocabulary both sides of the bridge
 * share: the files are written through `node:fs` with the host root and tagged through the
 * toolbox with the container root, and one relative path spans the two.
 */
export async function buildFixtureSource(
  options: {
    libraryRoot?: string;
    subdir?: string;
    toolboxUrl?: string;
    containerRoot?: string;
  } = {},
): Promise<BuildResult> {
  const bridge = bridgeFrom(options);
  const hostRoot = resolve(
    options.libraryRoot ?? process.env["MM_LIBRARY_ROOT"] ?? join(REPO_ROOT, ".local", "library"),
  );
  const subdir = options.subdir ?? ".mm-folder-src";
  const albumRelative = `${subdir}/${FIXTURE_ALBUM}`;
  const albumHost = join(hostRoot, subdir, FIXTURE_ALBUM);
  const junkHost = join(hostRoot, subdir, "junk");

  // Emptied rather than deleted and recreated: the library root is a Docker bind mount, and on
  // Windows recreating a mounted directory makes the container keep looking at the old inode.
  // `build-library.ts` learned that the hard way; the same rule applies one level down.
  rmSync(albumHost, { recursive: true, force: true });
  rmSync(junkHost, { recursive: true, force: true });
  mkdirSync(albumHost, { recursive: true });
  mkdirSync(join(junkHost, "an album folder"), { recursive: true });

  for (const track of FIXTURE_TRACKS) {
    copyFileSync(SAMPLE, join(albumHost, track.file));
    await tagFile(bridge, `${albumRelative}/${track.file}`, fixtureTags(track));
  }

  // Four ways for a folder to hold nothing importable, in one folder.
  writeFileSync(join(junkHost, "notes.txt"), "the album is on the other disk\n");
  writeFileSync(join(junkHost, "cover.wav"), "RIFF....WAVEfmt \n");
  // Passes `taggable()` on its extension and fails ffprobe, which is the interesting one.
  writeFileSync(join(junkHost, "sleeve.mp3"), "\xff\xd8\xff\xe0 this is a JPEG wearing a hat\n");
  writeFileSync(join(junkHost, "an album folder", "01.opus"), "not reached: not recursive\n");

  return { album: albumHost, junk: junkHost, files: FIXTURE_TRACKS.length };
}

if (import.meta.main) {
  const result = await buildFixtureSource();
  console.log(
    `built the folder-import fixture:\n` +
      `  ${result.album}  (${String(result.files)} tagged file(s))\n` +
      `  ${result.junk}  (nothing importable)`,
  );
}
