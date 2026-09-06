/**
 * Cassettes: recorded HTTP, replayed byte for byte.
 *
 * `CLAUDE.md` forbids the network in tests, and P04 is nothing but network code. The way out
 * is to record each source's real answer once and replay it — so the tests exercise the
 * **real clients**: the real URLs, the real `inc` presets, the real limiter, the real
 * retry policy, the real parsing. Only the socket is missing.
 *
 * Three rules make the recordings safe to commit:
 *
 *  - **keys are redacted before anything is written.** The Last.fm and fanart.tv URLs carry
 *    an `api_key`, the AcoustID form carries a `client`; both sides of the tape use the
 *    redacted form as the lookup key, so a cassette can never hold a credential.
 *  - **lyrics are redacted**, exactly as `packages/domain/fixtures/README.md` explains: the
 *    LRC timestamps and the structure are kept, the words are replaced. Song lyrics are
 *    third-party copyrighted text and do not belong in a repository.
 *  - **an unmatched request is an error naming the missing key**, never a silent pass to the
 *    real network. A test that needs a new recording says so.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redact, setFetch, type FetchLike } from "#/server/integrations/http.ts";

export const CASSETTE_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "cassettes");

export interface CassetteEntry {
  readonly method: string;
  /** Already redacted. This, with the method and the form, is the lookup key. */
  readonly url: string;
  /** Form fields of a POST, redacted. Absent for a GET. */
  readonly form?: Readonly<Record<string, string>>;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** The parsed JSON body, or a string when the source did not answer JSON. */
  readonly body: unknown;
}

export interface Cassette {
  readonly recordedAt: string;
  readonly note?: string;
  readonly entries: readonly CassetteEntry[];
}

export function cassettePath(name: string): string {
  return resolve(CASSETTE_DIR, `${name}.json`);
}

export function loadCassette(name: string): Cassette {
  const path = cassettePath(name);
  if (!existsSync(path)) {
    throw new Error(
      `Missing cassette ${name}. Record it with:\n  bun run apps/web/test/record-cassettes.ts ${name}`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Cassette;
}

export function saveCassette(name: string, cassette: Cassette): void {
  mkdirSync(dirname(cassettePath(name)), { recursive: true });
  writeFileSync(cassettePath(name), `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
}

/** One request, with every credential already replaced — what a cassette may hold. */
export interface RedactedRequest {
  readonly method: string;
  readonly url: string;
  readonly form?: Record<string, string>;
}

export function redactedRequest(url: string, init: RequestInit): RedactedRequest {
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body;
  if (typeof body !== "string" || body === "") return { method, url: redact(url) };
  const form = new URLSearchParams(body);
  redactForm(form);
  form.sort();
  return { method, url: redact(url), form: Object.fromEntries(form) };
}

/** The key a request is looked up by: method, redacted URL, and the redacted form if any. */
export function keyOf(url: string, init: RequestInit): string {
  const request = redactedRequest(url, init);
  if (request.form === undefined) return `${request.method} ${request.url}`;
  const form = new URLSearchParams(request.form);
  form.sort();
  return `${request.method} ${request.url}\n${form.toString()}`;
}

/** Query/form parameters whose value is a credential. */
const SECRET_FIELDS = new Set(["client", "api_key", "apikey", "key", "token", "api-key"]);

function redactForm(form: URLSearchParams): void {
  for (const name of [...form.keys()]) {
    if (SECRET_FIELDS.has(name.toLowerCase())) form.set(name, "<redacted>");
  }
}

function entryKey(entry: CassetteEntry): string {
  if (entry.form === undefined) return `${entry.method} ${entry.url}`;
  const form = new URLSearchParams(entry.form);
  redactForm(form);
  form.sort();
  return `${entry.method} ${entry.url}\n${form.toString()}`;
}

export interface Player {
  /** How many requests the tape served. */
  readonly plays: () => number;
  readonly restore: () => void;
}

/**
 * Install one or more cassettes as the transport.
 *
 * Returns a restorer; call it in `afterEach`. Replaying the same entry twice is allowed —
 * a limiter test fires the same lookup ten times on purpose.
 */
export function play(...names: readonly string[]): Player {
  const entries = new Map<string, CassetteEntry>();
  for (const name of names) {
    for (const entry of loadCassette(name).entries) entries.set(entryKey(entry), entry);
  }

  let plays = 0;
  const transport: FetchLike = (url, init) => {
    const key = keyOf(url, init);
    const entry = entries.get(key);
    if (entry === undefined) {
      return Promise.reject(
        new Error(
          `No cassette entry for:\n  ${key}\nRecorded keys:\n  ${[...entries.keys()].join("\n  ")}`,
        ),
      );
    }
    plays += 1;
    const body = typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
    return Promise.resolve(
      new Response(entry.status === 404 ? null : body, {
        status: entry.status,
        headers: { "content-type": "application/json", ...entry.headers },
      }),
    );
  };

  const previous = setFetch(transport);
  return {
    plays: () => plays,
    restore: () => void setFetch(previous),
  };
}

/**
 * A transport that answers from a table of responses, for the cases no source should ever be
 * asked to produce on demand: a 503, a 429 with `Retry-After`, a body that is not JSON.
 */
export function scripted(answers: readonly (Response | (() => Response))[]): {
  restore: () => void;
  calls: () => number;
} {
  let index = 0;
  const previous = setFetch(() => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return Promise.resolve(typeof answer === "function" ? answer() : (answer as Response).clone());
  });
  return { restore: () => void setFetch(previous), calls: () => index };
}

/**
 * Replace every lyric line's words with a placeholder, keeping the `[mm:ss.cc]` stamps.
 *
 * The same redaction `packages/domain/scripts/record-fixtures.ts` applies, for the same
 * reason: no code reads the words, only the structure and the `instrumental` flag.
 */
export function redactLyrics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLyrics);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [name, held] of Object.entries(value as Record<string, unknown>)) {
    if (name === "syncedLyrics" && typeof held === "string") {
      out[name] = held
        .split("\n")
        .map((line) => line.replace(/^(\[[^\]]*\])\s*.*$/, "$1 lyrics redacted"))
        .join("\n");
    } else if (name === "plainLyrics" && typeof held === "string") {
      out[name] = held
        .split("\n")
        .map((line) => (line.trim() === "" ? "" : "lyrics redacted"))
        .join("\n");
    } else {
      out[name] = redactLyrics(held);
    }
  }
  return out;
}
