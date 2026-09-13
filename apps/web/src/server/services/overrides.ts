/**
 * Manual per-field overrides — the clean equivalent of v1's `SongForceMetadata`.
 *
 * `docs/03-metadonnees.md` §1 says the document is computed by resolvers *from the raw cache
 * and your locks*. The locks half has existed since P05 and nothing in the application ever
 * wrote one: `setUserValue`, `lock` and `unlock` were called by their own tests and by
 * nobody else. This module is the missing caller, and it is deliberately the **only** one —
 * every surface (the Console, the two `PATCH …/fields` routes, the `set_field` MCP tool,
 * `mm doc set`) comes through `overrideTrackFields` or `overrideAlbumFields`.
 *
 * Three semantics, and they are not interchangeable:
 *
 *  - **a value** → `setConsoleValue`: the field is written, locked and taken out of `na`.
 *    `merge` keeps it through every rebuild, so this survives a re-tag, a source refresh and
 *    a schema bump without anybody re-typing it;
 *  - **no value, `locked: true`** → pin what the resolvers currently say. The value does not
 *    change; what changes is that the next rebuild can no longer change it either;
 *  - **no value, `locked: false`** → `removeField`, then an offline `rebuild`. Not "clear the
 *    flag": a `console` value sits at the head of `SOURCE_PRECEDENCE`, so an unlocked one
 *    would go on winning and "unlock" would be a lie. Removing it and re-resolving from the
 *    raw cache is what actually hands the field back.
 *
 * **Which row.** `metadata_documents` has two keys — `import_track_id`, which `documents.build`
 * re-reads its locks from, and `library_track_id`, which the track page and `relocate` read
 * by. They are the same row: `place` stamps the second onto the row the first created. The
 * write below goes through `documents.storeDocument`, keyed by `import_track_id`, precisely so
 * that a rebuild sees it; the page sees it because it is one row.
 *
 * **Album scope.** The 36 `albumScope` fields must carry one value across the album or servers
 * split it in two (§2.7). A lock typed on one track *would* propagate through
 * `resolveAlbumScope` at re-tag time — but only for tracks that re-tag brings along, so a
 * single-file re-tag would put the resolver's answer back on the other twelve. So an
 * album-scope field is written **on every track of the album, in one transaction**, and the
 * per-track entry point refuses it outright and names the album one. Two tracks therefore
 * cannot hold divergent locks on an album-scope field, because no code path can create the
 * second one.
 *
 * **What this never does.** It never moves a file. A change to `title` or `tracknumber`
 * changes where the path template says the file belongs, and moving it loses that track's
 * Navidrome play count and favourites — so a relocate **plan** comes back with the answer and
 * a person presses the button. It does queue a re-tag, with `onlyBehind: false`, because
 * nothing about the tag *schema* changed and a run filtered on "behind the schema" would find
 * nothing to do and report success without opening a file.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  ALBUM_SCOPE_FIELDS,
  removeField,
  setConsoleValue,
  tagByField,
  type FieldValue,
  type TagDefinition,
  type TrackDocument,
} from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  type LibraryTrack,
} from "#/server/db/schema/index.ts";
import { emit } from "#/server/services/events.ts";
import { rebuild, storeDocument } from "#/server/services/documents.ts";
import { enqueueRetagRun } from "#/server/services/queue.ts";
import { planRelocate, type RelocatePlan } from "#/server/services/relocate.ts";
import { createRun } from "#/server/services/retag.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

/* ------------------------------------------------------------------ */
/* what an edit is                                                     */
/* ------------------------------------------------------------------ */

export interface FieldEdit {
  readonly field: string;
  /**
   * The new value, as typed. `null` (or absent) means "do not set one" — then `locked` says
   * whether to pin what the resolvers already produced or to hand the field back to them.
   */
  readonly value?: string | readonly string[] | null;
  /** Defaults to `true`: setting a value by hand and not locking it would be pointless. */
  readonly locked?: boolean;
}

/** One field this call actually changed, and how. */
export interface FieldChange {
  readonly field: string;
  readonly vorbis: string;
  readonly action: "set" | "locked" | "released";
  readonly before: string | null;
  readonly after: string | null;
  /** How many of the album's tracks carry the change. Always 1 for a track-scoped edit. */
  readonly tracks: number;
}

