/**
 * The reduced v1 database, as data (`docs/phases/P11-migration-v1.md` § Livrables).
 *
 * This file is the single source of truth for the v1 fixture. Two things are generated from
 * it and neither may be edited by hand:
 *
 *  - `dump.sql` — the reduced SQL dump, in v1's real schema (quoted PascalCase identifiers,
 *    enums as strings, `;`-joined lists). `bun run fixtures/v1/generate.ts` writes it.
 *  - `.local/…/` — the Opus files, copied from the toolbox's bundled five-second sample and
 *    tagged through `POST /tag` with **exactly** the tag set v1's `ApplyID3TagsInternal`
 *    writes. `build-library.ts` does that.
 *
 * Keeping them generated from one description is what stops the two halves of the fixture
 * drifting apart, which would make the reconciliation "pass" for the wrong reason.
 *
 * ## What the fixture is designed to prove
 *
 * Three albums, thirty `Songs` rows, and every case the phase names:
 *
 *  - **Daft Punk — Discovery (2001)**, thirteen rows, all `Present`, with the MusicBrainz ids
 *    of the *recorded* release. `documents.build` runs offline against the seeded raw cache,
 *    so this is the album on which "complete documents" is provable without a network.
 *    Track 3's file has been renamed behind v1's back, so it can only be found by its
 *    recording MBID.
 *  - **Justice — Woman Worldwide (2018)**, eight rows over **two discs**, no MusicBrainz ids
 *    at all — the common case of a v1 row whose lookup never succeeded. It exercises the
 *    `Disc N - ` prefix, the ` - ` separator, the `;`-joined lists and `SongForceMetadata`.
 *    Its last track was moved and carries no MBID, so it can only be found by the YouTube id
 *    in its comment.
 *  - **Birdy — Birdy (2011)**, nine rows: three `Present` with files, one `Present` whose file
 *    is gone, **two `Needed`** with forced MBIDs, one `NeedsManualReview`, one
 *    `DownloadFailed`, one `ProcessingFailed`.
 *
 * Plus one orphan file no row claims, and two `UserPlaylists`.
 */

export interface FixtureSong {
  readonly id: number;
  readonly sourceUrl: string;
  readonly sourceUrlParent: string | null;
  readonly sourceId: string;
  readonly sourceIdParent: string | null;
  readonly sourceTitle: string;
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly artist: string | null;
  readonly performers: readonly string[];
  readonly album: string | null;
  readonly isrc: string | null;
  readonly albumArtists: readonly string[];
  readonly year: number | null;
  readonly trackNumber: number | null;
  readonly trackCount: number | null;
  readonly discNumber: number | null;
  readonly discCount: number | null;
  readonly publisher: string | null;
  readonly genres: readonly string[];
  /** Milliseconds, as v1's `bigint` column holds it. */
  readonly duration: number | null;
  readonly downloadStatus: string;
  readonly finalFilePath: string | null;
  readonly errorMessage: string | null;
  readonly recordingMbid: string | null;
  readonly releaseMbid: string | null;
  readonly releaseGroupMbid: string | null;
  readonly artistMbid: string | null;
  readonly albumArtistMbid: string | null;
  readonly releaseStatus: string | null;
  readonly releaseCountry: string | null;
  readonly musicBrainzForced: boolean;
  readonly recordingMbidForce: string | null;
  readonly releaseMbidForce: string | null;
  readonly forceSongMetadata: boolean;
  readonly forceSourceMetadata: boolean;
  /**
   * Where the file really is, when that is not what `FinalFilePath` says. `null` means "no
   * file at all" — the row is `Needed`, failed, or a `Present` whose file went missing.
   */
  readonly realPath?: string | null;
}

export interface FixtureForce {
  readonly id: number;
  readonly songId: number;
  readonly field: string;
  readonly value: string;
  readonly isArrayValue: boolean;
}

export interface FixturePlaylist {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
  readonly songIds: readonly number[];
}

/* ------------------------------------------------------------------ */
/* constants shared by the three albums                                */
/* ------------------------------------------------------------------ */

