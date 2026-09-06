/**
 * `navidrome.client` — the OpenSubsonic reader (`docs/03-metadonnees.md` §7, decision 009).
 *
 * The only proof that a tag *arrived* is a client showing it. Files on disk prove nothing:
 * every server has its own idea of which frames it indexes, and the one this project targets
 * is Navidrome, reached through the Subsonic REST API that Feishin and Symfonium also speak.
 * So the `verify` step does not re-read the file — it asks the server.
 *
 * Three things are worth knowing about the protocol:
 *
 *  - **Authentication is `t` + `s`, never `p`.** The token is `md5(password + salt)` with a
 *    fresh salt per request; the password never crosses the wire, not even base64-encoded as
 *    the deprecated `enc:` form does.
 *  - **`f=json` still wraps everything** in `{"subsonic-response": {...}}`, and a *failure*
 *    is `status: "failed"` inside an HTTP 200. Ignoring that is how a wrong password reads as
 *    an empty library.
 *  - **Absent is not empty.** A view omits a key it has nothing for, which is exactly the
 *    `not indexed` verdict of §7; the client therefore returns `undefined` rather than
 *    normalising to `null`, and the comparison in `services/verify.ts` decides what it means.
 *
 * No caching layer: unlike the P04 sources this one is on the local network, is asked at most
 * once per album, and is being consulted precisely because we want *today's* answer.
 */
import { createHash, randomBytes } from "node:crypto";
import { MMError } from "@mm/contracts";
import type {
  CoverArtInfo,
  NavidromeIdentity,
  SubsonicAlbum,
  SubsonicEnvelope,
  SubsonicScanStatus,
  SubsonicSearchResult,
  SubsonicSong,
  SubsonicStructuredLyrics,
} from "./types.ts";

/** The version we claim. 1.16.1 is what Navidrome documents and what P02 tested against. */
export const SUBSONIC_API_VERSION = "1.16.1";
/** The `c` parameter. It shows up in Navidrome's own logs, so it says who we are. */
export const SUBSONIC_CLIENT = "music-manager";

export interface NavidromeConfig {
  readonly url: string;
  readonly user: string;
  readonly password: string;
  /** Milliseconds before one request is abandoned. */
  readonly timeoutMs?: number;
}

/** Injected by the cassette tests so the client can be proven without a server. */
export type NavidromeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface NavidromeClientOptions {
  readonly fetch?: NavidromeFetch;
  /** Test seam: a deterministic salt makes a recorded cassette reproducible. */
  readonly salt?: () => string;
}

function unreachable(baseUrl: string, view: string, cause: unknown): MMError {
  return new MMError("NAVIDROME_UNREACHABLE", `Navidrome did not answer ${view}.`, {
    hint: `Is it running and is the URL right? (${baseUrl})`,
    action: "Open settings",
    cause,
  });
}

export class NavidromeClient {
  readonly baseUrl: string;
  private readonly user: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly doFetch: NavidromeFetch;
  private readonly makeSalt: () => string;

  constructor(config: NavidromeConfig, options: NavidromeClientOptions = {}) {
    this.baseUrl = config.url.trim().replace(/\/+$/, "");
    this.user = config.user;
    this.password = config.password;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.makeSalt = options.salt ?? (() => randomBytes(8).toString("hex"));
  }

  /** True when there is enough here to try at all. */
  get configured(): boolean {
    return this.baseUrl !== "" && this.user !== "";
  }

  /**
   * The six parameters every view takes.
   *
   * A new salt per request is not paranoia: a fixed salt turns the token into a password
   * equivalent that a proxy log would hand to anyone who read it.
   */
  private authParams(): Record<string, string> {
    const salt = this.makeSalt();
    const token = createHash("md5")
      .update(this.password + salt)
      .digest("hex");
    return {
      u: this.user,
      t: token,
      s: salt,
      v: SUBSONIC_API_VERSION,
      c: SUBSONIC_CLIENT,
      f: "json",
    };
  }

  private urlFor(view: string, params: Record<string, string | number | boolean>): string {
    const query = new URLSearchParams(this.authParams());
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    return `${this.baseUrl}/rest/${view}?${query.toString()}`;
  }

  private requireConfigured(): void {
    if (this.configured) return;
    throw new MMError("NAVIDROME_NOT_CONFIGURED", "No Navidrome server is configured.", {
      hint: "Settings → Integrations holds the URL, the user and the password.",
      action: "Open settings",
    });
  }

