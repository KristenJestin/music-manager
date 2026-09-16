/**
 * The filter tree, compiled to a Drizzle `where`.
 *
 * **This is the whole point of the feature, and it is a correctness requirement rather than a
 * performance one.** The library pages page server-side and print a total: `1–60 of 214`. A
 * predicate applied in TypeScript *after* the page came back can only ever narrow the sixty
 * rows in hand, so the total keeps describing the unfiltered library and the pager walks off
 * the end of a list that was never that long. This repository has shipped that bug twice —
 * `countImports`, and `trackList`'s `albumId`, whose comment still says so — and both times it
 * looked like a UI glitch rather than the arithmetic mistake it is.
 *
 * So: one tree, one `SQL` condition built from it, and both the `count(*)` and the `select …
 * limit` take that same object. They cannot disagree, because there is only one of them.
 *
 * ## Why the field can never be a string from the URL
 *
 * Nothing here interpolates a name. A condition's `field` is looked up in a **binding table**
 * built in this file; a name with no binding throws `INVALID_INPUT` before a query exists.
 * Operands are passed to Drizzle as parameters, never spliced into the text. The zod schema in
 * `lib/filters/schema.ts` has already refused anything outside the page's whitelist, and this
 * throw is the second wall: `library-filter.sql.test.ts` drives it with
 * `title") or 1=1 --:contains:x` and asserts no SQL comes out at all.
 *
 * ## The shapes a field can have
 *
 * A binding is one of five things, and the operator set a field declares must match:
 *
 *  - `text`    — a string expression. Comparisons are case-insensitive, because a music
 *                library is full of titles nobody capitalises the same way twice;
 *  - `number`  — a numeric expression, possibly a correlated subquery;
 *  - `date`    — a timestamp. `lte` means "up to the end of that day", not "up to midnight";
 *  - `boolean` — one expression that is true when the answer is yes; `is:false` is its `not`;
 *  - `member`  — a function from an enum value to a predicate. This is what lets "Completion
 *                is Unknown total" and "Verification is Mismatch" be filters at all: they are
 *                *states* read off several columns, not values sitting in one.
 */
import { and, or, sql, type SQL } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  importTracks,
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
} from "#/server/db/schema/index.ts";
import {
  ALBUM_FILTER_FIELDS,
  ARTIST_FILTER_FIELDS,
  TRACK_FILTER_FIELDS,
  type FilterCondition,
  type FilterFieldSet,
  type FilterGroup,
  type FilterNode,
} from "#/lib/filters/index.ts";
import type { AlbumFilter, TrackFilter } from "#/lib/library-filters.ts";

/* ------------------------------------------------------------------ */
/* bindings                                                            */
/* ------------------------------------------------------------------ */

export type FilterBinding =
  | { readonly kind: "text"; readonly expr: SQL }
  | { readonly kind: "number"; readonly expr: SQL }
  | { readonly kind: "date"; readonly expr: SQL }
  | { readonly kind: "boolean"; readonly whenTrue: SQL }
  | { readonly kind: "member"; readonly member: (value: string) => SQL };

export type FilterBindings = Readonly<Record<string, FilterBinding>>;

function refuse(message: string, hint: string): never {
  throw new MMError("INVALID_INPUT", message, { hint, status: 400 });
}

/* ------------------------------------------------------------------ */
/* operand helpers                                                     */
/* ------------------------------------------------------------------ */

/** `%`, `_` and `\` are LIKE's own syntax; a title containing one is not a wildcard. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function numberOperand(condition: FilterCondition, index: number): number {
  const raw = condition.values[index] ?? "";
  const parsed = Number(raw);
  // Unreachable through the schema, which parses every operand first. Kept because this
  // module is also reachable from `/api/v1`, and `NaN` in a `where` silently matches nothing.
  if (!Number.isFinite(parsed)) {
    refuse(`"${raw}" is not a number.`, `The field "${condition.field}" compares against numbers.`);
  }
  return parsed;
}

function dateOperand(condition: FilterCondition, index: number): string {
  const raw = condition.values[index] ?? "";
  if (Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    refuse(`"${raw}" is not a date.`, `The field "${condition.field}" wants YYYY-MM-DD.`);
  }
  return raw;
}

function textOperand(condition: FilterCondition, index: number): string {
  return condition.values[index] ?? "";
}

const FALSE: SQL = sql`false`;

function anyOf(parts: readonly SQL[]): SQL {
  if (parts.length === 0) return FALSE;
  return parts.length === 1 ? (parts[0] as SQL) : (or(...parts) as SQL);
}

/* ------------------------------------------------------------------ */
/* one condition                                                       */
/* ------------------------------------------------------------------ */