const DISCOVERY = {
  release: "d073287b-d1bd-4f11-a933-a4386f8cf701",
  releaseGroup: "48117b90-a16e-34ca-a514-19c702df1158",
  artist: "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
} as const;

/** The first thirteen tracks of the recorded release, verbatim. */
const DISCOVERY_TRACKS: readonly {
  position: number;
  title: string;
  recording: string;
  lengthMs: number;
}[] = [
  {
    position: 1,
    title: "One More Time",
    recording: "60fa767a-d85d-4991-82bc-4294e0b11ae7",
    lengthMs: 320840,
  },
  {
    position: 2,
    title: "Aerodynamic",
    recording: "7c0e11a3-1c7a-4e6d-a14d-6e86d86dbaad",
    lengthMs: 207533,
  },
  {
    position: 3,
    title: "Digital Love",
    recording: "15f16efc-8762-4151-95ab-c12d06268640",
    lengthMs: 298333,
  },
  {
    position: 4,
    title: "Harder, Better, Faster, Stronger",
    recording: "f1a6a40f-78f5-4918-968d-f64363bae94c",
    lengthMs: 224293,
  },
  {
    position: 5,
    title: "Crescendolls",
    recording: "d63ad586-1124-4df1-9a2b-c014d7b7cb02",
    lengthMs: 211640,
  },
  {
    position: 6,
    title: "Nightvision",
    recording: "712edd8d-b413-4e4e-aca4-9b91fce2e65c",
    lengthMs: 104466,
  },
  {
    position: 7,
    title: "Superheroes",
    recording: "8a98614f-0533-44ef-890a-639cab407a2d",
    lengthMs: 237800,
  },
  {
    position: 8,
    title: "High Life",
    recording: "07b720fc-0d6f-4342-a6df-876d1749de0b",
    lengthMs: 201800,
  },
  {
    position: 9,
    title: "Something About Us",
    recording: "defbfcb2-7a5c-4456-be28-b7e5ccf92cc2",
    lengthMs: 231066,
  },
  {
    position: 10,
    title: "Voyager",
    recording: "e1fe1d12-dac2-4325-ae1b-25e0ef06b998",
    lengthMs: 227866,
  },
  {
    position: 11,
    title: "Veridis Quo",
    recording: "2a220770-1150-4190-b0e0-57d89a0a7469",
    lengthMs: 344893,
  },
  {
    position: 12,
    title: "Short Circuit",
    recording: "3f60ae01-43cc-4db9-86ec-97b79f83764f",
    lengthMs: 206866,
  },
  {
    position: 13,
    title: "Face to Face",
    recording: "59038571-03ea-4ca4-965c-a57eae2aa138",
    lengthMs: 240173,
  },
];

const DISCOVERY_PARENT = "https://www.youtube.com/playlist?list=OLAK5uy_v1discovery";

/**
 * v1's own path algorithm, reproduced here so the fixture states its expectations.
 *
 * The sanitisation is v1's Linux one — `Path.GetInvalidFileNameChars()` is `{ '\0', '/' }`
 * there — which matters for album B, whose mashup titles are full of slashes: `Safe and
 * Sound / D.A.N.C.E. / Fire` really is filed as `Safe and Sound _ D.A.N.C.E. _ Fire`, and a
 * migration that expected the slash would never find the file.
 */
function v1Sanitize(value: string): string {
  return value.replace(/\/+/g, "_").replace(/^[_. ]+|[_. ]+$/g, "");
}

function v1Path(
  artist: string,
  album: string,
  year: number,
  track: number,
  title: string,
  disc?: number,
): string {
  const stem = `${String(track).padStart(2, "0")} - ${v1Sanitize(title)}`;
  const withDisc = disc === undefined ? stem : `Disc ${String(disc)} - ${stem}`;
  // The year is appended *after* sanitising, which is why its parentheses survive.
  return `${v1Sanitize(artist)}/${v1Sanitize(album)} (${String(year)})/${withDisc}.opus`;
}

/* ------------------------------------------------------------------ */
/* album A — Daft Punk, Discovery                                      */
/* ------------------------------------------------------------------ */

