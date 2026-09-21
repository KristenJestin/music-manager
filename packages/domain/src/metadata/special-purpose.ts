/**
 * MusicBrainz special-purpose entities — the rows that mean “there is no such thing” (issue #6).
 *
 * MusicBrainz does not leave a field empty when it has nothing to put in it: it points at a
 * real row whose *name* is bracketed — `[no label]`, `[unknown]` — precisely so that a human
 * reading the database knows it is not a name. Copying `label-info[].label.name` as it stands,
 * which is what the resolver used to do, therefore wrote a fake label: 78 files out of 4,000
 * carry `LABEL=[no label]`, and a player's label browser lists it as a publisher.
 *
 * **D6-01 · keyed by MBID, never by name.** `[PIAS]` and `[adult swim]` are real labels and
 * artists whose name happens to be bracketed, so a bracket *pattern* would eat them; the MBID
 * is stable and documented, the name is a display artefact. Note that one spelling appears in
 * both tables with two different MBIDs — `[unknown]` is an artist *and* a label — which is the
 * other reason the key is the identifier and the value carries its kind.
 *
 * The guideline also lists bracketed *credits* that have no entity behind them (`[christmas
 * music]`, `[classical music]`, `[soundtrack]`, `[nature sounds]`, `[news report]`): they are
 * plain credit strings, they have no MBID, and this table therefore does not and cannot catch
 * them. That is the trade D6-01 makes, knowingly.
 *
 * Sources: https://musicbrainz.org/doc/Style/Unknown_and_untitled/Special_purpose_artist,
 * https://musicbrainz.org/doc/Style/Unknown_and_untitled/Special_purpose_label.
 */

export type SpecialPurposeKind = "artist" | "label";

export interface SpecialPurposeEntity {
  readonly kind: SpecialPurposeKind;
  /** How MusicBrainz spells it, square brackets included. */
  readonly name: string;
  /** What the field's `n/a` says when this entity is all the source had (D6-02). */
  readonly reason: string;
}

/** The `n/a` reason of D6-02, one sentence per kind, so a document says which it was. */
export const SPECIAL_PURPOSE_ARTIST_REASON = "MusicBrainz special-purpose artist";
export const SPECIAL_PURPOSE_LABEL_REASON = "MusicBrainz special-purpose label";

function artist(name: string): SpecialPurposeEntity {
  return Object.freeze({ kind: "artist" as const, name, reason: SPECIAL_PURPOSE_ARTIST_REASON });
}

function label(name: string): SpecialPurposeEntity {
  return Object.freeze({ kind: "label" as const, name, reason: SPECIAL_PURPOSE_LABEL_REASON });
}

/**
 * Every documented special-purpose entity, by MBID.
 *
 * `Various Artists` is **not** here, and that is a decision, not an omission: it is a
 * special-purpose artist too, but it is the row that makes a compilation a compilation — it is
 * what `ALBUMARTIST` says and what sets `COMPILATION=1`, and players group by it. Treating it
 * as “no artist” would lose the one thing it exists for. `MusicBrainz Test Artist` and
 * `MusicBrainz Test Label` are left out for the opposite reason: they are not a way of saying
 * “nothing”, they are a way of saying “never ship this”, and no real release carries them.
 */
export const SPECIAL_PURPOSE_MBIDS: ReadonlyMap<string, SpecialPurposeEntity> = new Map<
  string,
  SpecialPurposeEntity
>([
  /* Special purpose artists. */
  ["f731ccc4-e22a-43af-a747-64213329e088", artist("[anonymous]")],
  ["33cf029c-63b0-41a0-9855-be2a3665fb3b", artist("[data]")],
  ["314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc", artist("[dialogue]")],
  ["eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61", artist("[no artist]")],
  ["9be7f096-97ec-4615-8957-8d40b5dcbc41", artist("[traditional]")],
  ["125ec42a-7229-4250-afc5-e057484327fe", artist("[unknown]")],
  /* The two subsets of `[unknown]` that have an entity of their own. */
  ["66ea0139-149f-4a0c-8fbf-5ea9ec4a6e49", artist("[Disney]")],
  ["a0ef7e1d-44ff-4039-9435-7d5fefdeecc9", artist("[theatre]")],
  /* The two subsets of `[no artist]` that have an entity of their own. */
  ["90068d37-bae7-4292-be4a-704c145bd616", artist("[church chimes]")],
  ["80a8851f-444c-4539-892b-ad2a49292aa9", artist("[language instruction]")],

  /* Special purpose labels. */
  ["157afde4-4bf5-4039-8ad2-5a15acc85176", label("[no label]")],
  ["46caaa9e-3e26-49b5-827c-64ccc73c1b07", label("[unknown]")],
]);

/** The entity behind `mbid`, or `undefined` for an ordinary label or artist. */
export function specialPurposeEntity(
  mbid: string | null | undefined,
): SpecialPurposeEntity | undefined {
  return mbid === null || mbid === undefined ? undefined : SPECIAL_PURPOSE_MBIDS.get(mbid);
}

/** True for a `[no artist]`-style row — the ones a credit has to drop. */
export function isSpecialPurposeArtist(mbid: string | null | undefined): boolean {
  return specialPurposeEntity(mbid)?.kind === "artist";
}

/** True for a `[no label]`-style row — the ones a release must not name as its label. */
export function isSpecialPurposeLabel(mbid: string | null | undefined): boolean {
  return specialPurposeEntity(mbid)?.kind === "label";
}

/**
 * `[none]` — MusicBrainz's placeholder *catalogue number*, the string the style guide asks an
 * editor to type when a release has no catalogue number at all.
 *
 * It is not an entity: it has no MBID, it cannot be in the table above, and it is matched as
 * the literal value it is. It means exactly what `[no label]` means one field over — nothing —
 * so writing it would put `CATALOGNUMBER=[none]` in the library and, worse, let the album-scope
 * union pick it as the album's catalogue number.
 */
export const CATALOGUE_NUMBER_PLACEHOLDER = "[none]";

/** True when a catalogue number is MusicBrainz's way of saying there is none. */
export function isCatalogueNumberPlaceholder(value: string): boolean {
  return value.trim().toLowerCase() === CATALOGUE_NUMBER_PLACEHOLDER;
}
