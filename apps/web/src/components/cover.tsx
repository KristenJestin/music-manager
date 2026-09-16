/**
 * The cover tile: a real image when we have one, a stable gradient when we do not.
 *
 * A picture of an album can come from three places, and the tile takes them as an **ordered
 * list**: the `cover.jpg` actually placed beside the audio files (served by `/api/cover`), the
 * Cover Art Archive's front for the MusicBrainz release, and the YouTube thumbnail yt-dlp
 * reported for the source. All three are plain URLs, so the tile loads them directly, moves to
 * the next one when the browser says a load failed, and keeps the gradient underneath as the
 * placeholder — which means a slow or missing image degrades to exactly the tile we used to
 * draw instead of to a hole in the layout.
 *
 * Falling forward through candidates rather than probing them server-side is the same trade
 * `coverArtFront` already made: a 404 is the answer, the browser asks for it anyway, and no
 * page has to wait on a round trip to decide what to render.
 *
 * The gradient is one of the eleven of `styles.css`, chosen from the seed so it is stable, and
 * the letter in the middle is what makes two adjacent rows tellable apart at 36 px.
 *
 * **Which size is fetched is decided in `#/lib/cover-sources.ts`**, by the same `slot` name as
 * this component's `size` prop — `albumCoverSources(album, "sm")` under `<Cover size="sm">`.
 * That module is pure and has no React in it, so the server's player queue uses it too. The
 * builders are re-exported here because every screen already imports them from this path.
 */
import { useCallback, useState } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { coverCandidate, type CoverSource } from "#/lib/cover-sources.ts";
import { coverIndex } from "#/lib/format.ts";

export {
  albumCoverSources,
  artistImageSources,
  coverArtFront,
  libraryArtistImage,
  libraryCover,
  remoteImageAtWidth,
  SLOT_SIZES,
  type AlbumCoverSource,
  type ArtistImageSource,
  type CoverArtSize,
  type CoverCandidate,
  type CoverSlot,
  type CoverSource,
  type LibraryImageSize,
} from "#/lib/cover-sources.ts";

const coverVariants = cva(
  "relative grid aspect-square shrink-0 place-items-center overflow-hidden rounded-sm",
  {
    variants: {
      size: {
        xs: "w-6 text-3xs",
        sm: "w-9 text-2xs",
        md: "w-14 text-lg",
        lg: "w-24 text-3xl",
        xl: "w-40 text-5xl",
        full: "w-full rounded-md text-4xl",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

/**
 * Tailwind must see these class names written out to emit them, so the gradients are a
 * lookup table rather than a template string.
 */
const GRADIENTS = [
  "bg-cover-1",
  "bg-cover-2",
  "bg-cover-3",
  "bg-cover-4",
  "bg-cover-5",
  "bg-cover-6",
  "bg-cover-7",
  "bg-cover-8",
  "bg-cover-9",
  "bg-cover-10",
  "bg-cover-11",
] as const;

export interface CoverProps extends VariantProps<typeof coverVariants> {
  /**
   * The real image, or several to try in order: the placed `cover.jpg`, a Cover Art Archive
   * front, a YouTube thumbnail — anything the browser can load. Each URL that fails hands over
   * to the next; `null`, an empty list, or a list that is exhausted leaves the gradient showing.
   *
   * An entry may be a `CoverCandidate` instead of a string when the same picture exists at
   * several widths, and then its `srcSet`/`sizes` go on the `<img>` and the browser chooses —
   * which is how the album grid gets a tile sized for the breakpoint *and* the pixel ratio it
   * is actually being drawn at.
   */
  readonly src?: string | null | readonly (CoverSource | null | undefined)[];
  /** What the gradient is derived from — an import id, an MBID, a title. */
  readonly seed?: string | null;
  /** Shown as a tooltip, as the image's alt text, and as the initial in the middle. */
  readonly label?: string | null;
  readonly className?: string;
}

export function Cover({ src, seed, label, size, className }: CoverProps) {
  // `broken` accumulates the URLs the browser refused, so the tile walks down its candidates
  // once and never re-tries one it has already been told about. `loaded` is keyed on the URL,
  // so a re-render pointing at another image starts from scratch rather than claiming pixels
  // that belong to the previous one.
  const [broken, setBroken] = useState<readonly string[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const gradient = GRADIENTS[coverIndex(seed ?? label ?? "") - 1] ?? GRADIENTS[7];
  const title = label ?? "";

  const given: readonly (CoverSource | null | undefined)[] =
    typeof src === "string" ? [src] : (src ?? []);
  const candidate =
    given
      .filter((entry): entry is CoverSource => entry !== null && entry !== undefined)
      .map(coverCandidate)
      .find((entry) => entry.url !== "" && !broken.includes(entry.url)) ?? null;
  const url = candidate?.url ?? null;

  /**
   * React never replays a `load` or an `error` that fired before hydration (owner review
   * B10): a server-rendered page whose image is already in the browser cache finishes it
   * during the HTML parse, so `onLoad` is simply never called and the tile used to stay
   * `opacity-0` for ever — the real cover loaded, and invisible. An image element already
   * carries the answer, so the mount reads it out of the DOM instead of waiting for an event
   * that has been and gone: a non-zero `naturalWidth` on a `complete` image means those
   * pixels are decoded and on screen.
   *
   * Only the *positive* half is read here. `complete` with a zero `naturalWidth` is
   * ambiguous — it is a 404 in a browser and a plain "this DOM never loads images" in the
   * test environments — and a missed failure now costs nothing, because a failed image with
   * an empty `alt` represents nothing and the gradient is already underneath it.
   *
   * The ref is keyed on the URL, so pointing the tile at another image re-runs the check.
   */
  const settle = useCallback(
    (node: HTMLImageElement | null) => {
      if (node === null || url === null) return;
      if (node.complete && node.naturalWidth > 0) setLoaded(url);
    },
    [url],
  );

  return (
    <div
      data-slot="cover"
      data-has-image={loaded !== null && loaded === url ? true : undefined}
      className={cn(coverVariants({ size }), gradient, className)}
      title={title}
      aria-hidden={title === "" ? true : undefined}
    >
      <span className="font-bold text-white/55 mix-blend-overlay">
        {title.slice(0, 1).toUpperCase()}
      </span>
      {candidate === null || url === null ? null : (
        /*
         * No `alt`, and no opacity that depends on a React state.
         *
         * A cover is decoration over a tile that already reads: the wrapper carries the title,
         * and an `alt` here would put the album's name *inside* the 36 px square as soon as the
         * image 404s — which is precisely what a YouTube thumbnail URL from a fixture, or a
         * release the Cover Art Archive has never had a front for, does. With an empty `alt`
         * the HTML specification already says a failed image represents *nothing*, and an
         * image still in flight paints nothing either, so the gradient underneath is the
         * placeholder on its own. Hiding the element until a state said otherwise bought no
         * pixel, and cost the whole tile whenever that state never arrived.
         */
        <img
          // A fresh element per candidate: reusing the node would carry the previous URL's
          // `complete` flag into the ref callback below and vouch for pixels that never came.
          key={url}
          ref={settle}
          src={url}
          srcSet={candidate.srcSet}
          sizes={candidate.sizes}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          data-testid="cover-image"
          data-loaded={loaded === url ? true : undefined}
          onLoad={() => {
            setLoaded(url);
          }}
          onError={() => {
            setBroken((seen) => (seen.includes(url) ? seen : [...seen, url]));
          }}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </div>
  );
}