const ALBUM_A: FixtureSong[] = DISCOVERY_TRACKS.map((track, index) => {
  const id = 100 + track.position;
  const path = v1Path("Daft Punk", "Discovery", 2001, track.position, track.title);
  // Track 3's file was renamed by hand after v1 wrote it. Neither `FinalFilePath` nor v1's own
  // algorithm predicts where it is now, so the only way to find it is its recording MBID.
  const moved = track.position === 3;
  return {
    id,
    sourceUrl: `https://www.youtube.com/watch?v=dpDiscovery${String(track.position).padStart(2, "0")}`,
    sourceUrlParent: DISCOVERY_PARENT,
    sourceId: `dpDiscovery${String(track.position).padStart(2, "0")}`,
    sourceIdParent: "OLAK5uy_v1discovery",
    sourceTitle: `Daft Punk - ${track.title} (Official Audio)`,
    title: track.title,
    subtitle: null,
    artist: "Daft Punk",
    performers: ["Daft Punk"],
    album: "Discovery",
    isrc: index === 0 ? "GBDUW0000059" : null,
    albumArtists: ["Daft Punk"],
    year: 2001,
    trackNumber: track.position,
    trackCount: 14,
    // v1 only fills DiscNumber when its lookup gave it one. This album is the case where it
    // did not, so its paths carry no `Disc N - ` prefix — the plain `NN - Title` shape.
    discNumber: null,
    discCount: null,
    publisher: "Virgin",
    genres: ["Electronic", "House"],
    duration: track.lengthMs,
    downloadStatus: "Present",
    finalFilePath: path,
    errorMessage: null,
    recordingMbid: track.recording,
    releaseMbid: DISCOVERY.release,
    releaseGroupMbid: DISCOVERY.releaseGroup,
    artistMbid: DISCOVERY.artist,
    albumArtistMbid: DISCOVERY.artist,
    releaseStatus: "Official",
    releaseCountry: "FR",
    musicBrainzForced: false,
    recordingMbidForce: null,
    releaseMbidForce: null,
    forceSongMetadata: false,
    forceSourceMetadata: false,
    realPath: moved ? "Daft Punk/Discovery (2001)/03 - Digital Love [remastered edit].opus" : path,
  };
});

/* ------------------------------------------------------------------ */
/* album B — Justice, Woman Worldwide: two discs, no MusicBrainz       */
/* ------------------------------------------------------------------ */

const WOMAN_PARENT = "https://www.youtube.com/playlist?list=OLAK5uy_v1woman";

const B_TITLES: readonly { disc: number; track: number; title: string }[] = [
  { disc: 1, track: 1, title: "Safe and Sound / D.A.N.C.E. / Fire" },
  { disc: 1, track: 2, title: "Genesis / Phantom Pt. II" },
  { disc: 1, track: 3, title: "Chorus / Randy" },
  { disc: 1, track: 4, title: "Stress / Waters of Nazareth" },
  { disc: 2, track: 1, title: "Alakazam! / Heavy Metal" },
  { disc: 2, track: 2, title: "Newlands / Pleasure" },
  { disc: 2, track: 3, title: "Love S.O.S. / Fire" },
  { disc: 2, track: 4, title: "We Are Your Friends" },
];

const ALBUM_B: FixtureSong[] = B_TITLES.map((entry, index) => {
  const id = 200 + index + 1;
  const path = v1Path("Justice", "Woman Worldwide", 2018, entry.track, entry.title, entry.disc);
  // The last track was renamed by hand and carries no MBID: the YouTube id in v1's comment
  // is the only thing left that can identify it. It stays in the album folder, so the album
  // is still one album — a file moved to another folder would rightly become another one.
  const moved = index === B_TITLES.length - 1;
  return {
    id,
    sourceUrl: `https://www.youtube.com/watch?v=jsWoman${String(index + 1).padStart(2, "0")}`,
    sourceUrlParent: WOMAN_PARENT,
    sourceId: `jsWoman${String(index + 1).padStart(2, "0")}`,
    sourceIdParent: "OLAK5uy_v1woman",
    sourceTitle: `Justice - ${entry.title}`,
    title: entry.title,
    subtitle: entry.disc === 2 ? "Live mix" : null,
    artist: "Justice",
    performers: ["Justice", "Gaspard Augé"],
    album: "Woman Worldwide",
    isrc: null,
    albumArtists: ["Justice"],
    year: 2018,
    trackNumber: entry.track,
    trackCount: 4,
    discNumber: entry.disc,
    discCount: 2,
    publisher: "Ed Banger Records",
    genres: ["Electronic", "French House", "Dance"],
    duration: 240000 + index * 1000,
    downloadStatus: "Present",
    finalFilePath: path,
    errorMessage: null,
    recordingMbid: null,
    releaseMbid: null,
    releaseGroupMbid: null,
    artistMbid: null,
    albumArtistMbid: null,
    releaseStatus: null,
    releaseCountry: null,
    musicBrainzForced: false,
    recordingMbidForce: null,
    releaseMbidForce: null,
    forceSongMetadata: true,
    forceSourceMetadata: false,
    realPath: moved ? "Justice/Woman Worldwide (2018)/we-are-your-friends.opus" : path,
  };
});

