/**
 * Identifiers.
 *
 * Every row gets a prefixed ULID: `imp_01K4XQ7N8ZC3RB2VMD9T6HFPGA`. Three reasons over a
 * UUID v4:
 *
 *  - **sortable** — the first ten characters are the millisecond timestamp, so `order by id`
 *    is chronological and the b-tree stays dense;
 *  - **readable** — Crockford base32 has no `I`, `L`, `O` or `U`, so an id survives being
 *    read aloud or retyped from a terminal, which is what the CLI asks of it;
 *  - **self-describing** — the prefix says what the id points at, so a log line or an API
 *    error is unambiguous without its schema.
 *
 * No dependency: the implementation is twenty lines and the format is frozen.
 */

/** Crockford base32, as the ULID specification defines it. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

export const ID_PREFIXES = {
  import: "imp",
  importTrack: "itr",
  jobStep: "stp",
  libraryAlbum: "alb",
  libraryTrack: "ltr",
  metadataDocument: "doc",
  inboxItem: "ibx",
  decision: "dec",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function encodeTime(millis: number): string {
  let out = "";
  let value = millis;
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  // One character per byte: 5 of the 8 bits, which is what every practical ULID does.
  for (const byte of bytes) out += ALPHABET[byte % 32];
  return out;
}

/** A bare ULID, 26 characters. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** `imp_01K4XQ7N8ZC3RB2VMD9T6HFPGA` — the id of a row of that kind. */
export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

/** True when `value` looks like an id of `kind`. Used by the CLI to accept a bare ULID. */
export function isId(kind: IdKind, value: string): boolean {
  return (
    value.startsWith(`${ID_PREFIXES[kind]}_`) && value.length === ID_PREFIXES[kind].length + 27
  );
}
