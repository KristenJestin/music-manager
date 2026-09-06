/**
 * Recorded Navidrome answers, and the fake `fetch` that replays them.
 *
 * `CLAUDE.md`: **no network in unit tests, ever.** But a Subsonic client that is only ever
 * proven against hand-written objects proves nothing — half the value of this client is that
 * it copes with the shapes Navidrome really returns (`{year, month, day}` for a date, `0` for
 * a bpm it does not have, an image body where JSON was expected). So the answers are recorded
 * once against the dockerised server and replayed byte for byte.
 *
 * Re-record with:
 *
 *     docker compose -f docker-compose.dev.yml up -d navidrome
 *     bun run apps/web/src/server/integrations/navidrome/record-cassettes.ts
 *
 * The cassette is keyed on the **view plus the parameters that matter** — never on the whole
 * URL, because the token and the salt change on every single request by design.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NavidromeCassette {
  readonly recordedAt: string;
  readonly serverVersion: string;
  /** `view` or `view?key=value` — see `cassetteKey`. */
  readonly entries: Record<string, unknown>;
  /** `getCoverArt` returns an image; only its size and magic number are kept. */
  readonly binary: Record<string, { readonly contentType: string; readonly bytesBase64: string }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The identity of one recorded call.
 *
 * Only the parameters that change the answer are part of it: `u`, `t`, `s`, `v`, `c` and `f`
 * are authentication and framing, and including them would make every cassette a single-use
 * recording of one salt.
 */
export const KEY_PARAMS = ["id", "query", "type", "artist", "fullScan", "size", "count", "offset"];

export function cassetteKey(view: string, params: URLSearchParams): string {
  const parts: string[] = [];
  for (const name of KEY_PARAMS) {
    const value = params.get(name);
    if (value !== null) parts.push(`${name}=${value}`);
  }
  return parts.length === 0 ? view : `${view}?${parts.join("&")}`;
}

export function loadCassette(name = "discovery"): NavidromeCassette {
  const path = join(HERE, "cassettes", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as NavidromeCassette;
}

/**
 * A `fetch` that answers from a cassette and throws on anything it has not recorded.
 *
 * Throwing rather than returning a 404 is deliberate: a test that quietly exercises the
 * "server said no" path when it meant to exercise the happy one is a test that passes for the
 * wrong reason.
 */
export function cassetteFetch(
  cassette: NavidromeCassette,
): (url: string, init: RequestInit) => Promise<Response> {
  return (url: string) => {
    const parsed = new URL(url);
    const view = parsed.pathname.replace(/^.*\/rest\//, "");
    const key = cassetteKey(view, parsed.searchParams);

    const binary = cassette.binary[key];
    if (binary !== undefined) {
      const bytes = Uint8Array.from(atob(binary.bytesBase64), (character) =>
        character.charCodeAt(0),
      );
      return Promise.resolve(
        new Response(bytes, { status: 200, headers: { "content-type": binary.contentType } }),
      );
    }

    const body = cassette.entries[key];
    if (body === undefined) {
      throw new Error(
        `navidrome cassette "${cassette.recordedAt}" has no entry for ${key}; re-record it.`,
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

/** A `fetch` that answers one canned envelope, for the error paths. */
export function envelopeFetch(
  envelope: unknown,
  status = 200,
): (url: string, init: RequestInit) => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ "subsonic-response": envelope }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}