/* ------------------------------------------------------------------ */
/* album C — Birdy: every status that is not `Present`                 */
/* ------------------------------------------------------------------ */

const BIRDY_PARENT = "https://www.youtube.com/playlist?list=OLAK5uy_v1birdy";

interface BirdyRow {
  readonly track: number;
  readonly title: string;
  readonly status: string;
  readonly hasFile: boolean;
  readonly parent: string | null;
  readonly error?: string;
  readonly forcedRecording?: string;
  readonly forcedRelease?: string;
}

const C_ROWS: readonly BirdyRow[] = [
  { track: 1, title: "1901", status: "Present", hasFile: true, parent: BIRDY_PARENT },
  { track: 2, title: "Skinny Love", status: "Present", hasFile: true, parent: BIRDY_PARENT },
  {
    track: 3,
    title: "People Help the People",
    status: "Present",
    hasFile: true,
    parent: BIRDY_PARENT,
  },
  {
    track: 4,
    title: "White Winter Hymnal",
    status: "Present",
    hasFile: false,
    parent: BIRDY_PARENT,
    error: "the file was deleted outside v1",
  },
  // The two `Needed` rows of the acceptance criteria. No parent, so each becomes its own
  // import, and both carry a forced MBID that arrives in v2 as a preselection.
  {
    track: 5,
    title: "The District Sleeps Alone Tonight",
    status: "Needed",
    hasFile: false,
    parent: null,
    forcedRecording: "9d0dcd6b-e3b6-4d5a-9b21-4b6f10a7c3ee",
    forcedRelease: "3ac2e0d3-2c0d-4e1a-9f4a-6b1c19a2f7bd",
  },
  {
    track: 6,
    title: "Without a Word",
    status: "Needed",
    hasFile: false,
    parent: null,
    forcedRecording: "b2e2f18c-3a54-4a6d-8d5e-0f9b7b4a1c22",
    forcedRelease: "3ac2e0d3-2c0d-4e1a-9f4a-6b1c19a2f7bd",
  },
  {
    track: 7,
    title: "Terrible Love",
    status: "NeedsManualReview",
    hasFile: false,
    parent: BIRDY_PARENT,
    error: "three releases matched with the same score",
  },
  {
    track: 8,
    title: "Fire and Rain",
    status: "DownloadFailed",
    hasFile: false,
    parent: BIRDY_PARENT,
    error: "HTTP 403: Sign in to confirm you are not a bot",
  },
  {
    track: 9,
    title: "Shelter",
    status: "ProcessingFailed",
    hasFile: false,
    parent: BIRDY_PARENT,
    error: "ffmpeg exited 1",
  },
];

