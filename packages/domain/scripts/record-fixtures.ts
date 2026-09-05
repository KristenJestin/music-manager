/**
 * Re-record the network fixtures under `packages/domain/fixtures/`.
 *
 *     bun run --cwd packages/domain fixtures:record
 *
 * This is the ONLY code in this package that touches the network, and it is never
 * run by the test suite (see ../fixtures/README.md). Tests read the committed JSON.
 *
 * Rules honoured here:
 *  - MusicBrainz: one request per 1.1 s, User-Agent with a contact string (§4 of
 *    docs/03-metadonnees.md);
 *  - every response is written pretty-printed so a re-record produces a readable diff;
 *  - the yt-dlp and rsgain fixtures are hand-written (no public endpoint to record from)
 *    and are therefore NOT touched by this script.
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");

const USER_AGENT = "MusicManager/0.1-dev (fixtures recording)";
const MB = "https://musicbrainz.org/ws/2";
const MB_INC = [
  "artists",
  "artist-credits",
  "labels",
  "recordings",
  "release-groups",
  "media",
  "isrcs",
  "genres",
  "tags",
  "aliases",
  "artist-rels",
  "recording-rels",
  "work-rels",
  "recording-level-rels",
  "work-level-rels",
  "url-rels",
].join("+");

/** The release this package's golden files are built from — see fixtures/README.md. */
const DISCOVERY_RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";
/** Birdy — "Skinny Love", the single-recording (no album) case. */
const SKINNY_LOVE_RECORDING = "5463ed3a-5fc1-49b6-8260-3b5bb36ee047";

let lastMusicBrainzCall = 0;

async function throttleMusicBrainz(): Promise<void> {
  const wait = 1100 - (Date.now() - lastMusicBrainzCall);
  if (wait > 0) await Bun.sleep(wait);
  lastMusicBrainzCall = Date.now();
}

async function getJson(url: string, { throttle = false } = {}): Promise<unknown> {
  if (throttle) await throttleMusicBrainz();
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return (await response.json()) as unknown;
}

async function write(relativePath: string, body: unknown): Promise<void> {
  const target = resolve(FIXTURES, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`  wrote ${relativePath}`);
}

/**
 * Replace the words of an LRCLIB entry while keeping every structural fact the resolvers
 * read: the number of lines and, for synced lyrics, the `[mm:ss.cc]` timestamps.
 */
function redactLyrics(entry: Record<string, unknown>): Record<string, unknown> {
  const synced = typeof entry["syncedLyrics"] === "string" ? entry["syncedLyrics"] : null;
  const plain = typeof entry["plainLyrics"] === "string" ? entry["plainLyrics"] : null;
  return {
    ...entry,
    syncedLyrics:
      synced === null
        ? null
        : synced
            .split("\n")
            .map((line) => `${/^\[\d\d:\d\d[.:]\d\d\]/.exec(line)?.[0] ?? ""} lyrics redacted`.trim())
            .join("\n"),
    plainLyrics: plain === null ? null : plain.split("\n").map(() => "lyrics redacted").join("\n"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log(`Recording fixtures into ${FIXTURES}`);

  // 1. The release, with the complete `inc` list of docs/03-metadonnees.md §4. This single
  //    document also carries the 14 recordings with their relations and their works.
  console.log("MusicBrainz release…");
  const release = asRecord(
    await getJson(`${MB}/release/${DISCOVERY_RELEASE}?inc=${MB_INC}&fmt=json`, { throttle: true }),
  );
  await write("musicbrainz/release-discovery.json", release);

  // 2. Track 1's recording on its own, the shape `fromMusicBrainzRecording` sees when a
  //    single video is matched without an album.
  const media = release["media"] as Array<Record<string, unknown>>;
  const tracks = media[0]?.["tracks"] as Array<Record<string, unknown>>;
  const firstRecording = asRecord(tracks[0]?.["recording"]);
  const recordingId = String(firstRecording["id"]);
  console.log(`MusicBrainz recording ${recordingId}…`);
  // `releases` is deliberately absent: on a popular recording it inlines several hundred
  // releases (a 3 MB fixture). The release list is recorded separately, browsed and capped,
  // which is also how P04 will page through it.
  const recordingInc =
    "artists+artist-credits+isrcs+genres+tags+aliases+artist-rels+work-rels+url-rels+work-level-rels";
  await write(
    "musicbrainz/recording-one-more-time.json",
    await getJson(`${MB}/recording/${recordingId}?inc=${recordingInc}&fmt=json`, { throttle: true }),
  );

  // 3. The work behind it (composer / lyricist / writer relations, ISWC, language).
  const workRelation = (firstRecording["relations"] as Array<Record<string, unknown>>).find(
    (relation) => relation["target-type"] === "work",
  );
  const workId = String(asRecord(workRelation?.["work"])["id"]);
  console.log(`MusicBrainz work ${workId}…`);
  await write(
    "musicbrainz/work-one-more-time.json",
    await getJson(`${MB}/work/${workId}?inc=artist-rels+aliases+tags+url-rels&fmt=json`, { throttle: true }),
  );

  // 4. A recording whose releases must be chosen from (the "single video, borrow a release"
  //    case of docs/04-pipeline-et-matching.md), plus that browsed release list.
  console.log("MusicBrainz recording Skinny Love…");
  await write(
    "musicbrainz/recording-skinny-love.json",
    await getJson(`${MB}/recording/${SKINNY_LOVE_RECORDING}?inc=${recordingInc}&fmt=json`, {
      throttle: true,
    }),
  );
  console.log("MusicBrainz releases of Skinny Love…");
  await write(
    "musicbrainz/releases-of-skinny-love.json",
    await getJson(
      `${MB}/release?recording=${SKINNY_LOVE_RECORDING}&inc=artist-credits+release-groups+labels+media&limit=25&fmt=json`,
      { throttle: true },
    ),
  );

  // 5. Cover Art Archive index for the release.
  console.log("Cover Art Archive…");
  await write(
    "coverartarchive/release-discovery.json",
    await getJson(`https://coverartarchive.org/release/${DISCOVERY_RELEASE}`),
  );

  // 6. LRCLIB lyrics search. The response is kept real in shape, count and metadata but the
  //    lyric bodies are redacted before it is committed: they are third-party copyrighted
  //    text and none of the domain code looks at the words, only at the LRC structure and
  //    the `instrumental` flag. See fixtures/README.md.
  console.log("LRCLIB…");
  const lrclib = (await getJson(
    "https://lrclib.net/api/search?track_name=One+More+Time&artist_name=Daft+Punk",
  )) as Array<Record<string, unknown>>;
  await write("lrclib/search-one-more-time.json", lrclib.slice(0, 5).map(redactLyrics));

  // 7. Deezer by ISRC — the source of BPM, gain and the explicit flag.
  console.log("Deezer…");
  const isrcs = (firstRecording["isrcs"] as string[]) ?? [];
  let deezer: unknown;
  for (const isrc of [...isrcs].sort()) {
    const candidate = asRecord(await getJson(`https://api.deezer.com/track/isrc:${isrc}`));
    if (!("error" in candidate)) {
      console.log(`  matched ISRC ${isrc}`);
      deezer = candidate;
      break;
    }
  }
  if (deezer === undefined) throw new Error(`no Deezer track for ISRCs ${isrcs.join(", ")}`);
  await write("deezer/track-one-more-time.json", deezer);

  console.log("Done. `ytdlp/` and `rsgain/` are hand-written — see fixtures/README.md.");
}

await main();
