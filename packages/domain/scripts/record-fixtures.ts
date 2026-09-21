/**
 * Re-record the network fixtures under `packages/domain/fixtures/`.
 *
 *     bun run --cwd packages/domain fixtures:record
 *     bun run --cwd packages/domain fixtures:record -- --only-locale
 *     bun run --cwd packages/domain fixtures:record -- --only-suzume
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
/**
 * Bon Iver — "Skinny Love", and the album it is borrowed onto.
 *
 * These two are the *single path's* offline pipeline, not a resolver golden file: the
 * toolbox's `fixture://skinny-love` serves Bon Iver's auto-generated video, the matcher
 * preselects this recording and the borrow ladder files it under "For Emma, Forever Ago", so
 * `tag` asks the cache for exactly these two documents. Without them the E2E single import
 * reached `tag` and died with `OFFLINE_CACHE_MISS` (DRIVE-FIX-1).
 */
const SKINNY_LOVE_BON_IVER_RECORDING = "8a8ca6f4-2150-4b2b-935d-b66962de3b89";
const FOR_EMMA_RELEASE = "0270cde6-6b5b-31fa-b04b-d8b68ff612d4";

/**
 * 梶浦由記 — the locale-alias case of `docs/03-metadonnees.md` §2.1, recorded from reality.
 *
 * The artist is looked up by **search**, never by a hard-coded MBID: the point of this fixture
 * is that the aliases are MusicBrainz's, and an MBID typed from memory is exactly the kind of
 * guess that produces a fixture proving nothing. The two releases are a pair: a Japanese
 * `Official` pressing and the Latin `Pseudo-Release` of the same release group, which is the
 * only place a romanised *track* title exists.
 */
const KAJIURA_QUERY = "Kajiura";
const TSUBASA_RELEASE = "c1aea260-b33f-43c9-92e3-8e03c0a917bd";
const TSUBASA_PSEUDO_RELEASE = "90f126ee-5246-471b-8745-bd7f1a39b19c";
const TSUBASA_RELEASE_GROUP = "f5952bf4-9a30-3efd-8861-42d8fcfd86a1";

let lastMusicBrainzCall = 0;

async function throttleMusicBrainz(): Promise<void> {
  const wait = 1100 - (Date.now() - lastMusicBrainzCall);
  if (wait > 0) await Bun.sleep(wait);
  lastMusicBrainzCall = Date.now();
}

/**
 * `503 Service Temporarily Unavailable` is MusicBrainz's “currently busy”, not a refusal, and
 * it arrives often enough that a single one used to abandon a fifteen-request recording
 * halfway through. Retried with a widening pause, which is what their guidance asks for; a
 * real error status still fails on the first try.
 */
const RETRIES = 12;

async function getJson(url: string, { throttle = false } = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    if (throttle) await throttleMusicBrainz();
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (response.ok) return (await response.json()) as unknown;
    if (response.status !== 503 || attempt >= RETRIES) {
      throw new Error(`${String(response.status)} ${response.statusText} for ${url}`);
    }
    const pause = Math.min(2000 * (attempt + 1), 15_000);
    console.log(`  503, retrying in ${String(pause)} ms…`);
    await Bun.sleep(pause);
  }
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
            .map((line) =>
              `${/^\[\d\d:\d\d[.:]\d\d\]/.exec(line)?.[0] ?? ""} lyrics redacted`.trim(),
            )
            .join("\n"),
    plainLyrics:
      plain === null
        ? null
        : plain
            .split("\n")
            .map(() => "lyrics redacted")
            .join("\n"),
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
    await getJson(`${MB}/recording/${recordingId}?inc=${recordingInc}&fmt=json`, {
      throttle: true,
    }),
  );

  // 3. The work behind it (composer / lyricist / writer relations, ISWC, language).
  const workRelation = (firstRecording["relations"] as Array<Record<string, unknown>>).find(
    (relation) => relation["target-type"] === "work",
  );
  const workId = String(asRecord(workRelation?.["work"])["id"]);
  console.log(`MusicBrainz work ${workId}…`);
  await write(
    "musicbrainz/work-one-more-time.json",
    await getJson(`${MB}/work/${workId}?inc=artist-rels+aliases+tags+url-rels&fmt=json`, {
      throttle: true,
    }),
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

  // 4b. The single path's own two documents: the recording the toolbox fixture's video is,
  //     and the album its context is borrowed from. `tag` looks both up by their preset keys.
  console.log("MusicBrainz recording Skinny Love (Bon Iver)…");
  await write(
    "musicbrainz/recording-skinny-love-bon-iver.json",
    await getJson(
      `${MB}/recording/${SKINNY_LOVE_BON_IVER_RECORDING}?inc=${recordingInc}&fmt=json`,
      { throttle: true },
    ),
  );
  console.log("MusicBrainz release For Emma, Forever Ago…");
  await write(
    "musicbrainz/release-for-emma.json",
    await getJson(`${MB}/release/${FOR_EMMA_RELEASE}?inc=${MB_INC}&fmt=json`, { throttle: true }),
  );

  // 4c. The locale-alias case.
  await recordLocaleAliases();

  // 4d. The credited-as and tracklist case — see `recordSuzume`.
  await recordSuzume();

  // 5. Cover Art Archive index for the release.
  console.log("Cover Art Archive…");
  await write(
    "coverartarchive/release-discovery.json",
    await getJson(`https://coverartarchive.org/release/${DISCOVERY_RELEASE}`),
  );
  await recordTail(firstRecording);
}

