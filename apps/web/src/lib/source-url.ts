/**
 * Where an album came from, said as one openable link.
 *
 * An album's provenance is recorded twice and neither record is the whole answer:
 *
 *  - `imports.url` is **what was submitted** — for an album that is normally the YouTube Music
 *    playlist (`…/playlist?list=OLAK5uy_…`), which is the link somebody actually wants back;
 *  - `import_tracks.raw.webpage_url` is the yt-dlp entry for **one video**, which is all there
 *    is when a single was imported on its own, and all there is when the submitted URL is not
 *    a web address at all (`fixture://discovery` in fixtures mode).
 *
 * So the rule is: prefer the submitted URL when it is a playlist, fall back to the video.
 * Nothing is invented — a row that knows neither produces no link rather than a guess.
 *
 * Pure and in `lib/`, because the album page renders it and the service that reads the rows
 * needs the same judgement; a second copy would be the one that forgets `OLAK5uy_`.
 */

/** Which of the two provenance records the link came from. */
export type SourceUrlKind = "playlist" | "video";

export interface AlbumSourceLink {
  readonly url: string;
  readonly kind: SourceUrlKind;
  /** Plain English, for the button: never a bare URL and never the word "provenance". */
  readonly label: string;
}

/** `http:` or `https:` — `fixture://` and friends are provenance, not destinations. */
export function isWebUrl(url: string | null | undefined): boolean {
  if (url === null || url === undefined || url === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True when this URL addresses a **list** of videos rather than one.
 *
 * `list=` is YouTube's own parameter and covers `youtube.com/playlist?list=…`,
 * `music.youtube.com/playlist?list=…` and a watch URL opened inside a playlist alike.
 * `OLAK5uy_` is the prefix of the auto-generated YouTube Music album playlists this
 * application is mostly pointed at, and it is checked on the whole string so a bare id — which
 * is what the v1 database sometimes stored — is still recognised.
 */
export function isPlaylistUrl(url: string | null | undefined): boolean {
  if (url === null || url === undefined || url === "") return false;
  if (url.includes("OLAK5uy_")) return true;
  try {
    return new URL(url).searchParams.has("list");
  } catch {
    return false;
  }
}

/** The `webpage_url` of a yt-dlp entry, from `import_tracks.raw`. */
export function webpageUrlOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const url = (raw as { webpage_url?: unknown }).webpage_url;
  return typeof url === "string" && url !== "" ? url : null;
}

/**
 * The one link an album's page offers back to where the audio came from.
 *
 * `submitted` is `imports.url`; `entryUrls` are the `webpage_url`s of that import's tracks, in
 * track order. The first playable video wins the fallback, because the first track of an album
 * is the entry point a person expects.
 *
 * The migrated-from-v1 case falls out of the same two rules rather than needing a third: the
 * migration fabricates `raw` from the v1 row, and its `webpage_url` is the real
 * `Songs.SourceUrl` of that song, while `imports.url` is the v1 `SourceUrlParent` — a genuine
 * `…/playlist?list=OLAK5uy_…` when v1 recorded one. A v1 album with no parent therefore links
 * to its first video, which is exactly what v1 itself knew.
 */
export function albumSourceLink(
  submitted: string | null | undefined,
  entryUrls: readonly (string | null | undefined)[],
): AlbumSourceLink | null {
  if (isWebUrl(submitted) && isPlaylistUrl(submitted)) {
    return {
      url: submitted as string,
      kind: "playlist",
      label: "Open the source playlist on YouTube",
    };
  }
  const video = entryUrls.find((url) => isWebUrl(url));
  if (video !== undefined && video !== null) {
    return { url: video, kind: "video", label: "Open the source video on YouTube" };
  }
  // No playlist, no video — but the submitted URL may still be a plain web address (a channel,
  // a watch URL for a single). It is better than nothing and it is what was typed.
  if (isWebUrl(submitted)) {
    return { url: submitted as string, kind: "video", label: "Open the source on YouTube" };
  }
  return null;
}