function compileText(binding: { readonly expr: SQL }, condition: FilterCondition): SQL {
  const { expr } = binding;
  const one = (): string => textOperand(condition, 0);
  switch (condition.op) {
    case "contains":
      return sql`${expr} ilike ${`%${likeLiteral(one())}%`}`;
    case "notContains":
      return sql`(${expr} is null or ${expr} not ilike ${`%${likeLiteral(one())}%`})`;
    case "startsWith":
      return sql`${expr} ilike ${`${likeLiteral(one())}%`}`;
    case "endsWith":
      return sql`${expr} ilike ${`%${likeLiteral(one())}`}`;
    case "eq":
      return sql`lower(${expr}) = lower(${one()})`;
    case "neq":
      return sql`(${expr} is null or lower(${expr}) <> lower(${one()}))`;
    case "in":
      return anyOf(condition.values.map((value) => sql`lower(${expr}) = lower(${value})`));
    case "notIn":
      return sql`not (${anyOf(condition.values.map((value) => sql`lower(${expr}) = lower(${value})`))})`;
    case "isEmpty":
      return sql`(${expr} is null or ${expr} = '')`;
    case "isNotEmpty":
      return sql`(${expr} is not null and ${expr} <> '')`;
    default:
      return refuse(
        `"${condition.op}" cannot be applied to the text field "${condition.field}".`,
        "The field's declared operators are the only ones it accepts.",
      );
  }
}

function compileNumber(binding: { readonly expr: SQL }, condition: FilterCondition): SQL {
  const { expr } = binding;
  switch (condition.op) {
    case "eq":
      return sql`${expr} = ${numberOperand(condition, 0)}`;
    case "neq":
      return sql`(${expr} is null or ${expr} <> ${numberOperand(condition, 0)})`;
    case "gt":
      return sql`${expr} > ${numberOperand(condition, 0)}`;
    case "gte":
      return sql`${expr} >= ${numberOperand(condition, 0)}`;
    case "lt":
      return sql`${expr} < ${numberOperand(condition, 0)}`;
    case "lte":
      return sql`${expr} <= ${numberOperand(condition, 0)}`;
    case "between":
      return sql`${expr} between ${numberOperand(condition, 0)} and ${numberOperand(condition, 1)}`;
    case "isEmpty":
      return sql`${expr} is null`;
    case "isNotEmpty":
      return sql`${expr} is not null`;
    default:
      return refuse(
        `"${condition.op}" cannot be applied to the number field "${condition.field}".`,
        "The field's declared operators are the only ones it accepts.",
      );
  }
}

function compileDate(binding: { readonly expr: SQL }, condition: FilterCondition): SQL {
  const { expr } = binding;
  // "up to 3 March" means the whole of 3 March. A plain `<=` on a timestamp would cut the day
  // off at midnight and hide everything imported during it.
  const endOf = (value: string): SQL => sql`(${value}::date + interval '1 day')`;
  switch (condition.op) {
    case "gte":
      return sql`${expr} >= ${dateOperand(condition, 0)}::date`;
    case "lte":
      return sql`${expr} < ${endOf(dateOperand(condition, 0))}`;
    case "between":
      return sql`(${expr} >= ${dateOperand(condition, 0)}::date and ${expr} < ${endOf(dateOperand(condition, 1))})`;
    default:
      return refuse(
        `"${condition.op}" cannot be applied to the date field "${condition.field}".`,
        "A date field takes at least, at most, or between.",
      );
  }
}

function compileBoolean(binding: { readonly whenTrue: SQL }, condition: FilterCondition): SQL {
  if (condition.op !== "is") {
    return refuse(
      `"${condition.op}" cannot be applied to the boolean field "${condition.field}".`,
      "A boolean field is true or it is false.",
    );
  }
  const wanted = textOperand(condition, 0);
  if (wanted !== "true" && wanted !== "false") {
    refuse(`"${wanted}" is not true or false.`, `The field "${condition.field}" is a yes/no.`);
  }
  return wanted === "true" ? binding.whenTrue : sql`not (${binding.whenTrue})`;
}