/**
 * 梶浦由記 / Yuki Kajiura, one Japanese release, and the Latin pseudo-release of the same
 * group — the fixtures behind `docs/03-metadonnees.md` §2.1's locale aliases.
 *
 * Its own function, and reachable on its own with `--only-locale`, because re-recording the
 * whole set to add one artist produces a diff nobody can review: MusicBrainz changes under
 * every other fixture at the same time.
 */
async function recordLocaleAliases(): Promise<void> {
  console.log("MusicBrainz artist 梶浦由記…");
  const search = asRecord(
    await getJson(`${MB}/artist?query=${encodeURIComponent(KAJIURA_QUERY)}&limit=25&fmt=json`, {
      throttle: true,
    }),
  );
  const found = (search["artists"] as Array<Record<string, unknown>>).find(
    (candidate) => candidate["sort-name"] === "Kajiura, Yuki",
  );
  if (found === undefined) throw new Error("no artist sorting as “Kajiura, Yuki” was found");
  const kajiuraId = String(found["id"]);
  console.log(`  resolved to ${kajiuraId}`);
  await write(
    "musicbrainz/artist-kajiura.json",
    await getJson(
      `${MB}/artist/${kajiuraId}?inc=aliases+genres+tags+url-rels+artist-rels&fmt=json`,
      {
        throttle: true,
      },
    ),
  );

  console.log("MusicBrainz release ツバサ・クロニクル (Official, Jpan)…");
  await write(
    "musicbrainz/release-tsubasa.json",
    await getJson(`${MB}/release/${TSUBASA_RELEASE}?inc=${MB_INC}&fmt=json`, { throttle: true }),
  );
  console.log("MusicBrainz release ツバサ・クロニクル (Pseudo-Release, Latn)…");
  await write(
    "musicbrainz/release-tsubasa-pseudo.json",
    await getJson(`${MB}/release/${TSUBASA_PSEUDO_RELEASE}?inc=${MB_INC}&fmt=json`, {
      throttle: true,
    }),
  );
  console.log("MusicBrainz pseudo-release search…");
  await write(
    "musicbrainz/search-tsubasa-pseudo.json",
    await getJson(
      `${MB}/release?query=${encodeURIComponent(`rgid:${TSUBASA_RELEASE_GROUP} AND status:"Pseudo-Release"`)}&limit=25&fmt=json`,
      { throttle: true },
    ),
  );
}

/**
 * RADWIMPS & 陣内一真 — the credited-as and tracklist case, recorded whole rather than
 * hand-built because it carries both halves of the bug in one document.
 *
 * *Suzume*'s worldwide edition spells its tracklist in Latin ("The First Encounter") while the
 * recordings underneath keep the Japanese originals (二人の出逢い) — so which patch wins is
 * visible as a string. And its album-artist credit is a genuine “credited as”: `Kazuma
 * Jinnouchi`, printed by an editor alongside `RADWIMPS`, for an artist whose canonical name is
 * 陣内一真 and whose only alias is `{Kazuma Jinnouchi, en, primary}`.
 *
 * The `inc` list is deliberately short — the two symptoms of #9 need artist credits and their
 * aliases, the release's own tracklist, and the recordings it embeds. Nothing else.
 */
const SUZUME_RELEASE = "1b3e78eb-88d0-48a5-839b-84fecfb5aeea";
const SUZUME_INC = "artists+artist-credits+aliases+recordings";

async function recordSuzume(): Promise<void> {
  console.log("MusicBrainz release Suzume (RADWIMPS, worldwide edition)…");
  await write(
    "musicbrainz/release-suzume.json",
    await getJson(`${MB}/release/${SUZUME_RELEASE}?inc=${SUZUME_INC}&fmt=json`, { throttle: true }),
  );
}

/** The two sources keyed by what the first recording says: LRCLIB, then Deezer by ISRC. */
async function recordTail(firstRecording: Record<string, unknown>): Promise<void> {
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

// `--only-locale` re-records the §2.1 alias fixtures alone, `--only-suzume` the §2.1
// credited-as one. Everything else stays as committed, so the diff is the thing that changed
// rather than a month of MusicBrainz edits.
if (Bun.argv.includes("--only-locale")) await recordLocaleAliases();
else if (Bun.argv.includes("--only-suzume")) await recordSuzume();
else await main();
