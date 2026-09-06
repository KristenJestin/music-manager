#!/usr/bin/env bun
/**
 * `bun run cache:seed-fixtures` — the recorded responses, as raw cache rows.
 *
 * Fixtures mode used to be a *branch*: `tag` looked at the URL and, for `fixture://discovery`,
 * read JSON off disk instead of calling anyone. P04 removes the branch. The recorded payloads
 * of `packages/domain/fixtures/` are now written into `source_cache` under exactly the keys
 * the real clients would have used, and the offline build then takes the ordinary path — the
 * same code, the same resolvers, the same merge, only the bytes come from a row instead of a
 * socket.
 *
 * That is worth more than it sounds. The E2E is no longer proving that the fixture branch
 * works; it is proving that **the production code path works offline**, which is the same
 * claim `mm doc rebuild --offline` and the background re-tag of §8 rest on.
 *
 * Absences are seeded too. "LRCLIB has nothing for track 7" is a recorded fact, and without
 * it an offline build would report a cache miss rather than a missing lyric.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaaIndex, LrclibEntry, MbRecording, MbRelease, MbTrack, MbWork } from "@mm/domain";
import type { DeezerTrack } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { put } from "#/server/services/cache.ts";
import { absentPayload } from "./cached.ts";
import { queryKey, type LyricsQuery } from "./lrclib.ts";

/** `packages/domain/fixtures/`, from `apps/web/src/server/integrations/`. */
const FIXTURE_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../../packages/domain/fixtures",
);

function read<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_ROOT, relative), "utf8")) as T;
}

export interface SeedReport {
  readonly rows: number;
  readonly bySource: Readonly<Record<string, number>>;
}

/** The instant the fixtures are dated at, so a seeded document is reproducible. */
export const FIXTURE_FETCHED_AT = new Date("2026-09-05T00:00:00.000Z");

/**
 * The artist credit as `documents.service` builds it for a LRCLIB query — the join is " & ",
 * not MusicBrainz's join phrases, because that is what a lyrics search matches on.
 */
function creditOf(track: MbTrack | undefined, release: MbRelease): string {
  const credit =
    track?.["artist-credit"] ?? track?.recording?.["artist-credit"] ?? release["artist-credit"];
  return (credit ?? []).map((entry) => entry.name ?? entry.artist?.name ?? "").join(" & ");
}

export async function seedFixtures(db: Database = defaultDb()): Promise<SeedReport> {
  const bySource: Record<string, number> = {};
  let rows = 0;

  const write = async (source: string, key: string, payload: unknown): Promise<void> => {
    await put(source, key, payload, { db, fetchedAt: FIXTURE_FETCHED_AT });
    bySource[source] = (bySource[source] ?? 0) + 1;
    rows += 1;
  };

  /* ---- MusicBrainz ---- */
  const release = read<MbRelease>("musicbrainz/release-discovery.json");
  const releaseMbid = release.id ?? "";
  await write("musicbrainz", `release/${releaseMbid}?inc=releaseFull`, release);

  for (const file of [
    "musicbrainz/recording-one-more-time.json",
    "musicbrainz/recording-skinny-love.json",
  ]) {
    const recording = read<MbRecording>(file);
    if (recording.id !== undefined) {
      await write("musicbrainz", `recording/${recording.id}?inc=recordingFull`, recording);
    }
  }

  const work = read<MbWork>("musicbrainz/work-one-more-time.json");
  if (work.id !== undefined) await write("musicbrainz", `work/${work.id}?inc=workFull`, work);

  /* ---- Cover Art Archive ---- */
  const caa = read<CaaIndex>("coverartarchive/release-discovery.json");
  await write("coverartarchive", `release/${releaseMbid}`, caa);

  /* ---- Deezer, keyed by the ISRC the recorded response answers for ---- */
  const deezer = read<DeezerTrack>("deezer/track-one-more-time.json");
  if (deezer.isrc !== undefined && deezer.isrc !== "") {
    await write("deezer", `track/isrc:${deezer.isrc.toUpperCase().replace(/-/g, "")}`, deezer);
  }

  /* ---- LRCLIB, one pair of keys per track of the release ---- */
  const lyricsSearch = read<LrclibEntry[]>("lrclib/search-one-more-time.json");
  const instrumental = read<LrclibEntry>("lrclib/get-instrumental.json");
  const medium = release.media?.[0];

  for (const track of medium?.tracks ?? []) {
    const millis = track.length ?? track.recording?.length;
    const query: LyricsQuery = {
      artist: creditOf(track, release),
      track: track.title ?? "",
      ...(release.title === undefined ? {} : { album: release.title }),
      ...(typeof millis === "number" && millis > 0
        ? { durationSeconds: Math.round(millis / 1000) }
        : {}),
    };
    if (query.track === "") continue;

    // "Nightvision" is Discovery's instrumental, and it is the case that must leave LYRICS
    // n/a rather than missing. LRCLIB does not actually carry the flag for it, so the
    // hand-written fixture stands in — see packages/domain/fixtures/README.md.
    const isInstrumental = track.position === 6;
    await write(
      "lrclib",
      queryKey("get", query),
      isInstrumental ? instrumental : absentPayload("LRCLIB has no exact match"),
    );
    await write("lrclib", queryKey("search", query), track.position === 1 ? lyricsSearch : []);
  }

  return { rows, bySource };
}

/* Run directly: `bun run cache:seed-fixtures`. */
if (import.meta.main) {
  const report = await seedFixtures();
  const detail = Object.entries(report.bySource)
    .map(([source, count]) => `${source} ${String(count)}`)
    .join(" · ");
  console.log(`seeded ${String(report.rows)} source_cache row(s): ${detail}`);
  process.exit(0);
}
