/**
 * `mm --url … --token …` — the CLI, driving a remote installation over `/api/v1`.
 *
 * `docs/phases/P08-api-agents.md`: *mêmes commandes qu'en P03 plus `inbox`, `library`,
 * `settings`, `tools`*. In-process, `mm` reaches the services directly; here it reaches the
 * same services through HTTP, and the point of the exercise is that the two produce the same
 * output — which is why the printers are shared where the shapes allow it.
 *
 * **This module imports nothing from `#/server/**`.** That is a hard requirement, not tidiness:
 * remote mode exists so that `mm` can run on a laptop that has no database, no toolbox and no
 * `DATABASE_URL`. A single import of the Drizzle client would make `mm --url …` fail on exactly
 * the machine it was written for. `bin/mm.ts` therefore reaches this file through a dynamic
 * import, before it needs any of its own.
 *
 * Configuration is resolved in the order a person would expect: an explicit flag beats the
 * environment, which beats the config file. The file is `~/.config/mm/config.toml` on every
 * platform, including Windows — `%APPDATA%` would be more native there, but a self-hosted tool
 * whose documentation says one path is easier to support than one that says two.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

export interface RemoteConfig {
  readonly url: string;
  readonly token: string;
}

export function configPath(): string {
  return join(homedir(), ".config", "mm", "config.toml");
}

/**
 * Read `url` and `token` out of the config file.
 *
 * A deliberately tiny TOML reader: `key = "value"` at the top level or under `[default]`.
 * Pulling in a TOML parser to read two strings would be the wrong trade, and the format is
 * chosen for *what a person types*, not for what a library can express. Anything more elaborate
 * in that file is ignored rather than rejected, so a future key does not break an older `mm`.
 */
export function readConfigFile(path = configPath()): Partial<RemoteConfig> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const heading = /^\[([^\]]+)\]$/.exec(trimmed);
    if (heading?.[1] !== undefined) {
      section = heading[1].trim();
      continue;
    }
    if (section !== "" && section !== "default") continue;
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(trimmed);
    const key = pair?.[1];
    const value = pair?.[2];
    if (key === undefined || value === undefined) continue;
    out[key] = value.trim().replace(/^["']|["']$/g, "");
  }
  const url = out["url"];
  const token = out["token"];
  return {
    ...(url === undefined ? {} : { url }),
    ...(token === undefined ? {} : { token }),
  };
}

/**
 * Decide whether this invocation is remote, and with what.
 *
 * Returns `null` for "run in process". A `--url` without a token is still remote — it fails
 * with a 401 that says what is missing, which is a better answer than silently running against
 * the local database the caller was trying not to use.
 */
export function resolveRemote(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined> = process.env,
  file: Partial<RemoteConfig> = readConfigFile(),
): RemoteConfig | null {
  const flag = (name: string): string | undefined =>
    typeof flags[name] === "string" ? (flags[name] as string) : undefined;

  const url = flag("url") ?? env["MM_URL"] ?? file.url;
  const token = flag("token") ?? env["MM_TOKEN"] ?? file.token;
  if (url === undefined || url.trim() === "") return null;
  return { url: url.trim().replace(/\/+$/, ""), token: (token ?? "").trim() };
}

/* ------------------------------------------------------------------ */
/* the client                                                          */
/* ------------------------------------------------------------------ */

/** The server's error body, as `MMError.toBody()` writes it. */
interface WireError {
  code: string;
  message: string;
  hint?: string;
  action?: string;
}

export class RemoteError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly action: string | undefined;
  readonly status: number;

  constructor(status: number, body: WireError) {
    super(body.message);
    this.name = "RemoteError";
    this.status = status;
    this.code = body.code;
    this.hint = body.hint;
    this.action = body.action;
  }
}

export class ApiClient {
  constructor(private readonly config: RemoteConfig) {}

  get base(): string {
    return this.config.url;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/json",
      // Both spellings are accepted by the server; `x-api-key` is sent because it cannot be
      // confused with an OAuth bearer by a proxy that rewrites `Authorization`.
      ...(this.config.token === "" ? {} : { "x-api-key": this.config.token }),
      ...extra,
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.config.url}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // A connection that never opened is not an HTTP error, and reporting it as one would
      // send people looking at their token rather than at their URL.
      throw new RemoteError(0, {
        code: "TOOLBOX_UNREACHABLE",
        message: `Could not reach ${this.config.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        hint: "Is the server running, and is --url right?",
      });
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: WireError } | null;
      throw new RemoteError(
        response.status,
        payload?.error ?? {
          code: "UNKNOWN",
          message: `${String(response.status)} ${response.statusText}`,
        },
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /**
   * Follow `GET /api/v1/events` and call `onEvent` per frame.
   *
   * Hand-rolled rather than `EventSource`, for two reasons that both matter here: the standard
   * `EventSource` cannot send headers, so it could not carry the API key at all; and it
   * reconnects on its own schedule, whereas `--follow` wants to *stop* at a terminal event.
   */
  async stream(
    query: { import?: string; since?: number },
    onEvent: (event: Record<string, unknown>) => boolean | void,
  ): Promise<void> {
    const url = new URL(`${this.config.url}/api/v1/events`);
    if (query.import !== undefined) url.searchParams.set("import", query.import);
    if (query.since !== undefined) url.searchParams.set("since", String(query.since));

    const response = await fetch(url, { headers: this.headers({ accept: "text/event-stream" }) });
    if (!response.ok || response.body === null) {
      const payload = (await response.json().catch(() => null)) as { error?: WireError } | null;
      throw new RemoteError(
        response.status,
        payload?.error ?? { code: "UNKNOWN", message: "The event stream refused to open." },
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; a partial frame stays in the buffer.
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame
            .split(/\r?\n/)
            .filter((row) => row.startsWith("data:"))
            .map((row) => row.slice(5).trim())
            .join("");
          if (data !== "") {
            try {
              if (onEvent(JSON.parse(data) as Record<string, unknown>) === true) return;
            } catch {
              // A frame that is not JSON is a comment or a heartbeat; ignore it.
            }
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
