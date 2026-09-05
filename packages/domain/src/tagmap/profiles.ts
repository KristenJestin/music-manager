/**
 * Consumer profiles — what a server or a player actually *reads*
 * (`docs/03-metadonnees.md` §5).
 *
 * A profile never changes what we write. We always write the whole superset. A profile
 * serves three purposes and no other:
 *  1. showing “visible in X” in the Console,
 *  2. computing a completeness score “as seen by X” (§6),
 *  3. driving the read-back verification of §7.
 *
 * Adding a server is adding a profile here. It is never a reason to re-tag anything.
 *
 * `reads` lists `TagDefinition.field` names; `profiles.test.ts` asserts every one of them
 * exists in the tag map, so a profile can never drift away from the table.
 */

import { TAGS } from "./tags.ts";

export const PROFILE_IDS = ["navidrome", "jellyfin", "plex", "kodi", "lms", "players"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

/**
 * `verified` means the list was read off the consumer's own mapping file or confirmed by a
 * read-back run (§7). Everything else is a documented best guess.
 */
export type ProfileStatus = "verified" | "unconfirmed";

export interface ConsumerProfile {
  readonly id: ProfileId;
  readonly name: string;
  readonly kind: "server" | "player";
  readonly status: ProfileStatus;
  /** Clients that reach the library through this consumer. */
  readonly via: string;
  /** `TagDefinition.field` names this consumer indexes. */
  readonly reads: readonly string[];
  /** Sidecar files it picks up (§3). */
  readonly sidecars: readonly string[];
  /** Accepted lyrics carriers, best first. */
  readonly lyrics: readonly string[];
  readonly note: string;
}

/** The tags every consumer in this list reads; spelled once to keep the profiles readable. */
const CORE = [
  "title",
  "artist",
  "album",
  "albumartist",
  "tracknumber",
  "totaltracks",
  "discnumber",
  "totaldiscs",
  "date",
  "genre",
  "compilation",
  "comment",
  "front_cover",
] as const;

const SORTS = ["titlesort", "artistsort", "albumsort", "albumartistsort", "composersort"] as const;

const CREDIT_ROLES = [
  "composer",
  "lyricist",
  "arranger",
  "conductor",
  "producer",
  "engineer",
  "mixer",
  "remixer",
  "djmixer",
  "director",
  "performer",
] as const;

const MBIDS = [
  "musicbrainz_recordingid",
  "musicbrainz_releasetrackid",
  "musicbrainz_albumid",
  "musicbrainz_releasegroupid",
  "musicbrainz_artistid",
  "musicbrainz_albumartistid",
] as const;

const REPLAYGAIN = [
  "replaygain_track_gain",
  "replaygain_track_peak",
  "replaygain_album_gain",
  "replaygain_album_peak",
] as const;

export const PROFILES: readonly ConsumerProfile[] = Object.freeze([
  {
    id: "navidrome",
    name: "Navidrome",
    kind: "server",
    status: "verified",
    via: "OpenSubsonic → Feishin, Symfonium",
    reads: [
      ...CORE,
      ...SORTS,
      ...CREDIT_ROLES,
      ...MBIDS,
      ...REPLAYGAIN,
      "artists",
      "albumartists",
      "albumcomment",
      "subtitle",
      "discsubtitle",
      "releasedate",
      "originaldate",
      "originalyear",
      "releasetype",
      "media",
      "label",
      "catalognumber",
      "mood",
      "grouping",
      "work",
      "movement",
      "movementnumber",
      "isrc",
      "bpm",
      "lyrics",
      "explicit",
      "musicmanager_sourceurl",
    ],
    sidecars: ["cover.jpg", "artist.jpg", "NN Title.lrc"],
    lyrics: [".lrc sidecar (preferred)", "LYRICS synced", "LYRICS plain"],
    note: "Derived from resources/mappings.yaml of the deployed version, checked 2026-09. The reference profile.",
  },
  {
    id: "jellyfin",
    name: "Jellyfin / Emby",
    kind: "server",
    status: "unconfirmed",
    via: "Jellyfin web, Finamp, Symfonium",
    reads: [
      ...CORE,
      ...SORTS,
      ...CREDIT_ROLES,
      ...MBIDS,
      ...REPLAYGAIN,
      "artists",
      "albumartists",
      "discsubtitle",
      "originaldate",
      "originalyear",
      "mood",
      "grouping",
      "isrc",
      "bpm",
      "lyrics",
      "language",
      "copyright",
    ],
    sidecars: ["cover.jpg", "artist.jpg", "album.nfo", "artist.nfo", "NN Title.lrc"],
    lyrics: [".lrc sidecar", "LYRICS plain"],
    note: "Standard tags plus NFO and .lrc. To confirm by read-back (§7).",
  },
  {
    id: "plex",
    name: "Plex / Plexamp",
    kind: "server",
    status: "unconfirmed",
    via: "Plex clients, Plexamp",
    reads: [
      ...CORE,
      "artists",
      "albumartists",
      "composer",
      "producer",
      "conductor",
      "lyricist",
      "performer",
      "mood",
      "originaldate",
      "originalyear",
      "label",
      "isrc",
      "bpm",
      "lyrics",
      "explicit",
      "copyright",
      ...REPLAYGAIN,
    ],
    sidecars: ["cover.jpg", "artist.jpg"],
    lyrics: [".lrc sidecar"],
    note: "Standard tags and folder images. Plex runs its own matcher and ignores MusicBrainz identifiers entirely — none of the MUSICBRAINZ_* fields appear above. To confirm.",
  },
  {
    id: "kodi",
    name: "Kodi",
    kind: "server",
    status: "unconfirmed",
    via: "Kodi music library",
    reads: [
      ...CORE,
      ...SORTS,
      ...CREDIT_ROLES,
      ...MBIDS,
      ...REPLAYGAIN,
      "artists",
      "albumartists",
      "discsubtitle",
      "originaldate",
      "originalyear",
      "releasetype",
      "releasestatus",
      "media",
      "label",
      "catalognumber",
      "mood",
      "grouping",
      "work",
      "isrc",
      "bpm",
      "lyrics",
      "language",
      "copyright",
      "musicbrainz_workid",
    ],
    sidecars: ["cover.jpg", "artist.jpg", "album.nfo", "artist.nfo"],
    lyrics: ["LYRICS plain"],
    note: "The most complete tag reader of the list: roles, ARTISTS, MOOD, RELEASETYPE. To confirm.",
  },
  {
    id: "lms",
    name: "Lyrion (LMS)",
    kind: "server",
    status: "unconfirmed",
    via: "Squeezebox / piCorePlayer / Material skin",
    reads: [
      ...CORE,
      ...SORTS,
      ...CREDIT_ROLES,
      ...MBIDS,
      ...REPLAYGAIN,
      "artists",
      "albumartists",
      "discsubtitle",
      "originaldate",
      "releasetype",
      "label",
      "catalognumber",
      "mood",
      "grouping",
      "work",
      "movement",
      "movementnumber",
      "movementtotal",
      "musicbrainz_workid",
      "isrc",
      "bpm",
      "lyrics",
    ],
    sidecars: ["cover.jpg", "artist.jpg"],
    lyrics: ["LYRICS plain"],
    note: "Standard tags, MBIDs, RELEASETYPE, WORK / MOVEMENT. To confirm.",
  },
  {
    id: "players",
    name: "Local players",
    kind: "player",
    status: "unconfirmed",
    via: "MusicBee, foobar2000, Symfonium local, Poweramp",
    reads: [
      ...CORE,
      ...SORTS,
      "artists",
      "albumartists",
      "composer",
      "conductor",
      "performer",
      "remixer",
      "grouping",
      "bpm",
      "key",
      "lyrics",
      "isrc",
      ...REPLAYGAIN,
      "r128_track_gain",
      "r128_album_gain",
    ],
    sidecars: ["cover.jpg", "NN Title.lrc"],
    lyrics: [".lrc sidecar", "LYRICS synced"],
    note: "Read the files straight off the shared volume, with no server in between. To confirm.",
  },
]);

const BY_ID = new Map(PROFILES.map((profile) => [profile.id, profile]));

export function profileById(id: ProfileId): ConsumerProfile {
  const profile = BY_ID.get(id);
  // PROFILE_IDS and PROFILES are built together; this is unreachable but cheap to guard.
  if (profile === undefined) throw new Error(`unknown consumer profile: ${id}`);
  return profile;
}

/** How many tags of the superset a profile is not known to read — the “unknown” column. */
export function unreadCount(profile: ConsumerProfile): number {
  const reads = new Set(profile.reads);
  return TAGS.filter((tag) => !reads.has(tag.field)).length;
}