export interface OverrideResult {
  readonly scope: "track" | "album";
  readonly targetId: string;
  readonly changed: readonly FieldChange[];
  /** The stored document of the edited track (of the album's first writable track). */
  readonly document: TrackDocument | null;
  /** The queued re-tag, or `null` when nothing changed or nothing was in scope. */
  readonly retagRunId: string | null;
  /**
   * What a relocate *would* do, present only when a path-affecting field moved.
   *
   * Never acted on here. Navidrome identifies a file by its path, so a move loses that
   * track's play count and its favourites; the Console shows this plan behind a confirm.
   */
  readonly relocatePlan: RelocatePlan | null;
  /** Library tracks the edit could not reach, with the reason. */
  readonly skipped: readonly { readonly id: string; readonly path: string; readonly why: string }[];
}

export interface OverrideOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  /** Frozen clock, for the tests. */
  readonly now?: Date;
  /** Who is editing, recorded in `Field.note`. Descriptive only. */
  readonly setBy?: string;
  /** `false` writes the document and queues nothing. The CLI's `--no-retag`. */
  readonly retag?: boolean;
}

/* ------------------------------------------------------------------ */
/* validating a field name and coercing a value                        */
/* ------------------------------------------------------------------ */

/**
 * Fields whose value is not text and cannot be typed into a box.
 *
 * Pictures are `EmbeddedPicture[]` and have their own picker; lyrics are `{synced, plain}` and
 * come from LRCLIB or a `.lrc`; a performer is `{name, role, mbid}` and would need three
 * inputs and a vocabulary. Refusing them by name is honest — the alternative is an editor
 * that accepts a string and silently corrupts the document's shape.
 */
const NOT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  front_cover: "Use the album's cover picker.",
  back_cover: "Use the album's cover picker.",
  lyrics: "Lyrics come from LRCLIB or the .lrc sidecar, not from a text box.",
  performer: "A performer credit is a name, a role and an MBID; it has no single-value form.",
});

/** Fields the document carries as a number. A tag map row does not say, so this list does. */
const NUMERIC: ReadonlySet<string> = new Set([
  "tracknumber",
  "totaltracks",
  "totaltracks_alias",
  "discnumber",
  "totaldiscs",
  "totaldiscs_alias",
  "originalyear",
  "bpm",
  "explicit",
  "movementnumber",
  "movementtotal",
]);

/** Fields the document carries as a boolean. `COMPILATION=1` is projected from `true`. */
const BOOLEAN: ReadonlySet<string> = new Set(["compilation", "showmovement"]);

/** Partial ISO dates, as MusicBrainz gives them: `2001`, `2001-03`, `2001-03-12`. */
const DATE_FIELDS: ReadonlySet<string> = new Set(["date", "releasedate", "originaldate"]);
const PARTIAL_ISO_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An MBID field is one whose value is a MusicBrainz identifier, and they are all uuids. */
function isMbidField(field: string): boolean {
  return field.startsWith("musicbrainz_") || field === "acoustid_id";
}

/**
 * The tag map row for a field somebody may edit, or a refusal that says why.
 *
 * The tag map is the only source of field names in the system, so an unknown name is a typo
 * or a stale client and must not reach the document — `unknownFields()` exists precisely to
 * assert that no document ever carries one.
 */
export function editableTag(field: string): TagDefinition {
  const tag = tagByField(field);
  if (tag === undefined) {
    throw new MMError("INVALID_INPUT", `"${field}" is not a field of the tag map.`, {
      hint: "`mm://tagmap` and the album's Metadata tab list every field by name.",
    });
  }
  const refusal = NOT_TEXT[field];
  if (refusal !== undefined) {
    throw new MMError("INVALID_INPUT", `${tag.vorbis} cannot be typed by hand.`, {
      hint: refusal,
    });
  }
  return tag;
}

/**
 * Turn what was typed into the shape the document stores, or refuse.
 *
 * The validation is per family and deliberately minimal: a positive integer for a position, a
 * partial ISO date for a date, a uuid for an MBID. Anything stricter would be this module
 * inventing a vocabulary MusicBrainz does not have, and anything looser would let a re-tag
 * write `TRACKNUMBER=twelve` into thirteen files.
 */
