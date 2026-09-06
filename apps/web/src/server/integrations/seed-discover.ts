/**
 * The Discover half of `bun run cache:seed-fixtures` (P09).
 *
 * `seed-fixtures.ts` explains the principle and it applies here unchanged: fixtures mode is
 * **not a branch**. There is no `if (fixtures)` inside `discography.service` or
 * `recommendations.service`; instead the answers MusicBrainz and ListenBrainz would have given
 * are written into `source_cache` under exactly the keys the real clients compute, and the
 * offline sync then takes the ordinary path. What `MM_FIXTURES=1 mm discover sync` proves is
 * therefore that the *production* code path works offline, which is the claim that matters.
 *
 * Two rows are not cache rows and are seeded all the same:
 *
 *  - **`artists_cache`.** `signals.service` resolves an artist name to an MBID exactly as
 *    `library.artistList` does — through that table — and without an MBID an artist cannot have
 *    a discography compared. On a real installation P04 fills it while building documents; a
 *    fixtures database has never built one for Daft Punk's *artist*, only for the release.
 *
 * ## About the identifiers
 *
 * The Daft Punk artist MBID and the Discovery release-group MBID are **real**: they are lifted
 * from `packages/domain/fixtures/musicbrainz/release-discovery.json`, which was recorded off
 * MusicBrainz. Everything else — the other release-groups, the similar artists — is
 * **hand-authored**, and its MBIDs are synthetic (they follow the `fixture` pattern below so
 * they are recognisable as such in a database dump). They are never dereferenced: offline,
 * nothing may leave the machine, and every one of them is a key in this same file.
 */
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { artistsCache } from "#/server/db/schema/index.ts";
import { put } from "#/server/services/cache.ts";
import { FIXTURE_FETCHED_AT } from "./seed-fixtures.ts";

/** Real, from the recorded release fixture. */
export const DAFT_PUNK_MBID = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";
/** Real: Discovery's release group — the one the fixture library already owns. */
export const DISCOVERY_RG_MBID = "48117b90-a16e-34ca-a514-19c702df1158";
/** Real: the recording `seedFixtures` already caches, reused as a CF recommendation. */
const ONE_MORE_TIME_MBID = "60fa767a-d85d-4991-82bc-4294e0b11ae7";

/** Hand-authored ids. `f1x7u2e` in the first group makes them obvious in a dump. */
const CASSIUS_MBID = "f1x7u2e0-0001-4000-8000-000000000001";
const AIR_MBID = "f1x7u2e0-0002-4000-8000-000000000002";
const SEBASTIAN_MBID = "f1x7u2e0-0003-4000-8000-000000000003";
const BREAKBOT_MBID = "f1x7u2e0-0004-4000-8000-000000000004";

const rg = (
  id: string,
  title: string,
  date: string,
  primary: string,
  secondary: string[] = [],
  genres: string[] = [],
): Record<string, unknown> => ({
  id,
  title,
  "first-release-date": date,
  "primary-type": primary,
  "secondary-types": secondary,
  genres: genres.map((name) => ({ name, count: 5 })),
});

/**
 * The ListenBrainz user the fixture recommendations are recorded for.
 *
 * `listenbrainzUser` defaults to empty, so collaborative filtering is off until somebody sets
 * it. Setting it to this name in fixtures mode lights the block up without a network:
 * `mm settings set listenbrainzUser mm-fixtures`.
 */
export const FIXTURE_LB_USER = "mm-fixtures";

