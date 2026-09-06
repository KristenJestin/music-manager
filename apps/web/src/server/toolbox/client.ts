/**
 * The bridge to the Python toolbox (`docs/06-stack.md` § Principes du pont).
 *
 * Two things live here and nothing else:
 *
 *  - a typed client over the **generated** OpenAPI contract, so a renamed field in
 *    `services/toolbox/src/toolbox/models.py` is a TypeScript error here rather than a
 *    surprise at runtime;
 *  - the NDJSON reader for `POST /download`, which `openapi-fetch` cannot express because
 *    the response is a stream of events rather than a body.
 *
 * Every failure leaves as an `MMError` carrying the toolbox's own `{code, message, hint,
 * action}`, so the error decoder of the Console sees one shape whichever side broke.
 */
import createClient from "openapi-fetch";
import { MMError } from "@mm/contracts";
import type { components, paths } from "@mm/contracts/toolbox";
import { serverEnv } from "#/server/env.ts";
import type { CookieJar } from "#/server/services/cookies.ts";

export type ExtractResult = components["schemas"]["ExtractResult"];
export type ExtractEntry = components["schemas"]["ExtractEntry"];
export type FingerprintResult = components["schemas"]["FingerprintResult"];
export type ProbeResult = components["schemas"]["ProbeResult"];
export type TagRequest = components["schemas"]["TagRequest"];
export type TagResult = components["schemas"]["TagResult"];
export type ReplayGainResult = components["schemas"]["ReplayGainResult"];
export type PlaceResult = components["schemas"]["PlaceResult"];
export type ArtworkResult = components["schemas"]["ArtworkResult"];
export type ToolboxHealthResult = components["schemas"]["Health"];
export type Tag = components["schemas"]["Tag"];
export type Picture = components["schemas"]["Picture"];
export type OnExists = components["schemas"]["OnExists"];
export type UpdateResult = components["schemas"]["UpdateResult"];
export type SelfTestResult = components["schemas"]["SelfTestResult"];
export type SelfTestCheck = components["schemas"]["SelfTestCheck"];
export type CookiesTestResult = components["schemas"]["CookiesTestResult"];
export type ToolVersions = components["schemas"]["ToolVersions"];
export type ErrorCatalog = components["schemas"]["ErrorCatalog"];
export type ErrorCatalogEntry = components["schemas"]["ErrorCatalogEntry"];
export type YtMusicSearchResult = components["schemas"]["YtMusicSearchResult"];
export type YtMusicCandidate = components["schemas"]["YtMusicCandidate"];

/**
 * Fallback format selector, mirroring `DEFAULT_FORMAT` in the toolbox's `models.py`.
 *
 * Opus first: on YouTube that is itag 251, which the toolbox remuxes into `.opus` by stream
 * copy. Plain `bestaudio` used to leave a `.webm` behind that no tagger can write to.
 */
export const DEFAULT_DOWNLOAD_FORMAT = "bestaudio[acodec=opus]/bestaudio/best";

/** One line of the `POST /download` NDJSON stream (`services/toolbox/.../download.py`). */
export type DownloadEvent =
  | {
      event: "progress";
      downloaded: number;
      total: number | null;
      speed?: number | null;
      eta?: number | null;
    }
  | { event: "postprocess"; step: string }
  | { event: "done"; path: string; format_id: string; codec: string; size: number }
  | { event: "error"; code: string; message: string; hint?: string; action?: string };

export interface ToolboxOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  /** Milliseconds before a non-streaming call is abandoned. */
  readonly timeoutMs?: number;
}

export interface DownloadOptions {
  readonly url: string;
  /** Destination directory **as the toolbox sees it**. */
  readonly destDir: string;
  /** Opaque id echoed in every event and used as the file stem. */
  readonly id: string;
  readonly format?: string;
  /** The YouTube session, if this installation has one. */
  readonly cookies?: CookieJar;
  readonly signal?: AbortSignal;
}

/**
 * The two cookie fields of `YtdlpOptions`, as the toolbox spells them.
 *
 * Written once and reused, because forgetting them is invisible: a download without a
 * session simply fails later with a bot check, which reads like YouTube's fault.
 */
function cookieBody(jar: CookieJar): { cookies: string | null; cookies_content: string | null } {
  return { cookies: jar.path ?? null, cookies_content: jar.content ?? null };
}

