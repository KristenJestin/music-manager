/**
 * MusicBrainz relations → credit fields (`docs/03-metadonnees.md` §2.3).
 *
 * MusicBrainz has far more relationship types than Picard maps. The documentation settles it:
 * a role Picard does not map goes to `PERFORMER=Name (role)` **if it is a performance role**,
 * and otherwise stays in the raw cache and is written nowhere. Nothing is ever lost — the
 * cache keeps everything and a later schema version can promote a role (§8).
 */

import type { MbRelation } from "./musicbrainz-types.ts";

/** Relation types Picard maps onto a dedicated tag. */
const ROLE_FIELD: Readonly<Record<string, string>> = {
  composer: "composer",
  lyricist: "lyricist",
  writer: "writer",
  librettist: "lyricist",
  translator: "lyricist",
  arranger: "arranger",
  orchestrator: "arranger",
  "instrument arranger": "arranger",
  "vocal arranger": "arranger",
  conductor: "conductor",
  producer: "producer",
  "vocal producer": "producer",
  engineer: "engineer",
  recording: "engineer",
  mastering: "engineer",
  sound: "engineer",
  audio: "engineer",
  mix: "mixer",
  remixer: "remixer",
  "DJ-mix": "djmixer",
  "video director": "director",
  director: "director",
};

/** Relation types that ARE performances, and therefore become `PERFORMER` credits. */
const PERFORMANCE_ROLES: ReadonlySet<string> = new Set([
  "performer",
  "instrument",
  "vocal",
  "performing orchestra",
  "orchestra",
  "concertmaster",
  "chorus master",
  "programming",
]);

/** The MBID field that carries a role's artist id, when the tag map has one (§2.3). */
const ROLE_MBID_FIELD: Readonly<Record<string, string>> = {
  composer: "musicbrainz_composerid",
  lyricist: "musicbrainz_lyricistid",
  producer: "musicbrainz_producerid",
  engineer: "musicbrainz_engineerid",
  mixer: "musicbrainz_mixerid",
  remixer: "musicbrainz_remixerid",
  djmixer: "musicbrainz_djmixerid",
  conductor: "musicbrainz_conductorid",
  arranger: "musicbrainz_arrangerid",
  performer: "musicbrainz_performerid",
};

export interface CreditFromRelation {
  /** A tag-map field name: "composer", "producer"… or "performer". */
  readonly field: string;
  readonly name: string;
  readonly sortName: string | null;
  readonly mbid: string | null;
  /** Only set for `performer`: what goes in `PERFORMER=Name (role)`. */
  readonly role: string | null;
}

/**
 * Turn one artist relation into a credit, or `null` when the role is neither mapped by Picard
 * nor a performance role — in which case it stays in the raw cache, as §2.3 requires.
 */
export function creditFromRelation(relation: MbRelation): CreditFromRelation | null {
  if (relation["target-type"] !== "artist") return null;
  const artist = relation.artist;
  const name = artist?.name;
  const type = relation.type;
  if (name === undefined || name === "" || type === undefined) return null;

  const base = {
    name,
    sortName: artist?.["sort-name"] ?? null,
    mbid: artist?.id ?? null,
  };

  const mapped = ROLE_FIELD[type];
  if (mapped !== undefined) return { ...base, field: mapped, role: null };

  if (PERFORMANCE_ROLES.has(type)) {
    return { ...base, field: "performer", role: performerRole(relation) };
  }

  return null;
}

/**
 * The role shown in `PERFORMER=Name (role)`. MusicBrainz puts the instrument or the voice in
 * the relation's attributes ("guitar", "lead vocals"); when there is none, the relation type
 * itself is the role ("vocal", "programming").
 */
function performerRole(relation: MbRelation): string {
  const attributes = (relation.attributes ?? []).filter((attribute) => attribute !== "");
  if (attributes.length > 0) return attributes.join(", ");
  return relation.type ?? "performer";
}

/** The MBID field matching a credit field, when §2.3 defines one. */
export function mbidFieldFor(field: string): string | undefined {
  return ROLE_MBID_FIELD[field];
}

/** Every credit of a relation list, in MusicBrainz order, unmapped roles dropped. */
export function creditsFromRelations(
  relations: readonly MbRelation[] | undefined,
): CreditFromRelation[] {
  const out: CreditFromRelation[] = [];
  for (const relation of relations ?? []) {
    const credit = creditFromRelation(relation);
    if (credit !== null) out.push(credit);
  }
  return out;
}

/** The first URL relation of a given type, e.g. "amazon asin", "license", "official homepage". */
export function urlOfType(
  relations: readonly MbRelation[] | undefined,
  type: string,
): string | null {
  for (const relation of relations ?? []) {
    if (relation["target-type"] === "url" && relation.type === type) {
      const resource = relation.url?.resource;
      if (resource !== undefined && resource !== "") return resource;
    }
  }
  return null;
}

/** The first work linked by a "performance" relation, which is the recording's work (§2.4). */
export function performedWork(relations: readonly MbRelation[] | undefined): MbRelation | null {
  for (const relation of relations ?? []) {
    if (relation["target-type"] === "work" && relation.work !== undefined) return relation;
  }
  return null;
}
