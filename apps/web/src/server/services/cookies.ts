/**
 * The YouTube cookie jar: one function that says what a yt-dlp call should authenticate with.
 *
 * Three modes, because a path is only convenient on a laptop. On a real server the operator
 * has a browser export in the clipboard and no way to put a file inside the toolbox
 * container, so `paste` stores the jar in the settings and the toolbox writes it to a private
 * temporary file for the duration of each call (owner review B6, decision 072).
 *
 * Nothing here logs, returns or formats the jar's *contents* except into the object handed
 * straight to the toolbox client. `describe()` is what anything human-facing may use.
 */
import type { Settings } from "#/server/services/settings.ts";

/** What a yt-dlp call needs, in the two shapes the toolbox understands. */
export interface CookieJar {
  /** A path the **toolbox container** can read. */
  readonly path?: string;
  /** A Netscape `cookies.txt`, inline. Wins over `path` on the toolbox side. */
  readonly content?: string;
}

export type CookiesMode = Settings["cookiesMode"];

/** The jar for this installation, or `{}` when it runs anonymously. */
export function cookieJar(settings: Settings): CookieJar {
  if (settings.cookiesMode === "file") {
    const path = settings.cookiesFile.trim();
    return path === "" ? {} : { path };
  }
  if (settings.cookiesMode === "paste") {
    const content = settings.cookiesText.trim();
    return content === "" ? {} : { content: settings.cookiesText };
  }
  return {};
}

/** True when the mode asks for a jar that has not been provided. */
export function isMisconfigured(settings: Settings): boolean {
  if (settings.cookiesMode === "anonymous") return false;
  const jar = cookieJar(settings);
  return jar.path === undefined && jar.content === undefined;
}

/**
 * One line about the jar, safe to print anywhere. Never the cookies themselves.
 *
 * A pasted jar is described by its size only: a `cookies.txt` line *is* a credential, so the
 * rule of `CLAUDE.md` — no secret in a log, a commit or the chat — applies to every one of
 * them, and the Console has `/cookies/test` when it wants to know more.
 */
export function describe(settings: Settings): string {
  switch (settings.cookiesMode) {
    case "anonymous":
      return "anonymous: no session";
    case "file":
      return settings.cookiesFile.trim() === ""
        ? "cookies.txt: no path configured"
        : `cookies.txt: ${settings.cookiesFile}`;
    case "paste": {
      const lines = settings.cookiesText.split("\n").filter((line) => line.trim() !== "").length;
      return lines === 0 ? "pasted jar: empty" : `pasted jar: ${String(lines)} line(s)`;
    }
  }
}
