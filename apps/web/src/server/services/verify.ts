/**
 * `verify.service` — the read-back of `docs/03-metadonnees.md` §7 (decision 009).
 *
 * The pipeline's last step does not re-read the file it just wrote. Re-reading a file only
 * proves that mutagen can read mutagen; what the operator actually wants to know is whether
 * **Feishin and Symfonium will show the tag**, and the only thing that answers that is the
 * server they go through. So `verify` asks Navidrome.
 *
 * The comparison is deliberately three-valued, and the third value is the interesting one:
 *
 *  - `ok`          — written, and the server gives it back;
 *  - `mismatch`    — written, and the server gives back something else;
 *  - `not_indexed` — written, and the server does not expose it at all.
 *
 * `not_indexed` is **information, not a failure**: it says "this Navidrome version has no
 * slot for MOOD", which is a fact about the consumer, not a defect in our tags. Only a
 * *required* field (level R of the tag map, §2) that comes back `mismatch` raises a
 * `verify_mismatch` Inbox item — anything looser would train the operator to ignore the Inbox.
 *
 * What is compared is the **projection**, not the document: the Vorbis pairs the toolbox was
 * actually handed. That keeps this file honest — it can only ever claim we wrote something we
 * really did write.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { projectDocument, tagByField, type TrackDocument } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  type LibraryAlbum,
  type LibraryTrack,
} from "#/server/db/schema/index.ts";
import { NavidromeClient } from "#/server/integrations/navidrome/client.ts";
import type { SubsonicAlbum, SubsonicSong } from "#/server/integrations/navidrome/types.ts";
import { closeLibraryItem, openLibraryItem } from "#/server/services/library-inbox.ts";
import { navidromeClient } from "#/server/services/navidrome.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

export type VerifyStatus = "ok" | "mismatch" | "not_indexed";

/** One compared field: what we wrote, what came back, and the verdict. */
export interface VerifyField {
  /** The name shown in the Console — `artists[]`, `replayGain.trackGain`. */
  readonly name: string;
  /** The tag-map field it comes from, when there is exactly one. */
  readonly field: string | null;
  /** Level R of the tag map. A `mismatch` here is what opens an Inbox item. */
  readonly required: boolean;
  readonly written: string;
  readonly read: string;
  readonly status: VerifyStatus;
}

/** What is stored in `library_albums.verification`. */
export interface AlbumVerification {
  readonly at: string;
  readonly server: string;
  readonly serverVersion: string;
  /** The album's id **inside Navidrome**, so the Console can deep-link. */
  readonly navidromeAlbumId: string | null;
  readonly scanCount: number | null;
  readonly songCount: number | null;
  readonly fields: readonly VerifyField[];
  readonly ok: number;
  readonly mismatches: number;
  readonly notIndexed: number;
  /** Names of the *required* fields that came back wrong. Empty means the album is clean. */
  readonly requiredMismatches: readonly string[];
  /** Set when the album could not be found at all. */
  readonly note: string | null;
}

export interface VerifyOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly client?: NavidromeClient;
  /** Ask for a scan first. Defaults to the `navidromeRescanOnVerify` setting. */
  readonly rescan?: boolean;
  readonly signal?: AbortSignal;
  /** Journal sink, so the step can route its lines onto the import. */
  readonly say?: (message: string, data?: Record<string, unknown>) => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* comparing one field                                                 */
/* ------------------------------------------------------------------ */

/** True when the server said nothing at all about this field. */
function absent(read: unknown): boolean {
  if (read === undefined || read === null || read === "") return true;
  if (Array.isArray(read)) return read.length === 0;
  // Navidrome answers `0` for a bpm it does not have, which is "absent", not "zero beats".
  if (read === 0) return true;
  return false;
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item !== "");
  return value === undefined || value === null ? [] : [String(value)];
}

/**
 * Compare one field.
 *
 * Order is not part of the contract on the way back — Navidrome sorts genres alphabetically,
 * and any server is free to. Case-insensitive **set** equality is what "the value survived"
 * honestly means. A field we never wrote is not compared at all; the caller drops it.
 */
