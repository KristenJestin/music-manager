/**
 * Cover Art Archive → the embedded pictures (`docs/03-metadonnees.md` §2.6, §3).
 *
 * The index lists every image of a release with its types and its thumbnails. We embed the
 * front cover, and the back cover when there is one; the booklet and the medium scans go to
 * sidecars in P02, from the same index.
 *
 * A 404 on the whole index is frequent (§4) — the caller then falls back to the cropped
 * YouTube thumbnail and never calls this resolver.
 */

import type { DocumentPatch, EmbeddedPicture } from "../document.ts";
import { PatchBuilder } from "./patch.ts";

export interface CaaThumbnails {
  readonly "250"?: string;
  readonly "500"?: string;
  readonly "1200"?: string;
  readonly small?: string;
  readonly large?: string;
}

export interface CaaImage {
  readonly id?: number | string;
  readonly image?: string;
  readonly types?: readonly string[];
  readonly front?: boolean;
  readonly back?: boolean;
  readonly approved?: boolean;
  readonly comment?: string;
  readonly thumbnails?: CaaThumbnails;
}

export interface CaaIndex {
  readonly release?: string;
  readonly images?: readonly CaaImage[];
}

/** §3 asks for 1200 px images; fall back to the largest thumbnail, then to the original. */
function bestUrl(image: CaaImage): string | null {
  return image.thumbnails?.["1200"] ?? image.thumbnails?.large ?? image.image ?? null;
}

function mimeTypeOf(url: string): string {
  return url.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

/**
 * Which rung of the §4 ladder this index was fetched from (decision 168).
 *
 * The archive answers the same shape for a release, for a release group, and for a *sibling*
 * release of that group — so the index alone cannot say which question was asked, and the
 * field's `source` says `coverartarchive` for all three. The caller knows, and passes it here
 * to be written into the picture's `provenance`.
 */
export interface CoverArtOrigin {
  readonly rung: "release" | "release-group" | "sibling-release";
  /** The MBID actually asked about. */
  readonly mbid?: string;
}

/** The one clause a card, `get_album` or a report prints to say where the cover came from. */
export function describeCoverArtOrigin(origin: CoverArtOrigin | undefined): string {
  if (origin === undefined) return "Cover Art Archive";
  const id = origin.mbid === undefined || origin.mbid === "" ? "" : ` (${origin.mbid})`;
  if (origin.rung === "release-group") return `Cover Art Archive · release group${id}`;
  if (origin.rung === "sibling-release") {
    return `Cover Art Archive · another release of the group${id}`;
  }
  return `Cover Art Archive · this release${id}`;
}

export function fromCoverArtArchiveIndex(
  index: CaaIndex,
  options: { fetchedAt: string; origin?: CoverArtOrigin },
): DocumentPatch {
  const patch = new PatchBuilder("coverartarchive", options.fetchedAt);
  const images = (index.images ?? []).filter((image) => image.approved !== false);
  const provenance = describeCoverArtOrigin(options.origin);

  const front = images.find(
    (image) => image.front === true || (image.types ?? []).includes("Front"),
  );
  const back = images.find((image) => image.back === true || (image.types ?? []).includes("Back"));

  patch.setOrNa(
    "front_cover",
    pictureOf(front, "front", provenance),
    "the Cover Art Archive has no front cover",
  );
  patch.setOrNa(
    "back_cover",
    pictureOf(back, "back", provenance),
    "the Cover Art Archive has no back cover",
  );

  return patch.build();
}

function pictureOf(
  image: CaaImage | undefined,
  kind: "front" | "back",
  provenance: string,
): readonly EmbeddedPicture[] | null {
  if (image === undefined) return null;
  const url = bestUrl(image);
  if (url === null) return null;
  const comment = image.comment;
  return [
    comment === undefined || comment === ""
      ? { kind, mimeType: mimeTypeOf(url), url, provenance }
      : { kind, mimeType: mimeTypeOf(url), url, comment, provenance },
  ];
}