const ALBUM_C: FixtureSong[] = C_ROWS.map((row, index) => {
  const id = 300 + row.track;
  const path = v1Path("Birdy", "Birdy", 2011, row.track, row.title, 1);
  return {
    id,
    sourceUrl: `https://www.youtube.com/watch?v=birdy${String(row.track).padStart(2, "0")}xxxx`,
    sourceUrlParent: row.parent,
    sourceId: `birdy${String(row.track).padStart(2, "0")}xxxx`,
    sourceIdParent: row.parent === null ? null : "OLAK5uy_v1birdy",
    sourceTitle: `Birdy - ${row.title}`,
    title: row.title,
    subtitle: null,
    artist: "Birdy",
    performers: ["Birdy"],
    album: "Birdy",
    isrc: null,
    albumArtists: ["Birdy"],
    year: 2011,
    trackNumber: row.track,
    trackCount: 9,
    // DiscNumber 1 on a single-disc album. v1's condition is `DiscNumber >= 1`, not "more than
    // one disc", so these paths really do carry a `Disc 1 - ` prefix — the shape the phase
    // spec does not mention and a migration would otherwise fail to recognise.
    discNumber: 1,
    discCount: 1,
    publisher: "Warner Music UK",
    genres: ["Pop", "Indie"],
    duration: 200000 + index * 1500,
    downloadStatus: row.status,
    finalFilePath: row.status === "Needed" ? null : path,
    errorMessage: row.error ?? null,
    recordingMbid: null,
    releaseMbid: null,
    releaseGroupMbid: null,
    artistMbid: null,
    albumArtistMbid: null,
    releaseStatus: null,
    releaseCountry: null,
    musicBrainzForced: row.forcedRecording !== undefined,
    recordingMbidForce: row.forcedRecording ?? null,
    releaseMbidForce: row.forcedRelease ?? null,
    forceSongMetadata: false,
    forceSourceMetadata: false,
    realPath: row.hasFile ? path : null,
  };
});

/* ------------------------------------------------------------------ */
/* the fixture                                                         */
/* ------------------------------------------------------------------ */

export const FIXTURE_SONGS: readonly FixtureSong[] = [...ALBUM_A, ...ALBUM_B, ...ALBUM_C];

/**
 * `SongForceMetadata` — the overrides v1's owner typed in by hand.
 *
 * All on album B, which has no MusicBrainz data at all: they are the only good metadata that
 * album has, which is exactly why they must survive the migration **locked**.
 */
export const FIXTURE_FORCES: readonly FixtureForce[] = [
  { id: 1, songId: 201, field: "Genres", value: "French House;Electro", isArrayValue: true },
  { id: 2, songId: 201, field: "Publisher", value: "Ed Banger", isArrayValue: false },
  {
    id: 3,
    songId: 202,
    field: "Title",
    value: "Genesis (Woman Worldwide edit)",
    isArrayValue: false,
  },
  { id: 4, songId: 203, field: "AlbumArtists", value: "Justice; Gaspard Augé", isArrayValue: true },
  { id: 5, songId: 205, field: "DiscNumber", value: "2", isArrayValue: false },
  // A row whose field v2 has no home for: it must be reported as ignored, not silently lost.
  { id: 6, songId: 206, field: "CoverArtMimeType", value: "image/jpeg", isArrayValue: false },
];

export const FIXTURE_PLAYLISTS: readonly FixturePlaylist[] = [
  {
    id: 1,
    name: "Road trip",
    description: "The one that always plays",
    // Deliberately mixes migrated tracks with rows that were never downloaded, so the M3U
    // export has to show both.
    songIds: [101, 104, 301, 302, 305, 307],
  },
  {
    id: 2,
    name: "Focus / deep work",
    description: null,
    songIds: [201, 202, 203, 204, 205, 206, 207, 208],
  },
];

/**
 * A file under the v1 library that no `Songs` row claims.
 *
 * Every real v1 library has some: a manual copy, a leftover from a failed run, an album the
 * owner dropped in by hand. The migration must report it and must not adopt it.
 */
export const FIXTURE_ORPHANS: readonly { path: string; tags: Record<string, string> }[] = [
  {
    path: "Unsorted/Various/99 - Nobody Claims Me.opus",
    tags: { TITLE: "Nobody Claims Me", ARTIST: "Unknown", ALBUM: "Unsorted" },
  },
];

/** Every song that should end up with a file on disk, and where. */
export function filesToBuild(): { song: FixtureSong; path: string }[] {
  return FIXTURE_SONGS.flatMap((song) =>
    song.realPath == null ? [] : [{ song, path: song.realPath }],
  );
}
