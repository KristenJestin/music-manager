/**
 * `mm doc fields` — which fields exist, and which scope each one belongs to.
 *
 * `mm doc set <id> <field> <value>` refuses an album-scope field on a track and a per-track
 * field on an album (`services/overrides.ts`), and until now the only way to learn which was
 * which was to be refused. `ALBUM`, `DATE` and `TOTALDISCS` are written on every track of the
 * album in one transaction; `DISCNUMBER` is the track's own. The refusal is right, but a
 * refusal is a poor manual.
 *
 * The answer is not a second list kept here. It is `ALBUM_SCOPE_FIELDS`, which
 * `packages/domain/src/tagmap/tags.ts` derives from the `albumScope` column of the tag map —
 * the very column `overrideTrackFields` and `overrideAlbumFields` consult. One source of
 * truth, so the manual cannot drift from the rule it documents. `albumScopeRule` supplies the
 * one nuance the boolean cannot: three of the 36 album-scope fields are constant *per disc*
 * rather than across the release, and printing "album" without saying that would be a guess
 * dressed as a fact.
 *
 * No field is invented and no level is guessed: every row is a row of the tag map.
 *
 * Its own module rather than another function in `bin/mm.ts`, like `discover.ts` beside it:
 * the dispatcher gains three lines, and the table stays testable without a database. The
 * *rendering* is a pure function of the rows for the same reason — the vitest suite asserts on
 * the text a terminal would show, not on a console spy.
 */
import { MMError } from "@mm/contracts";
import {
  ALBUM_SCOPE_FIELDS,
  albumScopeRule,
  TAGS,
  TAG_SCHEMA_VERSION,
  type TagDefinition,
} from "@mm/domain";

export interface CliArgs {
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

const out = (...parts: unknown[]): void => {
  console.log(parts.join(" "));
};

const flagBoolean = (args: CliArgs, name: string): boolean =>
  args.flags[name] === true || args.flags[name] === "true";

/** `album` when the tag map marks it `albumScope`, `track` otherwise. Never a third answer. */
export type FieldScope = "album" | "track";

export interface FieldRow {
  readonly field: string;
  readonly vorbis: string;
  readonly group: TagDefinition["group"];
  readonly level: TagDefinition["level"];
  readonly scope: FieldScope;
  /**
   * `albumScopeRule(field).grouping` for an album-scope field — `album`, or `medium` for the
   * three that are constant per disc. `null` for a per-track field, where there is no rule.
   */
  readonly grouping: "album" | "medium" | null;
  /** The rule, in one line, for an album-scope field. `""` otherwise. */
  readonly rule: string;
}

/**
 * Every field of the tag map, with its scope. The whole table, not the album-scope subset:
 * "which fields are there" is the other half of the question a `set` refusal raises.
 */
export function fieldRows(): readonly FieldRow[] {
  return TAGS.map((tag) => {
    const albumScope = ALBUM_SCOPE_FIELDS.includes(tag.field);
    const rule = albumScope ? albumScopeRule(tag.field) : null;
    return {
      field: tag.field,
      vorbis: tag.vorbis,
      group: tag.group,
      level: tag.level,
      scope: albumScope ? "album" : "track",
      grouping: rule === null ? null : rule.grouping,
      rule: rule === null ? "" : rule.why,
    };
  });
}

/** The rows of one scope only — what `--album` / `--track` narrow the table to. */
export function rowsForScope(scope: FieldScope | null): readonly FieldRow[] {
  const rows = fieldRows();
  return scope === null ? rows : rows.filter((row) => row.scope === scope);
}

/**
 * The terminal form, as text. Pure: no clock, no console, no database.
 *
 * Columns are padded by hand rather than with a table library, exactly like `mm doc show`'s
 * `FIELD / VORBIS / SOURCE` header above it — one table in the CLI is not worth a dependency.
 */
export function renderFieldTable(rows: readonly FieldRow[]): string {
  const albums = rows.filter((row) => row.scope === "album").length;
  const lines: string[] = [
    `tag schema v${String(TAG_SCHEMA_VERSION)} · ${String(rows.length)} field(s) · ` +
      `${String(albums)} album-scope, ${String(rows.length - albums)} per track`,
    "",
    `${"FIELD".padEnd(28)} ${"VORBIS".padEnd(26)} ${"GROUP".padEnd(15)} ${"LEVEL".padEnd(12)} SCOPE`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.field.padEnd(28)} ${row.vorbis.padEnd(26)} ${row.group.padEnd(15)} ` +
        `${row.level.padEnd(12)} ${row.scope}`,
    );
  }

  /*
   * The fields whose scope is a disc rather than the release, named rather than hidden behind
   * the word "album". `albumScope` is true for them — they must not differ *between the tracks
   * of one disc* — and forcing one value across a two-disc release would corrupt the second
   * disc, which is the whole of `albumscope/rules.ts`'s `medium` grouping.
   */
  const perDisc = rows.filter((row) => row.grouping === "medium");
  if (perDisc.length > 0) {
    lines.push("");
    lines.push(
      `album-scope, but constant per disc rather than across the release (${String(perDisc.length)}):`,
    );
    for (const row of perDisc) lines.push(`  ${row.field.padEnd(28)} ${row.rule}`);
  }

  lines.push("");
  lines.push(
    "`mm doc set <alb_…> <field> <value…>` writes an album-scope field on every track of the album.",
  );
  lines.push("`mm doc set <ltr_…> <field> <value…>` writes a per-track field on that one file.");
  return lines.join("\n");
}

/** `mm doc fields [--album|--track] [--json]`. */
export async function cmdDocFields(args: CliArgs): Promise<number> {
  const onlyAlbum = flagBoolean(args, "album");
  const onlyTrack = flagBoolean(args, "track");
  if (onlyAlbum && onlyTrack) {
    throw new MMError("INVALID_INPUT", "`--album` and `--track` are mutually exclusive.", {
      hint: "Pass one of them, or neither to see every field.",
    });
  }
  const scope: FieldScope | null = onlyAlbum ? "album" : onlyTrack ? "track" : null;
  const rows = rowsForScope(scope);

  if (flagBoolean(args, "json")) {
    out(JSON.stringify(rows, null, 2));
    return 0;
  }

  out(renderFieldTable(rows));
  return 0;
}