export function coerceValue(tag: TagDefinition, raw: string | readonly string[]): FieldValue {
  const field = tag.field;

  if (tag.multi) {
    const values = (typeof raw === "string" ? raw.split(/\r?\n/) : [...raw])
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (values.length === 0) {
      throw new MMError("INVALID_INPUT", `${tag.vorbis} needs at least one value.`, {
        hint: "One value per line. Unlock the field to hand it back to the resolvers.",
      });
    }
    if (isMbidField(field)) for (const value of values) requireUuid(tag, value);
    return values;
  }

  const value = (typeof raw === "string" ? raw : (raw[0] ?? "")).trim();
  if (value === "") {
    throw new MMError("INVALID_INPUT", `${tag.vorbis} cannot be set to an empty value.`, {
      hint: "Unlock the field instead; that hands it back to the resolvers.",
    });
  }

  if (NUMERIC.has(field)) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new MMError("INVALID_INPUT", `${tag.vorbis} must be a positive whole number.`, {
        hint: `Got "${value}".`,
      });
    }
    return parsed;
  }

  if (BOOLEAN.has(field)) {
    const truthy = ["1", "true", "yes", "on"].includes(value.toLowerCase());
    const falsy = ["0", "false", "no", "off"].includes(value.toLowerCase());
    if (!truthy && !falsy) {
      throw new MMError("INVALID_INPUT", `${tag.vorbis} is a yes/no field.`, {
        hint: `Use 1 or 0. Got "${value}".`,
      });
    }
    return truthy;
  }

  if (DATE_FIELDS.has(field) && !PARTIAL_ISO_DATE.test(value)) {
    throw new MMError("INVALID_INPUT", `${tag.vorbis} must be an ISO date.`, {
      hint: `YYYY, YYYY-MM or YYYY-MM-DD, as MusicBrainz writes them. Got "${value}".`,
    });
  }

  if (isMbidField(field)) requireUuid(tag, value);

  return value;
}

function requireUuid(tag: TagDefinition, value: string): void {
  if (UUID.test(value)) return;
  throw new MMError("INVALID_INPUT", `${tag.vorbis} must be a MusicBrainz identifier.`, {
    hint: `A uuid, as on musicbrainz.org. Got "${value}".`,
  });
}

/* ------------------------------------------------------------------ */
/* what a change costs downstream                                      */
/* ------------------------------------------------------------------ */

/**
 * The fields `pathInputForLibraryTrack` reads — change one and the file belongs elsewhere.
 *
 * Derived from the template's inputs rather than from `PATH_TOKENS`, because `{year}` is not a
 * field: it is the first four characters of `date`, with `originaldate` behind it.
 */
export const PATH_FIELDS: readonly string[] = Object.freeze([
  "albumartist",
  "artist",
  "album",
  "title",
  "tracknumber",
  "discnumber",
  "totaldiscs",
  "date",
  "originaldate",
]);

/**
 * The album-scope fields the album page offers in a form.
 *
 * Not all 36: four are ReplayGain numbers rsgain measures, two are sort names nobody types by
 * hand, and the MBIDs identify the release rather than describe it — changing one by hand is
 * "this is a different release", which is `refresh_album`'s job, not a text box's. What is left
 * is the set somebody actually corrects: the names, the dates, the edition and the
 * classification. Everything else stays settable through the API and the CLI, which validate
 * the same way; the form is a shortlist, not a permission.
 */
export const ALBUM_EDITABLE_FIELDS: readonly string[] = Object.freeze([
  "album",
  "albumartist",
  "date",
  "originaldate",
  "releasetype",
  "releasestatus",
  "releasecountry",
  "label",
  "catalognumber",
  "barcode",
  "media",
  "genre",
  "mood",
  "grouping",
  "copyright",
  "compilation",
]);

export function touchesPath(fields: readonly string[]): boolean {
  return fields.some((field) => PATH_FIELDS.includes(field));
}

/** The library columns a document field is denormalised into, so the grids stay honest. */
const TRACK_COLUMN: Readonly<Record<string, "title" | "artist" | "discNumber" | "trackNumber">> =
  Object.freeze({
    title: "title",
    artist: "artist",
    discnumber: "discNumber",
    tracknumber: "trackNumber",
  });

const ALBUM_COLUMN: Readonly<Record<string, "title" | "albumArtist" | "year">> = Object.freeze({
  album: "title",
  albumartist: "albumArtist",
  date: "year",
});