function compileMember(
  binding: { readonly member: (value: string) => SQL },
  condition: FilterCondition,
): SQL {
  const parts = condition.values.map((value) => binding.member(value));
  switch (condition.op) {
    case "eq":
    case "in":
      return anyOf(parts);
    case "neq":
    case "notIn":
      return sql`not (${anyOf(parts)})`;
    default:
      return refuse(
        `"${condition.op}" cannot be applied to the field "${condition.field}".`,
        "A state field is one of a fixed list, or it is not.",
      );
  }
}

function compileCondition(condition: FilterCondition, bindings: FilterBindings): SQL {
  const binding = bindings[condition.field];
  if (binding === undefined) {
    return refuse(
      `"${condition.field}" is not a filterable field.`,
      "Only the fields this page declares can be filtered on; a column name is not a filter.",
    );
  }
  switch (binding.kind) {
    case "text":
      return compileText(binding, condition);
    case "number":
      return compileNumber(binding, condition);
    case "date":
      return compileDate(binding, condition);
    case "boolean":
      return compileBoolean(binding, condition);
    case "member":
      return compileMember(binding, condition);
  }
}

/* ------------------------------------------------------------------ */
/* the tree                                                            */
/* ------------------------------------------------------------------ */

function compileNode(node: FilterNode, bindings: FilterBindings): SQL | undefined {
  if (node.kind === "condition") return compileCondition(node, bindings);
  const parts = node.children
    .map((child) => compileNode(child, bindings))
    .filter((part): part is SQL => part !== undefined);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return (node.join === "and" ? and(...parts) : or(...parts)) as SQL;
}

/**
 * The tree as a `where`, or `undefined` for "no filter".
 *
 * `undefined` rather than `true` on purpose: it is what Drizzle's `.where()` takes to mean
 * "no clause at all", so the empty tree produces the query that was there before this feature
 * existed, byte for byte.
 */
export function compileFilter(tree: FilterGroup, bindings: FilterBindings): SQL | undefined {
  return compileNode(tree, bindings);
}

