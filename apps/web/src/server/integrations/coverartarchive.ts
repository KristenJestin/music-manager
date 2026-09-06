/**
 * Cover Art Archive (`docs/03-metadonnees.md` §3, §4).
 *
 * "404 fréquents" is the whole design note: a release with no cover art is the normal case,
 * not an error, so the index is fetched with `nullOn404` and the absence is *cached*. The
 * caller then falls back to the YouTube thumbnail, cropped square by the toolbox, which is
 * the fallback §4 names.
 *
 * The bytes never travel through this module. `POST /artwork/prepare` in the toolbox fetches
 * the image, crops it to a square and re-encodes it — it owns Pillow, we own the URLs — and
 * the prepared JPEG is cached under `artwork` so fourteen tracks embedding one cover cost one
 * download, which is exactly what P03 already did for the fixture.
 */
import { MMError } from "@mm/contracts";
import type { CaaImage, CaaIndex } from "@mm/domain";

import type { ToolboxClient } from "#/server/toolbox/client.ts";
import { cached, optionsFor, type CachedValue } from "./cached.ts";
import type { SourceContext } from "./config.ts";
import { getJson } from "./http.ts";

export const CAA_BASE = "https://coverartarchive.org";

/** The sizes the archive publishes as thumbnails. */
export type CoverSize = 250 | 500 | 1200 | "original";

/** The full image index of a release, or `null` when the archive has nothing. */
export async function index(
  ctx: SourceContext,
  releaseMbid: string,
): Promise<CachedValue<CaaIndex | null>> {
  return await cached<CaaIndex>(
    "coverartarchive",
    `release/${releaseMbid}`,
    async () => {
      const answer = await getJson<CaaIndex>({
        source: "coverartarchive",
        url: `${CAA_BASE}/release/${releaseMbid}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.coverartarchive),
  );
}

/** The same, for a release group — the archive falls back to the group's chosen cover. */
export async function releaseGroupIndex(
  ctx: SourceContext,
  releaseGroupMbid: string,
): Promise<CachedValue<CaaIndex | null>> {
  return await cached<CaaIndex>(
    "coverartarchive",
    `release-group/${releaseGroupMbid}`,
    async () => {
      const answer = await getJson<CaaIndex>({
        source: "coverartarchive",
        url: `${CAA_BASE}/release-group/${releaseGroupMbid}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.coverartarchive),
  );
}

function isFront(image: CaaImage): boolean {
  return image.front === true || (image.types ?? []).includes("Front");
}

function isOfType(image: CaaImage, type: string): boolean {
  if (type === "Front") return isFront(image);
  if (type === "Back") return image.back === true || (image.types ?? []).includes("Back");
  return (image.types ?? []).includes(type);
}

/**
 * The URL of one image at one size. `original` is the uploaded file; the thumbnails are what
 * §3 asks for (1200 px), and the archive does not always have every size — hence the descent.
 */
export function urlOf(image: CaaImage, size: CoverSize): string | null {
  if (size === "original") return image.image ?? null;
  const thumbnails = image.thumbnails ?? {};
  if (size === 1200) return thumbnails["1200"] ?? thumbnails.large ?? image.image ?? null;
  if (size === 500) return thumbnails["500"] ?? thumbnails.large ?? image.image ?? null;
  return thumbnails["250"] ?? thumbnails.small ?? image.image ?? null;
}

/** The front cover's URL at `size`, or `null` when the release has no approved front. */
export function frontUrl(caa: CaaIndex | null, size: CoverSize = 1200): string | null {
  if (caa === null) return null;
  const front = (caa.images ?? []).filter((image) => image.approved !== false).find(isFront);
  return front === undefined ? null : urlOf(front, size);
}

/** Every image of one type, in the archive's own order. Used for the §3 sidecars. */
export function imagesOfType(caa: CaaIndex | null, type: string): readonly CaaImage[] {
  if (caa === null) return [];
  return (caa.images ?? []).filter((image) => image.approved !== false && isOfType(image, type));
}

export interface PreparedArtwork {
  readonly data_base64: string;
  readonly mime: string;
}

/**
 * Fetch, crop and re-encode one image through the toolbox, once per (url, size).
 *
 * Cached under the `artwork` source with the same key P03's `tag` step used, so wiring the
 * step to this module costs no re-downloads of covers already prepared.
 */
export async function download(
  ctx: SourceContext,
  toolbox: ToolboxClient,
  url: string,
  size = ctx.config.artworkSize,
): Promise<PreparedArtwork> {
  const entry = await cached<PreparedArtwork>(
    "artwork",
    `${url}#${String(size)}`,
    async () => {
      const prepared = await toolbox.prepareArtwork({ url, size });
      const bytes = Math.floor((prepared.data_base64.length * 3) / 4);
      if (ctx.config.coverMaxBytes > 0 && bytes > ctx.config.coverMaxBytes) {
        throw new MMError(
          "COVER_TOO_LARGE",
          `The prepared cover is ${String(bytes)} bytes, over the ${String(ctx.config.coverMaxBytes)} limit.`,
          { hint: "Lower `artworkSize`, or raise `coverMaxBytes`.", action: "Adjust the setting" },
        );
      }
      return { data_base64: prepared.data_base64, mime: prepared.mime };
    },
    // Prepared artwork never expires: it is the output of a deterministic crop of an image
    // the archive does not edit in place. A `--refresh` still overwrites it.
    optionsFor(ctx, 0),
  );
  if (entry.data === null) {
    throw new MMError("COVER_UNAVAILABLE", `No artwork could be prepared for ${url}.`);
  }
  return entry.data;
}