/* ------------------------------------------------------------------ */
/* reading the target                                                  */
/* ------------------------------------------------------------------ */

interface Target {
  readonly track: LibraryTrack;
  readonly importTrackId: string;
  readonly document: TrackDocument;
}

/** The track rows of one library track, or of a whole album, with their stored documents. */
async function targetsOf(
  db: Database,
  tracks: readonly LibraryTrack[],
): Promise<{ targets: Target[]; skipped: OverrideResult["skipped"] }> {
  const targets: Target[] = [];
  const skipped: { id: string; path: string; why: string }[] = [];

  const withImport = tracks.filter((track) => track.importTrackId !== null);
  for (const track of tracks) {
    if (track.importTrackId === null) {
      skipped.push({
        id: track.id,
        path: track.path,
        why: "no import behind it, so it has no document to override",
      });
    }
  }

  if (withImport.length === 0) return { targets, skipped };

  const rows = await db
    .select()
    .from(metadataDocuments)
    .where(
      inArray(
        metadataDocuments.importTrackId,
        withImport.map((track) => track.importTrackId ?? ""),
      ),
    );
  const byImportTrack = new Map(rows.map((row) => [row.importTrackId ?? "", row]));

  for (const track of withImport) {
    const row = byImportTrack.get(track.importTrackId ?? "");
    if (row === undefined) {
      skipped.push({ id: track.id, path: track.path, why: "no document has been built for it" });
      continue;
    }
    targets.push({
      track,
      importTrackId: track.importTrackId ?? "",
      document: row.document as unknown as TrackDocument,
    });
  }

  return { targets, skipped };
}

/** The stored documents of these import tracks, keyed by import track id. */
async function documentsByImportTrack(
  db: Database,
  importTrackIds: readonly string[],
): Promise<Map<string, TrackDocument>> {
  if (importTrackIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(metadataDocuments)
    .where(inArray(metadataDocuments.importTrackId, [...importTrackIds]));
  return new Map(
    rows.map((row) => [row.importTrackId ?? "", row.document as unknown as TrackDocument]),
  );
}

/** A value as the Console prints it — for the `before`/`after` of a change, and the journal. */
function show(value: FieldValue | undefined): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return (value as readonly unknown[]).map((v) => String(v)).join(" · ");
  if (typeof value === "object") return "(structured)";
  return String(value);
}

/* ------------------------------------------------------------------ */
/* applying the edits to one document                                  */
/* ------------------------------------------------------------------ */

interface Applied {
  readonly document: TrackDocument;
  readonly changes: Map<string, { action: FieldChange["action"]; before: string | null }>;
  /** `true` when a field was removed, so the document has to be re-resolved offline. */
  readonly needsRebuild: boolean;
}

function applyEdits(
  document: TrackDocument,
  edits: readonly { tag: TagDefinition; value: FieldValue | null; locked: boolean }[],
  at: string,
  note: string,
): Applied {
  let next = document;
  const changes = new Map<string, { action: FieldChange["action"]; before: string | null }>();
  let needsRebuild = false;

  for (const edit of edits) {
    const field = edit.tag.field;
    const held = next.fields[field];
    const before = show(held?.value);

    if (edit.value !== null) {
      if (before === show(edit.value) && held?.locked === true && held.source === "console")
        continue;
      next = setConsoleValue(next, field, edit.value, at, { note });
      changes.set(field, { action: "set", before });
      continue;
    }

    if (edit.locked) {
      if (held === undefined) {
        throw new MMError(
          "INVALID_INPUT",
          `${edit.tag.vorbis} has no value to lock on this track.`,
          { hint: "Type a value instead; setting one locks it." },
        );
      }
      if (held.locked) continue;
      /*
       * Pinning the resolvers' answer keeps its `source`: the value really did come from
       * MusicBrainz, and saying `console` would lose the only interesting part of the
       * provenance. What the Console owns here is the *lock*, and the note says so.
       */
      next = {
        ...next,
        fields: { ...next.fields, [field]: { ...held, locked: true, note } },
      };
      changes.set(field, { action: "locked", before });
      continue;
    }

    if (held === undefined) continue;
    next = removeField(next, field);
    changes.set(field, { action: "released", before });
    needsRebuild = true;
  }

  return { document: next, changes, needsRebuild };
}