  /**
   * Call one view and unwrap it.
   *
   * The Subsonic error codes are turned into our own taxonomy so the Console's error decoder
   * can offer a button: 40 is a bad password, 50 is a user without the right, 70 is
   * "not found", and everything else is reported as it came.
   */
  private async get(
    view: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<SubsonicEnvelope> {
    this.requireConfigured();
    const url = this.urlFor(view, params);
    let response: Response;
    try {
      response = await this.doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw unreachable(this.baseUrl, view, error);
    }

    if (!response.ok) {
      throw new MMError(
        "NAVIDROME_FAILED",
        `Navidrome answered HTTP ${String(response.status)} to ${view}.`,
        { hint: "The URL points at something that is not an OpenSubsonic API.", status: response.status },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new MMError("NAVIDROME_FAILED", `${view} did not answer JSON.`, {
        hint: "Check that the URL is the server root, without `/rest` and without a proxy prefix.",
        cause: error,
      });
    }

    const envelope = (body as { "subsonic-response"?: SubsonicEnvelope })["subsonic-response"];
    if (envelope === undefined) {
      throw new MMError("NAVIDROME_FAILED", `${view} answered something that is not Subsonic.`, {
        hint: "Expected a `subsonic-response` envelope.",
      });
    }
    if (envelope.status !== "ok") {
      const code = envelope.error?.code ?? 0;
      const message = envelope.error?.message ?? "unknown error";
      if (code === 40 || code === 41) {
        throw new MMError("NAVIDROME_AUTH", `Navidrome refused the credentials: ${message}`, {
          hint: "The user or the password in Settings → Integrations is wrong.",
          action: "Open settings",
          details: { code },
        });
      }
      throw new MMError("NAVIDROME_FAILED", `${view} failed: ${message}`, {
        hint: `Subsonic error code ${String(code)}.`,
        details: { code },
      });
    }
    return envelope;
  }

  /** A view's own payload, e.g. `album` out of `getAlbum`. */
  private static payload<T>(envelope: SubsonicEnvelope, key: string): T | undefined {
    const value = envelope[key];
    return value === undefined ? undefined : (value as T);
  }

  /* ---------------------------------------------------------------- */
  /* the views                                                         */
  /* ---------------------------------------------------------------- */

  /** Is it there, is the password right, and who is it? Also the Tools latency row. */
  async ping(): Promise<NavidromeIdentity> {
    const started = Date.now();
    const envelope = await this.get("ping");
    return {
      ok: true,
      type: envelope.type ?? "unknown",
      serverVersion: envelope.serverVersion ?? "",
      apiVersion: envelope.version ?? "",
      openSubsonic: envelope.openSubsonic === true,
      latencyMs: Date.now() - started,
    };
  }

  /** Ask for a scan. `full` re-reads every file rather than the changed ones. */
  async startScan(options: { full?: boolean } = {}): Promise<SubsonicScanStatus> {
    const envelope = await this.get("startScan", { fullScan: options.full === true });
    return NavidromeClient.payload<SubsonicScanStatus>(envelope, "scanStatus") ?? { scanning: true };
  }

  async getScanStatus(): Promise<SubsonicScanStatus> {
    const envelope = await this.get("getScanStatus");
    return (
      NavidromeClient.payload<SubsonicScanStatus>(envelope, "scanStatus") ?? { scanning: false }
    );
  }

  /**
   * Wait for the scanner to go quiet.
   *
   * `count > 0` as well as `scanning === false`, because a Navidrome that has just started
   * answers "not scanning" for a second or two before it begins — waiting on the flag alone
   * reads the library as it was before the album landed.
   */
  async waitForScan(options: {
    timeoutMs: number;
    pollMs?: number;
    signal?: AbortSignal;
    onPoll?: (status: SubsonicScanStatus) => void;
  }): Promise<SubsonicScanStatus> {
    const pollMs = options.pollMs ?? 2_000;
    const deadline = Date.now() + options.timeoutMs;
    let last: SubsonicScanStatus = { scanning: true };
    for (;;) {
      if (options.signal?.aborted === true) return last;
      last = await this.getScanStatus();
      options.onPoll?.(last);
      if (!last.scanning && (last.count ?? 0) > 0) return last;
      if (Date.now() >= deadline) {
        throw new MMError(
          "NAVIDROME_SCAN_TIMEOUT",
          `Navidrome was still scanning after ${(options.timeoutMs / 1000).toFixed(0)}s.`,
          {
            hint: "A large library takes a while; raise the wait timeout in Settings → Integrations.",
            action: "Open settings",
            details: { lastStatus: { ...last } },
          },
        );
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), options.signal);
    }
  }

  async getAlbum(id: string): Promise<SubsonicAlbum | undefined> {
    const envelope = await this.get("getAlbum", { id });
    return NavidromeClient.payload<SubsonicAlbum>(envelope, "album");
  }

  async getSong(id: string): Promise<SubsonicSong | undefined> {
    const envelope = await this.get("getSong", { id });
    return NavidromeClient.payload<SubsonicSong>(envelope, "song");
  }

  /** The `.lrc` sidecar or the LYRICS tag, as the server understood it. */
  async getLyricsBySongId(id: string): Promise<readonly SubsonicStructuredLyrics[]> {
    const envelope = await this.get("getLyricsBySongId", { id });
    const list = NavidromeClient.payload<{ structuredLyrics?: SubsonicStructuredLyrics[] }>(
      envelope,
      "lyricsList",
    );
    return list?.structuredLyrics ?? [];
  }

  /**
   * The *head* of a cover: its size and its magic number, never the bytes.
   *
   * `getCoverArt` returns an image, not JSON, so it cannot go through `get`. All the
   * verification needs is "is there a real image behind this id", and carrying a megabyte
   * through the step for that would be silly.
   */
  async getCoverArt(id: string, size = 200): Promise<CoverArtInfo> {
    this.requireConfigured();
    const url = this.urlFor("getCoverArt", { id, size });
    let response: Response;
    try {
      response = await this.doFetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw unreachable(this.baseUrl, "getCoverArt", error);
    }
    if (!response.ok) return { ok: false, bytes: 0, contentType: "", kind: "" };

    const contentType = response.headers.get("content-type") ?? "";
    // A server with nothing to show answers the JSON envelope instead of an image.
    if (contentType.includes("application/json")) {
      return { ok: false, bytes: 0, contentType, kind: "" };
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      ok: buffer.byteLength > 0,
      bytes: buffer.byteLength,
      contentType,
      kind: imageKind(buffer),
    };
  }

  /** `getAlbumList2`, the paged album list. `type` is `newest`, `alphabeticalByName`… */
  async getAlbumList2(
    options: { type?: string; size?: number; offset?: number } = {},
  ): Promise<readonly SubsonicAlbum[]> {
    const envelope = await this.get("getAlbumList2", {
      type: options.type ?? "newest",
      size: options.size ?? 50,
      offset: options.offset ?? 0,
    });
    const list = NavidromeClient.payload<{ album?: SubsonicAlbum[] }>(envelope, "albumList2");
    return list?.album ?? [];
  }

  /** What the listener starred. P09 reads it; here it proves the account is the right one. */
  async getStarred2(): Promise<{
    readonly album: readonly SubsonicAlbum[];
    readonly song: readonly SubsonicSong[];
  }> {
    const envelope = await this.get("getStarred2");
    const starred = NavidromeClient.payload<{
      album?: SubsonicAlbum[];
      song?: SubsonicSong[];
    }>(envelope, "starred2");
    return { album: starred?.album ?? [], song: starred?.song ?? [] };
  }

  async getTopSongs(artist: string, count = 20): Promise<readonly SubsonicSong[]> {
    const envelope = await this.get("getTopSongs", { artist, count });
    const top = NavidromeClient.payload<{ song?: SubsonicSong[] }>(envelope, "topSongs");
    return top?.song ?? [];
  }

  /** The one search the read-back uses: find the album we have just placed. */
  async search3(
    query: string,
    options: { albumCount?: number; songCount?: number; artistCount?: number } = {},
  ): Promise<SubsonicSearchResult> {
    const envelope = await this.get("search3", {
      query,
      albumCount: options.albumCount ?? 20,
      songCount: options.songCount ?? 0,
      artistCount: options.artistCount ?? 0,
    });
    return NavidromeClient.payload<SubsonicSearchResult>(envelope, "searchResult3") ?? {};
  }
}

/** JPEG and PNG magic numbers. Enough to tell an image from an error page. */
function imageKind(buffer: Uint8Array): string {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  return "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