export function compareField(
  name: string,
  field: string | null,
  written: readonly string[],
  read: unknown,
): VerifyField {
  const definition = field === null ? undefined : tagByField(field);
  const required = definition?.level === "required";
  const writtenText = written.join(", ");

  if (absent(read)) {
    return { name, field, required, written: writtenText, read: "—", status: "not_indexed" };
  }

  const values = toList(read);
  const left = new Set(written.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const right = new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const same = left.size === right.size && [...left].every((value) => right.has(value));
  return {
    name,
    field,
    required,
    written: writtenText,
    read: values.join(", "),
    status: same ? "ok" : "mismatch",
  };
}

/** Navidrome returns `{year, month, day}` for the two release dates. */
function isoDate(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const parts = value as { year?: number; month?: number; day?: number };
  if (parts.year === undefined || parts.year === 0) return null;
  const out = [String(parts.year).padStart(4, "0")];
  if (parts.month) out.push(String(parts.month).padStart(2, "0"));
  if (parts.day) out.push(String(parts.day).padStart(2, "0"));
  return out.join("-");
}

/** ReplayGain comes back as a float; compare it at the precision we wrote. */
function gain(value: unknown): string | null {
  return typeof value === "number" && value !== 0 ? value.toFixed(2) : null;
}

function names(list: readonly { name?: string }[] | undefined): string[] {
  return (list ?? []).map((item) => item.name ?? "").filter((name) => name !== "");
}

/* ------------------------------------------------------------------ */
/* what we wrote                                                       */
/* ------------------------------------------------------------------ */

/** The projected Vorbis pairs of one document, grouped by tag-map field. */
export function writtenValues(document: TrackDocument): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tag of projectDocument(document, "vorbis")) {
    const held = out.get(tag.field);
    if (held === undefined) out.set(tag.field, [tag.value]);
    else held.push(tag.value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* finding the album in Navidrome                                      */
/* ------------------------------------------------------------------ */

/**
 * Locate the album the way a human would, in the order that is least likely to be wrong.
 *
 *  1. by **release MBID**, which is unambiguous when both sides have it;
 *  2. by title, keeping the entry whose album artist also matches;
 *  3. by title alone, if exactly one album carries it.
 *
 * Anything else is reported as "not found" rather than guessed at: a read-back that verified
 * the wrong album would be worse than one that verified nothing.
 */
export async function locateAlbum(
  client: NavidromeClient,
  album: Pick<LibraryAlbum, "title" | "albumArtist" | "releaseMbid">,
): Promise<SubsonicAlbum | null> {
  const found = await client.search3(album.title, { albumCount: 50 });
  const candidates = found.album ?? [];
  if (candidates.length === 0) return null;

  const same = (left: string | undefined, right: string): boolean =>
    (left ?? "").trim().toLowerCase() === right.trim().toLowerCase();

  if (album.releaseMbid !== null && album.releaseMbid !== "") {
    const byMbid = candidates.find((entry) => entry.musicBrainzId === album.releaseMbid);
    if (byMbid !== undefined) return await hydrate(client, byMbid);
  }

  const byBoth = candidates.filter(
    (entry) => same(entry.name, album.title) && same(entry.artist, album.albumArtist),
  );
  if (byBoth.length === 1 && byBoth[0] !== undefined) return await hydrate(client, byBoth[0]);

  const byTitle = candidates.filter((entry) => same(entry.name, album.title));
  if (byTitle.length === 1 && byTitle[0] !== undefined) return await hydrate(client, byTitle[0]);

  return null;
}

/** `search3` returns a summary; `getAlbum` is what carries the songs and the album fields. */
async function hydrate(client: NavidromeClient, summary: SubsonicAlbum): Promise<SubsonicAlbum> {
  const full = await client.getAlbum(summary.id);
  return full ?? summary;
}

/* ------------------------------------------------------------------ */
/* the comparison table                                                */
/* ------------------------------------------------------------------ */

export interface ReadBack {
  readonly album: SubsonicAlbum;
  readonly song: SubsonicSong;
  readonly syncedLyrics: boolean;
  readonly coverOk: boolean;
}

/**
 * The seventeen rows of §7, for one album and its first track.
 *
 * One track is enough and one track is right: the album-scoped fields are identical across
 * the album by construction (§2 "Notes de forme" — a server that sees them diverge splits the
 * album in two), and the per-track fields are compared on a track we can name.
 */
export function compareAlbum(written: Map<string, string[]>, read: ReadBack): VerifyField[] {
  const { album, song } = read;
  const wrote = (field: string): string[] => written.get(field) ?? [];

  const rows: (VerifyField | null)[] = [
    row("title", "title", wrote("title"), song.title),
    row("albumArtist", "albumartist", wrote("albumartist"), album.artist),
    row(
      "artists[]",
      "artists",
      wrote("artists").length > 0 ? wrote("artists") : wrote("artist"),
      names(song.artists).length > 0 ? names(song.artists) : song.artist,
    ),
    row("album", "album", wrote("album"), album.name),
    row("year", "date", wrote("date").map(yearOf), album.year),
    row("originalReleaseDate", "originaldate", wrote("originaldate"), isoDate(album.originalReleaseDate)),
    row("genres[]", "genre", wrote("genre"), names(album.genres)),
    row("moods[]", "mood", wrote("mood"), album.moods),
    row("releaseTypes[]", "releasetype", wrote("releasetype"), album.releaseTypes),
    row("recordLabels[]", "label", wrote("label"), names(album.recordLabels)),
    row(
      "discTitles[]",
      "discsubtitle",
      wrote("discsubtitle"),
      (album.discTitles ?? []).map((entry) => entry.title ?? "").filter(Boolean),
    ),
    row(
      "replayGain.trackGain",
      "replaygain_track_gain",
      wrote("replaygain_track_gain").map(decibels),
      gain(song.replayGain?.trackGain),
    ),
    row(
      "replayGain.albumGain",
      "replaygain_album_gain",
      wrote("replaygain_album_gain").map(decibels),
      gain(song.replayGain?.albumGain),
    ),
    row(
      "synced lyrics",
      "lyrics",
      wrote("lyrics").length > 0 ? ["synced"] : [],
      read.syncedLyrics ? "synced" : null,
    ),
    row("bpm", "bpm", wrote("bpm"), song.bpm),
    row("isrc", "isrc", wrote("isrc"), song.isrc),
    row(
      "musicBrainzId",
      "musicbrainz_recordingid",
      wrote("musicbrainz_recordingid"),
      song.musicBrainzId,
    ),
    row(
      "explicitStatus",
      "explicit",
      wrote("explicit").map((value) => (value === "1" ? "explicit" : "clean")),
      song.explicitStatus,
    ),
    row(
      "contributors",
      "performer",
      wrote("performer").map((value) => value.replace(/\s*\(.*\)$/, "")),
      (song.contributors ?? []).map((entry) => entry.artist?.name ?? "").filter(Boolean),
    ),
    row("coverArt", "front_cover", ["front cover"], read.coverOk ? "front cover" : null),
  ];

  return rows.filter((entry): entry is VerifyField => entry !== null);

  /** A field we never wrote is not a verdict — it is simply not part of this table. */
  function row(
    name: string,
    field: string,
    values: readonly string[],
    got: unknown,
  ): VerifyField | null {
    if (values.length === 0) return null;
    return compareField(name, field, values, got);
  }
}

const yearOf = (value: string): string => value.slice(0, 4);
/** We write `-8.10 dB`; the server answers `-8.1`. Compare the number, not the unit. */
const decibels = (value: string): string => {
  const parsed = Number.parseFloat(value.replace(/\s*dB$/i, "").replace("−", "-"));
  return Number.isNaN(parsed) ? value : parsed.toFixed(2);
};

/* ------------------------------------------------------------------ */
/* the whole album                                                     */
/* ------------------------------------------------------------------ */

export interface AlbumSubject {
  readonly album: LibraryAlbum;
  readonly tracks: readonly LibraryTrack[];
  readonly document: TrackDocument | null;
}

/** Everything the read-back needs about one album, in two queries. */
export async function albumSubject(
  albumId: string,
  db: Database = defaultDb(),
): Promise<AlbumSubject> {
  const [album] = await db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);
  if (album === undefined) {
    throw new MMError("NOT_FOUND", `No library album with id ${albumId}.`, {
      hint: "Run `mm verify --all` to list what there is.",
    });
  }

  const tracks = await db
    .select()
    .from(libraryTracks)
    .where(eq(libraryTracks.albumId, albumId))
    .orderBy(asc(libraryTracks.discNumber), asc(libraryTracks.trackNumber));

  const first = tracks[0];
  if (first === undefined) return { album, tracks, document: null };

  const [row] = await db
    .select({ document: metadataDocuments.document })
    .from(metadataDocuments)
    .where(eq(metadataDocuments.libraryTrackId, first.id))
    .limit(1);

  return {
    album,
    tracks,
    document: row === undefined ? null : (row.document as unknown as TrackDocument),
  };
}

/**
 * Read one album back and store the verdict.
 *
 * Every failure mode here is a *result*, not an exception: an album Navidrome has never seen
 * is a legitimate outcome of a verification and belongs in the table with a note, because
 * "placed after the last scan" is the single most common thing this step finds.
 */
export async function verifyAlbum(
  albumId: string,
  options: VerifyOptions = {},
): Promise<AlbumVerification> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const client = options.client ?? navidromeClient(settings);
  const say = options.say ?? (async () => {});

  const subject = await albumSubject(albumId, db);
  const identity = await client.ping();

  if (options.rescan ?? settings.navidromeRescanOnVerify) {
    await say("Asking Navidrome to scan.");
    await client.startScan();
    const status = await client.waitForScan({
      timeoutMs: settings.navidromeWaitTimeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await say(`Navidrome finished scanning ${String(status.count ?? 0)} files.`);
  }

  const found = await locateAlbum(client, subject.album);
  const at = new Date().toISOString();

  if (found === null || subject.document === null) {
    const note =
      found === null
        ? "Navidrome has not indexed this album yet. It is usually a scan that has not run since the album was placed."
        : "No metadata document is attached to this album's first track, so there is nothing to compare against.";
    const verification: AlbumVerification = {
      at,
      server: identity.type,
      serverVersion: identity.serverVersion,
      navidromeAlbumId: found?.id ?? null,
      scanCount: null,
      songCount: found?.songCount ?? null,
      fields: [],
      ok: 0,
      mismatches: 0,
      notIndexed: 0,
      requiredMismatches: [],
      note,
    };
    await persist(db, albumId, verification);
    return verification;
  }

  const songs = found.song ?? [];
  const firstSong = songs.find((entry) => entry.track === 1) ?? songs[0];
  if (firstSong === undefined) {
    const verification: AlbumVerification = {
      at,
      server: identity.type,
      serverVersion: identity.serverVersion,
      navidromeAlbumId: found.id,
      scanCount: null,
      songCount: 0,
      fields: [],
      ok: 0,
      mismatches: 0,
      notIndexed: 0,
      requiredMismatches: [],
      note: "Navidrome knows the album but lists no track in it.",
    };
    await persist(db, albumId, verification);
    return verification;
  }

  // `getSong` carries fields `getAlbum`'s embedded song list does not always fill in.
  const song = (await client.getSong(firstSong.id)) ?? firstSong;
  const lyrics = await client.getLyricsBySongId(firstSong.id);
  const cover = await client.getCoverArt(found.coverArt ?? found.id, 200);

  const fields = compareAlbum(writtenValues(subject.document), {
    album: found,
    song,
    syncedLyrics: lyrics.some((entry) => entry.synced === true),
    coverOk: cover.ok && cover.kind !== "",
  });

  const requiredMismatches = fields
    .filter((entry) => entry.required && entry.status === "mismatch")
    .map((entry) => entry.name);

  const verification: AlbumVerification = {
    at,
    server: identity.type,
    serverVersion: identity.serverVersion,
    navidromeAlbumId: found.id,
    scanCount: null,
    songCount: songs.length,
    fields,
    ok: fields.filter((entry) => entry.status === "ok").length,
    mismatches: fields.filter((entry) => entry.status === "mismatch").length,
    notIndexed: fields.filter((entry) => entry.status === "not_indexed").length,
    requiredMismatches,
    note: null,
  };

  await persist(db, albumId, verification);
  await raiseOrClearInbox(db, subject.album, verification);
  return verification;
}

async function persist(
  db: Database,
  albumId: string,
  verification: AlbumVerification,
): Promise<void> {
  await db
    .update(libraryAlbums)
    .set({
      verification: verification as unknown as Record<string, unknown>,
      verifiedAt: new Date(verification.at),
      updatedAt: new Date(),
    })
    .where(eq(libraryAlbums.id, albumId));
}

/**
 * One Inbox item per album, opened on a required mismatch and closed when it goes away.
 *
 * Closing matters as much as opening: an Inbox that keeps an item after the problem is fixed
 * is an Inbox nobody reads.
 */
async function raiseOrClearInbox(
  db: Database,
  album: LibraryAlbum,
  verification: AlbumVerification,
): Promise<void> {
  if (verification.requiredMismatches.length === 0) {
    await closeLibraryItem("verify_mismatch", album.id, db);
    return;
  }
  const wrong = verification.fields.filter(
    (entry) => entry.required && entry.status === "mismatch",
  );
  await openLibraryItem(
    {
      type: "verify_mismatch",
      subject: album.id,
      title: `${album.albumArtist} — ${album.title}: ${String(wrong.length)} required field(s) read back wrong`,
      summary: wrong
        .map((entry) => `${entry.name}: wrote ${entry.written}, read ${entry.read}`)
        .join(" · "),
      payload: {
        libraryAlbumId: album.id,
        navidromeAlbumId: verification.navidromeAlbumId,
        fields: wrong.map((entry) => ({ ...entry })),
      },
      preselected: { action: "retag", libraryAlbumId: album.id },
    },
    db,
  );
}

/* ------------------------------------------------------------------ */
/* the whole library                                                   */
/* ------------------------------------------------------------------ */

export interface LibraryVerifyReport {
  readonly total: number;
  readonly verified: number;
  readonly clean: number;
  readonly withMismatch: number;
  readonly notFound: number;
  readonly albums: readonly {
    readonly id: string;
    readonly title: string;
    readonly albumArtist: string;
    readonly mismatches: number;
    readonly notIndexed: number;
    readonly note: string | null;
  }[];
}

/**
 * Verify every album, scanning **once** for all of them.
 *
 * A per-album rescan would mean one full Navidrome scan per album, which on a real library is
 * minutes each. The scan happens here, before the loop, and each album is then read back with
 * `rescan: false`.
 */
export async function verifyLibrary(options: VerifyOptions = {}): Promise<LibraryVerifyReport> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const client = options.client ?? navidromeClient(settings);
  const say = options.say ?? (async () => {});

  if (options.rescan ?? settings.navidromeRescanOnVerify) {
    await client.startScan();
    await client.waitForScan({
      timeoutMs: settings.navidromeWaitTimeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  const albums = await db.select().from(libraryAlbums).orderBy(asc(libraryAlbums.folder));
  const rows: LibraryVerifyReport["albums"][number][] = [];
  let clean = 0;
  let withMismatch = 0;
  let notFound = 0;

  for (const album of albums) {
    if (options.signal?.aborted === true) break;
    const verification = await verifyAlbum(album.id, {
      db,
      settings,
      client,
      rescan: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      say: options.say ?? (async () => {}),
    });
    if (verification.note !== null) notFound += 1;
    else if (verification.mismatches > 0) withMismatch += 1;
    else clean += 1;
    rows.push({
      id: album.id,
      title: album.title,
      albumArtist: album.albumArtist,
      mismatches: verification.mismatches,
      notIndexed: verification.notIndexed,
      note: verification.note,
    });
    await say(`Verified ${album.albumArtist} — ${album.title}.`);
  }

  return {
    total: albums.length,
    verified: rows.length,
    clean,
    withMismatch,
    notFound,
    albums: rows,
  };
}

/** The stored verdicts, for the Console and for `mm verify --all`. */
export async function storedVerifications(
  albumIds: readonly string[],
  db: Database = defaultDb(),
): Promise<Map<string, AlbumVerification>> {
  if (albumIds.length === 0) return new Map();
  const rows = await db
    .select({ id: libraryAlbums.id, verification: libraryAlbums.verification })
    .from(libraryAlbums)
    .where(and(inArray(libraryAlbums.id, [...albumIds])));
  const out = new Map<string, AlbumVerification>();
  for (const row of rows) {
    if (row.verification !== null) {
      out.set(row.id, row.verification as unknown as AlbumVerification);
    }
  }
  return out;
}