/** A thin, typed, error-normalising wrapper. One instance per process is plenty. */
export class ToolboxClient {
  private readonly http: ReturnType<typeof createClient<paths>>;
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: ToolboxOptions = {}) {
    const env = options.baseUrl === undefined || options.token === undefined ? serverEnv() : null;
    this.baseUrl = (options.baseUrl ?? env?.MM_TOOLBOX_URL ?? "http://localhost:8100").replace(
      /\/+$/,
      "",
    );
    this.token = options.token ?? env?.MM_TOOLBOX_TOKEN ?? "";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.http = createClient<paths>({ baseUrl: this.baseUrl, headers: this.headers() });
  }

  private headers(): Record<string, string> {
    return this.token === "" ? {} : { authorization: `Bearer ${this.token}` };
  }

  /**
   * Unwrap an `openapi-fetch` result. The toolbox documents `4XX`/`5XX` with its own error
   * body, so a failure is decoded rather than stringified.
   */
  private unwrap<T>(result: { data?: T; error?: unknown; response: Response }, what: string): T {
    if (result.error !== undefined) {
      // The HTTP status goes into the *fallback message*, not only into the field: a step that
      // stores `{code:"UNKNOWN", message:"POST /extract failed."}` in `job_steps.error` told a
      // reader nothing, and that is exactly how a 422 from a stale image stayed invisible.
      const error = MMError.fromBody(
        result.error,
        `${what} failed with HTTP ${String(result.response.status)}.`,
      );
      throw new MMError(error.code, error.message, {
        hint: error.hint,
        action: error.action,
        details: error.details,
        status: result.response.status,
      });
    }
    if (result.data === undefined) {
      throw new MMError("UNKNOWN", `${what} returned no body (HTTP ${result.response.status}).`);
    }
    return result.data;
  }

  /** Wrap a transport failure — a stopped container is not a `fetch` stack trace. */
  private async call<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof MMError) throw error;
      throw new MMError("TOOLBOX_UNREACHABLE", `The toolbox did not answer ${what}.`, {
        hint: `Is it running? \`docker compose -f docker-compose.dev.yml up -d toolbox\` (${this.baseUrl}).`,
        action: "Start the toolbox",
        cause: error,
      });
    }
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  async health(): Promise<ToolboxHealthResult> {
    return await this.call("GET /health", async () => {
      const result = await this.http.GET("/health", { signal: this.signal() });
      return this.unwrap(result, "GET /health");
    });
  }

  /** `GET /errors` — the failure taxonomy behind the Console's error decoder. */
  async errorCatalog(): Promise<ErrorCatalog> {
    return await this.call("GET /errors", async () => {
      const result = await this.http.GET("/errors", { signal: this.signal() });
      return this.unwrap(result, "GET /errors");
    });
  }

  async extract(url: string, jar: CookieJar = {}): Promise<ExtractResult> {
    return await this.call("POST /extract", async () => {
      const result = await this.http.POST("/extract", {
        body: { url, ...cookieBody(jar) },
        signal: this.signal(),
      });
      return this.unwrap(result, "POST /extract");
    });
  }

  /**
   * Find the YouTube Music album playlist (`OLAK5uy_…`) or song behind an artist/album pair.
   *
   * This is the half of Discover that turns a MusicBrainz id into something importable
   * (`docs/05-recommandations.md` § La boucle). It is a *search*: the answer is a ranked list
   * of candidates, and the caller decides — nothing here ever queues a download.
   */
  async searchYtMusic(request: {
    artist: string;
    album?: string;
    title?: string;
    limit?: number;
  }): Promise<YtMusicSearchResult> {
    return await this.call("POST /ytmusic/search", async () => {
      const result = await this.http.POST("/ytmusic/search", {
        body: {
          artist: request.artist,
          limit: request.limit ?? 10,
          ...(request.album === undefined ? {} : { album: request.album }),
          ...(request.title === undefined ? {} : { title: request.title }),
        },
        signal: this.signal(),
      });
      return this.unwrap(result, "POST /ytmusic/search");
    });
  }

  async probe(path: string): Promise<ProbeResult> {
    return await this.call("POST /probe", async () => {
      const result = await this.http.POST("/probe", { body: { path }, signal: this.signal() });
      return this.unwrap(result, "POST /probe");
    });
  }

  async fingerprint(path: string, acoustidKey?: string): Promise<FingerprintResult> {
    return await this.call("POST /fingerprint", async () => {
      const result = await this.http.POST("/fingerprint", {
        body: { path, acoustid_key: acoustidKey ?? null },
        signal: this.signal(),
      });
      return this.unwrap(result, "POST /fingerprint");
    });
  }

  async tag(request: TagRequest): Promise<TagResult> {
    return await this.call("POST /tag", async () => {
      const result = await this.http.POST("/tag", { body: request, signal: this.signal() });
      return this.unwrap(result, "POST /tag");
    });
  }

  async replaygain(request: {
    files: string[];
    album?: boolean;
    referenceLoudness?: number;
    write?: boolean;
  }): Promise<ReplayGainResult> {
    return await this.call("POST /replaygain", async () => {
      const result = await this.http.POST("/replaygain", {
        body: {
          files: request.files,
          album: request.album ?? true,
          reference_loudness: request.referenceLoudness ?? -18,
          write: request.write ?? true,
        },
        signal: this.signal(),
      });
      return this.unwrap(result, "POST /replaygain");
    });
  }

  async place(request: { src: string; dest: string; onExists?: OnExists }): Promise<PlaceResult> {
    return await this.call("POST /place", async () => {
      const result = await this.http.POST("/place", {
        body: {
          src: request.src,
          dest: request.dest,
          on_exists: request.onExists ?? null,
        },
        signal: this.signal(),
      });
      return this.unwrap(result, "POST /place");
    });
  }

  async prepareArtwork(request: {
    url?: string;
    path?: string;
    size?: number;
    square?: boolean;
    quality?: number;
  }): Promise<ArtworkResult> {
    return await this.call("POST /artwork/prepare", async () => {
      const result = await this.http.POST("/artwork/prepare", {
        body: {
          url: request.url ?? null,
          path: request.path ?? null,
          size: request.size ?? 1200,
          square: request.square ?? true,
          quality: request.quality ?? 90,
        },
        signal: this.signal(),
      });
      return this.unwrap(result, "POST /artwork/prepare");
    });
  }

  /**
   * `POST /ytdlp/update` — refresh the downloader (decision 012).
   *
   * Given its own five-minute budget: `pip install --upgrade` on a cold cache is slow, and a
   * timeout in the middle of it leaves a half-installed package, which is the one outcome
   * worse than an out-of-date one.
   */
  async updateYtdlp(): Promise<UpdateResult> {
    return await this.call("POST /ytdlp/update", async () => {
      const result = await this.http.POST("/ytdlp/update", {
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 300_000)),
      });
      return this.unwrap(result, "POST /ytdlp/update");
    });
  }

  /** `POST /ytdlp/selftest` — is the downloader usable at all? `network` also hits YouTube. */
  async selftestYtdlp(options: { network?: boolean; url?: string } = {}): Promise<SelfTestResult> {
    return await this.call("POST /ytdlp/selftest", async () => {
      const result = await this.http.POST("/ytdlp/selftest", {
        body: { network: options.network ?? false, url: options.url ?? null },
        signal: this.signal(),
      });
      return this.unwrap(result, "POST /ytdlp/selftest");
    });
  }

  /** `POST /cookies/test` — parse a cookie jar offline and say whether it is a session. */
  async testCookies(options: { path?: string; content?: string }): Promise<CookiesTestResult> {
    return await this.call("POST /cookies/test", async () => {
      const result = await this.http.POST("/cookies/test", {
        body: { path: options.path ?? null, content: options.content ?? null },
        signal: this.signal(),
      });
      return this.unwrap(result, "POST /cookies/test");
    });
  }

  /**
   * Stream `POST /download`, yielding one parsed event per NDJSON line.
   *
   * Written with `fetch` rather than the generated client on purpose: the response is an
   * open stream, not a body, and the whole point of the endpoint is that the caller sees
   * progress while it is still running. A `409` is decoded before the first line is read, so
   * `LOCKED` arrives as a real error rather than as an event nobody is listening for yet.
   */
  async *download(options: DownloadOptions): AsyncGenerator<DownloadEvent> {
    const response = await this.call("POST /download", async () =>
      fetch(`${this.baseUrl}/download`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers() },
        body: JSON.stringify({
          url: options.url,
          dest_dir: options.destDir,
          id: options.id,
          format: options.format ?? DEFAULT_DOWNLOAD_FORMAT,
          ...cookieBody(options.cookies ?? {}),
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );

    if (!response.ok) {
      const decoded = MMError.fromBody(
        await response.json().catch(() => null),
        `POST /download failed with HTTP ${String(response.status)}.`,
      );
      throw new MMError(decoded.code, decoded.message, {
        hint: decoded.hint,
        action: decoded.action,
        details: decoded.details,
        status: decoded.status ?? response.status,
      });
    }
    if (response.body === null) {
      throw new MMError("UNKNOWN", "POST /download returned an empty stream.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") yield parseEvent(line);
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail !== "") yield parseEvent(tail);
  }
}

/** A malformed line is a broken bridge, not something to guess about. */
function parseEvent(line: string): DownloadEvent {
  try {
    return JSON.parse(line) as DownloadEvent;
  } catch (error) {
    throw new MMError(
      "UNKNOWN",
      `The toolbox sent a line that is not JSON: ${line.slice(0, 120)}`,
      {
        cause: error,
      },
    );
  }
}

let cached: ToolboxClient | undefined;

/** Process-wide client. Lazy, so importing this module never opens a socket. */
export function toolbox(): ToolboxClient {
  cached ??= new ToolboxClient();
  return cached;
}

/** Test helper: forget the cached client (the environment may have changed). */
export function resetToolbox(): void {
  cached = undefined;
}