/** Every condition in one `and`, dropping the ones that are not there. */
export function allOf(...parts: readonly (SQL | undefined)[]): SQL | undefined {
  const present = parts.filter((part): part is SQL => part !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : (and(...present) as SQL);
}

/* ------------------------------------------------------------------ */
/* albums                                                              */
/* ------------------------------------------------------------------ */

/** The album's mean *track* completeness, as a percentage. See `ALBUM_FILTER_FIELDS.score`. */
const ALBUM_MEAN_SCORE = sql`(select avg(${metadataDocuments.completeness}) * 100
  from ${metadataDocuments}
  join ${libraryTracks} on ${libraryTracks.id} = ${metadataDocuments.libraryTrackId}
  where ${libraryTracks.albumId} = ${libraryAlbums.id})`;

const ALBUM_HAS_MISSING = sql`exists (select 1 from ${libraryTracks}
  where ${libraryTracks.albumId} = ${libraryAlbums.id} and ${libraryTracks.missingAt} is not null)`;

/** A total we may print as a fraction: `release` or `tags`, never our own row count. */
const ALBUM_TOTAL_KNOWN = sql`${libraryAlbums.trackCountSource} in ('release', 'tags')`;

function albumBehindSchema(currentSchema: number): SQL {
  return sql`exists (select 1 from ${libraryTracks}
    where ${libraryTracks.albumId} = ${libraryAlbums.id}
      and (${libraryTracks.tagSchemaVersion} is null
           or ${libraryTracks.tagSchemaVersion} < ${currentSchema}))`;
}

/** Any of the album's files carries a YouTube thumbnail as its front cover. */
const ALBUM_YOUTUBE_COVER = sql`exists (select 1 from ${metadataDocuments}
  join ${libraryTracks} on ${libraryTracks.id} = ${metadataDocuments.libraryTrackId}
  where ${libraryTracks.albumId} = ${libraryAlbums.id}
    and ${metadataDocuments.document}->'fields'->'front_cover'->>'source' = 'youtube')`;

const ALBUM_TAGGED = sql`(${libraryAlbums.releaseMbid} is not null and ${libraryAlbums.releaseMbid} <> '')`;

/**
 * `mismatches` / `notIndexed` off the stored `AlbumVerification` (`services/verify.ts`).
 *
 * The key is spelled into the query rather than bound, and that is not a shortcut: `->>` has
 * a `jsonb -> text` overload and a `jsonb -> integer` one, so an untyped parameter there makes
 * Postgres answer *"operator is not unique"* rather than a row. The two keys are literals of
 * this module and cannot come from a request — the union type is the proof.
 */
const VERIFICATION_MISMATCHES = sql`coalesce((${libraryAlbums.verification}->>'mismatches')::int, 0)`;
const VERIFICATION_NOT_INDEXED = sql`coalesce((${libraryAlbums.verification}->>'notIndexed')::int, 0)`;

export function albumFilterBindings(options: { readonly currentSchema: number }): FilterBindings {
  const verified = sql`${libraryAlbums.verifiedAt} is not null`;
  const clean = sql`${VERIFICATION_MISMATCHES} = 0`;
  const indexed = sql`${VERIFICATION_NOT_INDEXED} = 0`;
  const behind = albumBehindSchema(options.currentSchema);

  const completion: Readonly<Record<string, SQL>> = {
    complete: sql`(${ALBUM_TOTAL_KNOWN} and ${libraryAlbums.presentCount} >= ${libraryAlbums.trackCount})`,
    incomplete: sql`(${ALBUM_TOTAL_KNOWN} and ${libraryAlbums.presentCount} < ${libraryAlbums.trackCount})`,
    unknown: sql`(not (${ALBUM_TOTAL_KNOWN}))`,
  };
  const verification: Readonly<Record<string, SQL>> = {
    unverified: sql`(${libraryAlbums.verifiedAt} is null)`,
    ok: sql`(${verified} and ${clean} and ${indexed})`,
    mismatch: sql`(${verified} and not (${clean}))`,
    not_indexed: sql`(${verified} and ${clean} and not (${indexed}))`,
  };
  const schema: Readonly<Record<string, SQL>> = {
    behind,
    current: sql`not (${behind})`,
  };

  const pick = (table: Readonly<Record<string, SQL>>, field: string) => (value: string) => {
    const found = table[value];
    if (found === undefined) {
      refuse(
        `"${value}" is not a value of "${field}".`,
        "Use one of the values the picker offers.",
      );
    }
    return found;
  };

  return {
    title: { kind: "text", expr: sql`${libraryAlbums.title}` },
    artist: { kind: "text", expr: sql`${libraryAlbums.albumArtist}` },
    year: { kind: "number", expr: sql`${libraryAlbums.year}` },
    score: { kind: "number", expr: ALBUM_MEAN_SCORE },
    tracks: { kind: "number", expr: sql`${libraryAlbums.presentCount}` },
    total: { kind: "number", expr: sql`${libraryAlbums.trackCount}` },
    completion: { kind: "member", member: pick(completion, "completion") },
    totalSource: {
      kind: "member",
      member: (value: string) => sql`${libraryAlbums.trackCountSource} = ${value}`,
    },
    hasCover: { kind: "boolean", whenTrue: sql`(${libraryAlbums.coverPath} is not null)` },
    tagged: { kind: "boolean", whenTrue: ALBUM_TAGGED },
    verification: { kind: "member", member: pick(verification, "verification") },
    schema: { kind: "member", member: pick(schema, "schema") },
    missingFiles: { kind: "boolean", whenTrue: ALBUM_HAS_MISSING },
    format: {
      kind: "member",
      member: (value: string) => sql`exists (select 1 from ${libraryTracks}
        where ${libraryTracks.albumId} = ${libraryAlbums.id}
          and lower(${libraryTracks.format}) = lower(${value}))`,
    },
    added: { kind: "date", expr: sql`${libraryAlbums.createdAt}` },
  };
}

/**
 * The five chips above the grid, in SQL.
 *
 * They were `passesAlbumFilter`, a switch over rows already in memory. They are here now for
 * the reason the whole module exists: the chip's count and the chip's rows have to come out
 * of the same predicate, and a chip evaluated in TypeScript over an SQL-filtered page would be
 * exactly the arithmetic mistake this file was written to remove.
 */
export function albumChipCondition(
  filter: AlbumFilter,
  options: { readonly currentSchema: number },
): SQL | undefined {
  switch (filter) {
    case "all":
      return undefined;
    case "incomplete":
      return sql`(${ALBUM_TOTAL_KNOWN} and ${libraryAlbums.presentCount} < ${libraryAlbums.trackCount})`;
    case "untagged":
      return sql`not (${ALBUM_TAGGED})`;
    case "nocover":
      return sql`(${libraryAlbums.coverPath} is null)`;
    case "ytcover":
      return ALBUM_YOUTUBE_COVER;
    case "schema":
      return albumBehindSchema(options.currentSchema);
  }
}

/** The free-text box: title, album artist, release MBID — the same three it always matched. */
export function albumSearchCondition(search: string): SQL | undefined {
  const needle = search.trim();
  if (needle === "") return undefined;
  const pattern = `%${likeLiteral(needle)}%`;
  return sql`(${libraryAlbums.title} ilike ${pattern}
    or ${libraryAlbums.albumArtist} ilike ${pattern}
    or coalesce(${libraryAlbums.releaseMbid}, '') ilike ${pattern})`;
}

/* ------------------------------------------------------------------ */
/* tracks                                                              */
/* ------------------------------------------------------------------ */

const TRACK_ALBUM_TITLE = sql`(select ${libraryAlbums.title} from ${libraryAlbums}
  where ${libraryAlbums.id} = ${libraryTracks.albumId})`;

/** Mirrors `quality.ts`'s `hasLyrics`: synced or plain, either one is enough. */
const TRACK_HAS_LYRICS = sql`exists (select 1 from ${metadataDocuments}
  where ${metadataDocuments.libraryTrackId} = ${libraryTracks.id}
    and coalesce(${metadataDocuments.document}->'fields'->'lyrics'->'value'->>'synced',
                 ${metadataDocuments.document}->'fields'->'lyrics'->'value'->>'plain') is not null)`;

/** Mirrors `quality.ts`'s `hasReplayGain`: the field is present, whatever it holds. */
const TRACK_HAS_REPLAYGAIN = sql`exists (select 1 from ${metadataDocuments}
  where ${metadataDocuments.libraryTrackId} = ${libraryTracks.id}
    and jsonb_exists(${metadataDocuments.document}->'fields', 'replaygain_track_gain'))`;

const TRACK_SCORE = sql`(select ${metadataDocuments.completeness} * 100 from ${metadataDocuments}
  where ${metadataDocuments.libraryTrackId} = ${libraryTracks.id}
  order by ${metadataDocuments.updatedAt} desc limit 1)`;

const TRACK_FINGERPRINT = sql`(select ${importTracks.fingerprintOk} from ${importTracks}
  where ${importTracks.id} = ${libraryTracks.importTrackId})`;

function trackBehindSchema(currentSchema: number): SQL {
  return sql`(${libraryTracks.tagSchemaVersion} is null
    or ${libraryTracks.tagSchemaVersion} < ${currentSchema})`;
}

export function trackFilterBindings(options: { readonly currentSchema: number }): FilterBindings {
  const behind = trackBehindSchema(options.currentSchema);
  const fingerprint: Readonly<Record<string, SQL>> = {
    ok: sql`(${TRACK_FINGERPRINT}) is true`,
    mismatch: sql`(${TRACK_FINGERPRINT}) is false`,
    none: sql`(${TRACK_FINGERPRINT}) is null`,
  };
  const schema: Readonly<Record<string, SQL>> = { behind, current: sql`not (${behind})` };

  const pick = (table: Readonly<Record<string, SQL>>, field: string) => (value: string) => {
    const found = table[value];
    if (found === undefined) {
      refuse(
        `"${value}" is not a value of "${field}".`,
        "Use one of the values the picker offers.",
      );
    }
    return found;
  };

  return {
    title: { kind: "text", expr: sql`${libraryTracks.title}` },
    artist: { kind: "text", expr: sql`${libraryTracks.artist}` },
    album: { kind: "text", expr: TRACK_ALBUM_TITLE },
    duration: { kind: "number", expr: sql`${libraryTracks.duration}` },
    format: {
      kind: "member",
      member: (value: string) => sql`lower(${libraryTracks.format}) = lower(${value})`,
    },
    hasLyrics: { kind: "boolean", whenTrue: TRACK_HAS_LYRICS },
    hasReplayGain: { kind: "boolean", whenTrue: TRACK_HAS_REPLAYGAIN },
    fingerprint: { kind: "member", member: pick(fingerprint, "fingerprint") },
    score: { kind: "number", expr: TRACK_SCORE },
    schema: { kind: "member", member: pick(schema, "schema") },
    missingFile: { kind: "boolean", whenTrue: sql`(${libraryTracks.missingAt} is not null)` },
    tagged: {
      kind: "boolean",
      whenTrue: sql`(${libraryTracks.recordingMbid} is not null and ${libraryTracks.recordingMbid} <> '')`,
    },
    added: { kind: "date", expr: sql`${libraryTracks.createdAt}` },
  };
}

export function trackChipCondition(
  filter: TrackFilter,
  options: { readonly currentSchema: number },
): SQL | undefined {
  switch (filter) {
    case "all":
      return undefined;
    case "nolyrics":
      return sql`not (${TRACK_HAS_LYRICS})`;
    case "noreplaygain":
      return sql`not (${TRACK_HAS_REPLAYGAIN})`;
    case "schema":
      return trackBehindSchema(options.currentSchema);
    case "untagged":
      return sql`${libraryTracks.recordingMbid} is null`;
  }
}

/** Title, artist, album, recording MBID, path — the five the box always matched. */
export function trackSearchCondition(search: string): SQL | undefined {
  const needle = search.trim();
  if (needle === "") return undefined;
  const pattern = `%${likeLiteral(needle)}%`;
  return sql`(${libraryTracks.title} ilike ${pattern}
    or coalesce(${libraryTracks.artist}, '') ilike ${pattern}
    or coalesce(${TRACK_ALBUM_TITLE}, '') ilike ${pattern}
    or coalesce(${libraryTracks.recordingMbid}, '') ilike ${pattern}
    or ${libraryTracks.path} ilike ${pattern})`;
}

/* ------------------------------------------------------------------ */
/* artists                                                             */
/* ------------------------------------------------------------------ */

/**
 * The artist page groups `library_albums.album_artist`, so its "columns" are aggregates and
 * live in a subquery. The bindings therefore take that subquery's selection rather than a
 * table: same compiler, same operators, one `where` on the outside.
 */
export interface ArtistFilterColumns {
  readonly name: SQL;
  readonly albums: SQL;
  readonly tracks: SQL;
  readonly imageUrl: SQL;
  readonly country: SQL;
}

export function artistFilterBindings(columns: ArtistFilterColumns): FilterBindings {
  return {
    name: { kind: "text", expr: columns.name },
    albums: { kind: "number", expr: columns.albums },
    tracks: { kind: "number", expr: columns.tracks },
    hasImage: { kind: "boolean", whenTrue: sql`(${columns.imageUrl} is not null)` },
    country: { kind: "text", expr: columns.country },
  };
}

export function artistSearchCondition(
  columns: ArtistFilterColumns,
  search: string,
): SQL | undefined {
  const needle = search.trim();
  if (needle === "") return undefined;
  return sql`${columns.name} ilike ${`%${likeLiteral(needle)}%`}`;
}

/* ------------------------------------------------------------------ */
/* the coverage rule                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every declared field, paired with the bindings that must answer for it.
 *
 * `library-filter.sql.test.ts` walks this: a field added to `lib/filters/fields.ts` with no
 * binding here fails the build rather than throwing `INVALID_INPUT` at whoever picks it, and a
 * field whose declared operators the binding cannot compile fails with it.
 */
export function bindingCoverage(): readonly {
  readonly page: string;
  readonly fields: FilterFieldSet;
  readonly bindings: FilterBindings;
}[] {
  const currentSchema = 1;
  return [
    {
      page: "albums",
      fields: ALBUM_FILTER_FIELDS,
      bindings: albumFilterBindings({ currentSchema }),
    },
    {
      page: "tracks",
      fields: TRACK_FILTER_FIELDS,
      bindings: trackFilterBindings({ currentSchema }),
    },
    {
      page: "artists",
      fields: ARTIST_FILTER_FIELDS,
      bindings: artistFilterBindings({
        name: sql`x.name`,
        albums: sql`x.albums`,
        tracks: sql`x.tracks`,
        imageUrl: sql`x.image_url`,
        country: sql`x.country`,
      }),
    },
  ];
}
