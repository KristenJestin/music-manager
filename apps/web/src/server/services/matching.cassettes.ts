/**
 * Recorded MusicBrainz traffic for the four matching scenarios.
 *
 * A cassette is not a mock. It is the set of `(key, payload)` documents one real match
 * touches, under the exact keys `integrations/musicbrainz.ts` computes for them. Replaying one
 * runs the real code path — same searches, same lookups, same parsing, same scoring — with the
 * gateway of `matching.gateway.ts` in front of it instead of a socket. Nothing is stubbed, so
 * a cassette test fails for the same reasons production would, and it needs no database, no
 * network and no Docker.
 *
 * **They are pruned** to the fields the matcher reads (`scripts/prune-musicbrainz.ts`): a full
 * release lookup carries every track's producer and composer relations for the document
 * builder, which is thirty megabytes across four scenarios and nothing a test asserts. That is
 * also why they are never written into the raw cache — a release with its relations amputated
 * would quietly degrade P04's document build. The document side has recordings of its own.
 *
 * Recorded once, at one request per second, by `bun run scripts/record-matching-cassettes.ts`,
 * which records four more lookups than a match spends so a shifted pre-score still replays.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MatchVideo } from "@mm/domain";

/** `apps/web/test/cassettes/matching/`, five directories up from this file. */
const CASSETTE_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../test/cassettes/matching",
);

/** One recorded response, under the cache key the client would compute for it. */
export interface CassetteEntry {
  readonly key: string;
  readonly payload: unknown;
}

/**
 * One scenario: the source videos it starts from, and every MusicBrainz document one match
 * of it touches.
 *
 * The videos live in the cassette rather than being derived from the toolbox fixtures on
 * purpose — two of the four scenarios (`skinny-love` as Birdy's video, `currents` with two
 * tracks missing) are deliberately *not* what the toolbox serves, because the phase
 * specification's table asks for those exact situations. Keeping them here means `mm match`
 * needs neither Docker nor the toolbox to reproduce the table.
 */
export interface Cassette {
  readonly name: string;
  readonly kind: "album" | "single";
  readonly recordedAt: string;
  readonly source: {
    readonly url: string;
    readonly album?: string | null;
    readonly artist?: string | null;
    readonly year?: number | null;
    readonly label?: string | null;
    readonly note?: string;
  };
  readonly videos: readonly MatchVideo[];
  readonly entries: readonly CassetteEntry[];
}

const cache = new Map<string, Cassette>();

/** The names on disk, for the CLI's help and for the test that iterates all of them. */
export function cassetteNames(): string[] {
  if (!existsSync(CASSETTE_ROOT)) return [];
  return readdirSync(CASSETTE_ROOT)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** True when a URL names a recorded scenario: `fixture://discovery`, `fixture://currents`… */
export function cassetteNameOf(url: string): string | null {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed.startsWith("fixture://")) return null;
  const rest = trimmed.slice("fixture://".length);
  const name = (rest.split("?")[0] ?? "").split("#")[0] ?? "";
  return name === "" ? null : name;
}

export function loadCassette(name: string): Cassette | null {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const path = resolve(CASSETTE_ROOT, `${name}.json`);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Cassette;
  cache.set(name, parsed);
  return parsed;
}