/* ------------------------------------------------------------------ */
/* the position is an identity                                         */
/* ------------------------------------------------------------------ */

/**
 * Refuse a move onto a position another file of the album already holds.
 *
 * `library_tracks_album_position_idx` would refuse it anyway, with a constraint name and no
 * clue which file is in the way. Two files cannot both be track 4 of the same album, and the
 * person retyping a track number deserves to be told which one is there.
 */
async function checkPosition(
  db: Database,
  track: LibraryTrack,
  document: TrackDocument,
): Promise<void> {
  if (track.albumId === null) return;
  const disc = numberOf(document, "discnumber") ?? track.discNumber ?? 1;
  const position = numberOf(document, "tracknumber") ?? track.trackNumber;
  if (position === null) return;
  if (disc === (track.discNumber ?? 1) && position === track.trackNumber) return;

  const [clash] = await db
    .select({ id: libraryTracks.id, title: libraryTracks.title, path: libraryTracks.path })
    .from(libraryTracks)
    .where(
      and(
        eq(libraryTracks.albumId, track.albumId),
        ne(libraryTracks.id, track.id),
        eq(sql`coalesce(${libraryTracks.discNumber}, 1)`, disc),
        eq(libraryTracks.trackNumber, position),
      ),
    )
    .limit(1);

  if (clash === undefined) return;
  throw new MMError(
    "INVALID_INPUT",
    `Disc ${String(disc)} track ${String(position)} of this album is already “${clash.title}”.`,
    {
      hint: `${clash.path} holds that position. Move it first, or pick another number.`,
      action: "Open the other track",
    },
  );
}

function numberOf(document: TrackDocument, field: string): number | null {
  const value = document.fields[field]?.value;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function textOf(document: TrackDocument, field: string): string | null {
  const value = document.fields[field]?.value;
  return typeof value === "string" && value !== "" ? value : null;
}

/* ------------------------------------------------------------------ */
/* the public entry points                                             */
/* ------------------------------------------------------------------ */

/**
 * Override fields on one library track.
 *
 * Album-scope fields are refused here on purpose: they belong to the album, and writing one on
 * a single track is how an album ends up split in two on Navidrome.
 */
export async function overrideTrackFields(
  libraryTrackId: string,
  edits: readonly FieldEdit[],
  options: OverrideOptions = {},
): Promise<OverrideResult> {
  const db = options.db ?? defaultDb();
  const [track] = await db
    .select()
    .from(libraryTracks)
    .where(eq(libraryTracks.id, libraryTrackId))
    .limit(1);
  if (track === undefined) {
    throw new MMError("NOT_FOUND", `No library track with id ${libraryTrackId}.`);
  }

  const prepared = prepare(edits);
  for (const edit of prepared) {
    if (!ALBUM_SCOPE_FIELDS.includes(edit.tag.field)) continue;
    throw new MMError(
      "INVALID_INPUT",
      `${edit.tag.vorbis} is a field of album scope; it cannot be set on one track.`,
      {
        hint:
          "Every track of an album must carry the same value or Navidrome, Plex and Jellyfin " +
          "split it in two. Set it on the album instead — it is written on every file.",
        action: "Open the album",
      },
    );
  }

  return await write("track", libraryTrackId, [track], prepared, options);
}

/**
 * Override album-scope fields on every track of an album, in one transaction.
 *
 * Only `albumScope` fields: a per-track field set album-wide would give thirteen files one
 * title. The all-tracks write is what makes divergence impossible rather than merely unlikely
 * — `resolveAlbumScope` would propagate a single lock at re-tag time, but only over the files
 * a given run happens to carry.
 */
export async function overrideAlbumFields(
  albumId: string,
  edits: readonly FieldEdit[],
  options: OverrideOptions = {},
): Promise<OverrideResult> {
  const db = options.db ?? defaultDb();
  const [album] = await db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);
  if (album === undefined) throw new MMError("NOT_FOUND", `No album with id ${albumId}.`);

  const prepared = prepare(edits);
  for (const edit of prepared) {
    if (ALBUM_SCOPE_FIELDS.includes(edit.tag.field)) continue;
    throw new MMError(
      "INVALID_INPUT",
      `${edit.tag.vorbis} is a per-track field; it cannot be set on a whole album.`,
      { hint: "Open the track and set it there.", action: "Open the track" },
    );
  }

  const tracks = await db
    .select()
    .from(libraryTracks)
    .where(eq(libraryTracks.albumId, albumId))
    .orderBy(libraryTracks.discNumber, libraryTracks.trackNumber);
  if (tracks.length === 0) {
    throw new MMError("NOT_FOUND", `Album ${albumId} has no files placed yet.`, {
      hint: "There is nothing to write the value onto.",
    });
  }

  return await write("album", albumId, tracks, prepared, options);
}