export async function seedDiscoverFixtures(db: Database = defaultDb()): Promise<number> {
  let rows = 0;
  const write = async (source: string, key: string, payload: unknown): Promise<void> => {
    await put(source, key, payload, { db, fetchedAt: FIXTURE_FETCHED_AT });
    rows += 1;
  };

  /* ---- the artist the signals will name, so it can be given an MBID ---- */
  await db
    .insert(artistsCache)
    .values({
      artistMbid: DAFT_PUNK_MBID,
      name: "Daft Punk",
      sortName: "Daft Punk",
      country: "FR",
      fetchedAt: FIXTURE_FETCHED_AT,
    })
    .onConflictDoNothing();

  /* ---- Daft Punk's release groups: one owned, five gaps, two of them filtered out ---- */
  await write("musicbrainz", `release-group?artist=${DAFT_PUNK_MBID}&limit=100&offset=0`, {
    "release-group-count": 7,
    "release-groups": [
      rg(DISCOVERY_RG_MBID, "Discovery", "2001-02-26", "Album", [], ["french house", "electronic"]),
      rg(
        "f1x7u2e0-0101-4000-8000-000000000101",
        "Homework",
        "1997-01-20",
        "Album",
        [],
        ["french house"],
      ),
      rg(
        "f1x7u2e0-0102-4000-8000-000000000102",
        "Human After All",
        "2005-03-14",
        "Album",
        [],
        ["electro"],
      ),
      rg(
        "f1x7u2e0-0103-4000-8000-000000000103",
        "Random Access Memories",
        "2013-05-17",
        "Album",
        [],
        ["disco"],
      ),
      rg("f1x7u2e0-0104-4000-8000-000000000104", "Alive 2007", "2007-11-19", "Album", ["Live"]),
      rg("f1x7u2e0-0105-4000-8000-000000000105", "Musique, Volume 1", "2006-03-27", "Album", [
        "Compilation",
      ]),
      rg("f1x7u2e0-0106-4000-8000-000000000106", "Da Funk", "1995-11-01", "Single"),
    ],
  });

  /* ---- who ListenBrainz says sounds like them ---- */
  await write("listenbrainz", `similar-artists/${DAFT_PUNK_MBID}`, [
    { artist_mbid: CASSIUS_MBID, name: "Cassius", score: 980, reference_mbid: DAFT_PUNK_MBID },
    { artist_mbid: AIR_MBID, name: "Air", score: 870, reference_mbid: DAFT_PUNK_MBID },
    { artist_mbid: SEBASTIAN_MBID, name: "SebastiAn", score: 810, reference_mbid: DAFT_PUNK_MBID },
    { artist_mbid: BREAKBOT_MBID, name: "Breakbot", score: 760, reference_mbid: DAFT_PUNK_MBID },
  ]);

  /* ---- and what those artists have made, so a similar artist becomes an importable record ---- */
  await write("musicbrainz", `release-group?artist=${CASSIUS_MBID}&limit=100&offset=0`, {
    "release-group-count": 2,
    "release-groups": [
      rg(
        "f1x7u2e0-0201-4000-8000-000000000201",
        "1999",
        "1999-01-25",
        "Album",
        [],
        ["french house"],
      ),
      rg(
        "f1x7u2e0-0202-4000-8000-000000000202",
        "Dreems",
        "2019-06-21",
        "Album",
        [],
        ["french house"],
      ),
    ],
  });
  await write("musicbrainz", `release-group?artist=${AIR_MBID}&limit=100&offset=0`, {
    "release-group-count": 2,
    "release-groups": [
      rg(
        "f1x7u2e0-0203-4000-8000-000000000203",
        "Moon Safari",
        "1998-01-16",
        "Album",
        [],
        ["downtempo"],
      ),
      rg(
        "f1x7u2e0-0204-4000-8000-000000000204",
        "Talkie Walkie",
        "2004-01-26",
        "Album",
        [],
        ["electronic"],
      ),
    ],
  });
  await write("musicbrainz", `release-group?artist=${SEBASTIAN_MBID}&limit=100&offset=0`, {
    "release-group-count": 1,
    "release-groups": [
      rg("f1x7u2e0-0205-4000-8000-000000000205", "Total", "2011-05-30", "Album", [], ["electro"]),
    ],
  });
  await write("musicbrainz", `release-group?artist=${BREAKBOT_MBID}&limit=100&offset=0`, {
    "release-group-count": 1,
    "release-groups": [
      rg(
        "f1x7u2e0-0206-4000-8000-000000000206",
        "By Your Side",
        "2012-09-03",
        "Album",
        [],
        ["french house"],
      ),
    ],
  });

  /* ---- collaborative filtering, for whoever sets `listenbrainzUser` to the fixture user ---- */
  await write("listenbrainz", `cf/recommendation/user/${FIXTURE_LB_USER}/recording?count=100`, {
    payload: {
      user_name: FIXTURE_LB_USER,
      count: 1,
      mbids: [{ recording_mbid: ONE_MORE_TIME_MBID, score: 0.94 }],
    },
  });

  return rows;
}
