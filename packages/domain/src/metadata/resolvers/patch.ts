/**
 * A tiny builder shared by every resolver.
 *
 * Resolvers are the only place that decides between the three states of a field, so the rule
 * lives here: `set` ignores an absent value (the field stays **missing**), `na` records that
 * the source says the field does not exist (it leaves the completeness denominator, §6).
 * Empty strings and empty lists count as absent — MusicBrainz uses `""` for "no
 * disambiguation", not for "the disambiguation is the empty string".
 */

import {
  field,
  type DocumentPatch,
  type Field,
  type FieldValue,
  type NotApplicable,
  type SourceId,
} from "../document.ts";

export class PatchBuilder {
  private readonly fields: Record<string, Field> = {};
  private readonly notApplicable: Record<string, NotApplicable> = {};

  constructor(
    private readonly source: SourceId,
    private readonly fetchedAt: string,
    private readonly confidence = 1,
  ) {}

  /** Record a value, unless it is absent. Returns whether anything was recorded. */
  set(
    name: string,
    value: FieldValue | null | undefined,
    options: { confidence?: number } = {},
  ): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    this.fields[name] = field(value, this.source, this.fetchedAt, {
      confidence: options.confidence ?? this.confidence,
    });
    return true;
  }

  /** Record a value, or mark the field n/a with `reason` when it is absent. */
  setOrNa(name: string, value: FieldValue | null | undefined, reason: string): void {
    if (!this.set(name, value)) this.na(name, reason);
  }

  /** The source states this field does not exist for this track (§6). */
  na(name: string, reason: string): void {
    this.notApplicable[name] = { reason, source: this.source };
  }

  /** n/a for several fields at once, with the same reason. */
  naAll(names: readonly string[], reason: string): void {
    for (const name of names) this.na(name, reason);
  }

  build(): DocumentPatch {
    return { fields: this.fields, na: this.notApplicable };
  }
}