interface PreparedEdit {
  readonly tag: TagDefinition;
  readonly value: FieldValue | null;
  readonly locked: boolean;
}

function prepare(edits: readonly FieldEdit[]): PreparedEdit[] {
  if (edits.length === 0) {
    throw new MMError("INVALID_INPUT", "No field to change.", {
      hint: "Give at least one `{field, value}` or `{field, locked}` entry.",
    });
  }
  const seen = new Set<string>();
  return edits.map((edit) => {
    const tag = editableTag(edit.field);
    if (seen.has(tag.field)) {
      throw new MMError("INVALID_INPUT", `${tag.vorbis} is named twice in the same call.`);
    }
    seen.add(tag.field);
    const raw = edit.value;
    if (raw === null || raw === undefined) {
      return { tag, value: null, locked: edit.locked ?? false };
    }
    return { tag, value: coerceValue(tag, raw), locked: edit.locked ?? true };
  });
}

/* ------------------------------------------------------------------ */
/* the write                                                           */
/* ------------------------------------------------------------------ */

async function write(
  scope: "track" | "album",
  targetId: string,
  tracks: readonly LibraryTrack[],
  edits: readonly PreparedEdit[],
  options: OverrideOptions,
): Promise<OverrideResult> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const note = `set in the Console by ${options.setBy ?? "the owner"} on ${at.slice(0, 19)}Z`;

  const { targets, skipped } = await targetsOf(db, tracks);
  if (targets.length === 0) {
    throw new MMError(
      "NOT_FOUND",
      scope === "track"
        ? "That file has no metadata document, so there is nothing to override."
        : "No file of this album has a metadata document, so there is nothing to override.",
      {
        hint:
          "A document is built by an import. Files found by the library scan are adopted in a " +
          "later phase, and a track without one cannot be re-tagged either.",
        action: "Import it instead",
      },
    );
  }

  /* ---- 1 · compute every new document, and refuse before writing anything ---- */
  const applied = targets.map((target) => ({
    target,
    ...applyEdits(target.document, edits, at, note),
  }));
  for (const entry of applied) {
    if (entry.changes.size === 0) continue;
    await checkPosition(db, entry.target.track, entry.document);
  }

  const touched = applied.filter((entry) => entry.changes.size > 0);
  if (touched.length === 0) {
    return {
      scope,
      targetId,
      changed: [],
      document: targets[0]?.document ?? null,
      retagRunId: null,
      relocatePlan: null,
      skipped,
    };
  }

  /* ---- 2 · write the documents ---- */
  for (const entry of touched) {
    // `storeDocument` rather than a bare update: it re-scores, and a field filled or released
    // by hand really does move the track's completeness.
    await storeDocument(entry.target.importTrackId, entry.document, db);
  }

  /*
   * ---- 3 · a released field is re-resolved, offline ----
   *
   * After the write, never before: `documents.build` re-reads its locks from the stored row,
   * so rebuilding first would put the lock we just removed straight back on.
   */
  for (const entry of touched) {
    if (!entry.needsRebuild) continue;
    await rebuild(entry.target.importTrackId, { db, settings, now });
  }

  /*
   * ---- 4 · the denormalised columns follow, from the *final* documents ----
   *
   * After the rebuild, not before, and that ordering is the whole point: releasing `album`
   * removes the typed value and lets MusicBrainz answer again, so a column computed from the
   * pruned document would have been `null` — and "keep the old one" would have left the album
   * row saying `Discovery (Deluxe)` under a document that says `Discovery`. The grids read
   * these columns and not the document, so a stale one is a screen that lies.
   *
   * One transaction, because a track row and its album row disagreeing about the album's name
   * is worse than either of them being briefly old.
   */
  const finalDocuments = await documentsByImportTrack(
    db,
    touched.map((entry) => entry.target.importTrackId),
  );
  const changedFields = [...new Set(touched.flatMap((entry) => [...entry.changes.keys()]))];

  await db.transaction(async (tx) => {
    for (const entry of touched) {
      const document = finalDocuments.get(entry.target.importTrackId) ?? entry.document;
      const columns: Record<string, string | number | null> = {};
      for (const field of entry.changes.keys()) {
        const column = TRACK_COLUMN[field];
        if (column === undefined) continue;
        columns[column] =
          column === "title" || column === "artist"
            ? textOf(document, field)
            : numberOf(document, field);
      }
      // `title` is `not null`: a released field the resolvers cannot fill keeps the old one.
      if (columns["title"] === null) delete columns["title"];
      if (Object.keys(columns).length > 0) {
        await tx
          .update(libraryTracks)
          .set({ ...columns, updatedAt: now })
          .where(eq(libraryTracks.id, entry.target.track.id));
      }
    }

    /* The album row carries the same two names, and the grid reads them, not the document. */
    const albumId = touched[0]?.target.track.albumId ?? null;
    const first =
      finalDocuments.get(touched[0]?.target.importTrackId ?? "") ?? touched[0]?.document;
    if (albumId !== null && first !== undefined) {
      const columns: Record<string, string | number | null> = {};
      for (const field of changedFields) {
        const column = ALBUM_COLUMN[field];
        if (column === undefined) continue;
        columns[column] =
          column === "year"
            ? Number.parseInt(textOf(first, "date")?.slice(0, 4) ?? "", 10) || null
            : textOf(first, field);
      }
      if (columns["title"] === null) delete columns["title"];
      if (columns["albumArtist"] === null) delete columns["albumArtist"];
      if (Object.keys(columns).length > 0) {
        await tx
          .update(libraryAlbums)
          .set({ ...columns, updatedAt: now })
          .where(eq(libraryAlbums.id, albumId));
      }
    }
  });

  const changed = summarise(
    touched.map((entry) => ({
      document: finalDocuments.get(entry.target.importTrackId) ?? entry.document,
      changes: entry.changes,
    })),
    edits,
    targets.length,
  );

  await emit(
    {
      type: "library.fields_overridden",
      message:
        `${changed.length} field(s) set by hand on ${scope === "album" ? "album" : "track"} ` +
        `${targetId}: ${changed.map((entry) => entry.vorbis).join(", ")}.`,
      data: { scope, targetId, fields: changed.map((entry) => entry.field) },
    },
    db,
  );

  /* ---- 4 · the files catch up, and the paths are only ever *offered* ---- */
  let retagRunId: string | null = null;
  if (options.retag !== false) {
    const run = await createRun({
      db,
      settings,
      scope,
      targetId,
      // Nothing about the tag *schema* changed — what changed is the answer. A run filtered on
      // "behind the schema" would find nothing and report success without opening a file.
      onlyBehind: false,
      dryRun: false,
      trigger: "manual",
    });
    if (run.total > 0) {
      await enqueueRetagRun(run.id);
      retagRunId = run.id;
    }
  }

  const albumId = touched[0]?.target.track.albumId ?? null;
  const relocatePlan = touchesPath(changedFields)
    ? await planRelocate({ db, settings, albumId })
    : null;

  return {
    scope,
    targetId,
    changed,
    document: finalDocuments.get(touched[0]?.target.importTrackId ?? "") ?? null,
    retagRunId,
    relocatePlan,
    skipped,
  };
}

function summarise(
  touched: readonly { document: TrackDocument; changes: Applied["changes"] }[],
  edits: readonly PreparedEdit[],
  total: number,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const edit of edits) {
    const carrying = touched.filter((entry) => entry.changes.has(edit.tag.field));
    const first = carrying[0];
    if (first === undefined) continue;
    const record = first.changes.get(edit.tag.field);
    out.push({
      field: edit.tag.field,
      vorbis: edit.tag.vorbis,
      action: record?.action ?? "set",
      before: record?.before ?? null,
      after: show(first.document.fields[edit.tag.field]?.value),
      tracks: carrying.length === total ? total : carrying.length,
    });
  }
  return out;
}
