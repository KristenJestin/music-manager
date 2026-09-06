/**
 * The cover tile: a real image when we have one, a stable gradient when we do not.
 *
 * There are only two places a picture of an album can come from before the file exists: the
 * YouTube thumbnail yt-dlp reported for the source, and the Cover Art Archive's front for a
 * MusicBrainz release. Both are plain URLs, so the tile loads them directly and keeps the
 * gradient underneath as the placeholder — which means a slow or missing image degrades to
 * exactly the tile we used to draw instead of to a hole in the layout.
 *
 * The gradient is one of the eleven of `styles.css`, chosen from the seed so it is stable, and
 * the letter in the middle is what makes two adjacent rows tellable apart at 36 px.
 */
import { useCallback, useState } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { coverIndex } from "#/lib/format.ts";

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

/** The sizes the Cover Art Archive publishes for a release front. */
export type CoverArtSize = 250 | 500 | 1200;

/**
 * The Cover Art Archive's front for a release, as a URL.
 *
 * It answers a redirect to archive.org for a release that has one and a 404 for a release that
 * does not, which is exactly the signal `<Cover>` needs: no probe request, no server round
 * trip, the browser's own load either works or falls back to the gradient.
 */
export function coverArtFront(
  mbid: string | null | undefined,
  size: CoverArtSize = 250,
): string | null {
  if (mbid === null || mbid === undefined) return null;
  const trimmed = mbid.trim();
  if (trimmed === "") return null;
  return `https://coverartarchive.org/release/${trimmed}/front-${String(size)}`;
}

export interface CoverProps extends VariantProps<typeof coverVariants> {
  /**
   * The real image: a YouTube thumbnail, a Cover Art Archive front, anything the browser can
   * load. `null` — or a URL that fails — leaves the gradient showing.
   */
  readonly src?: string | null;
  /** What the gradient is derived from — an import id, an MBID, a title. */
  readonly seed?: string | null;
  /** Shown as a tooltip, as the image's alt text, and as the initial in the middle. */
  readonly label?: string | null;
  readonly className?: string;
}

export function Cover({ src, seed, label, size, className }: CoverProps) {
  // Both keyed on the URL, so a re-render with a different image retries from scratch rather
  // than staying broken — or, worse, staying transparent over the wrong gradient.
  const [broken, setBroken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const gradient = GRADIENTS[coverIndex(seed ?? label ?? "") - 1] ?? GRADIENTS[7];
  const title = label ?? "";
  const url = src === undefined || src === null || src === "" || src === broken ? null : src;

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
      {url === null ? null : (
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
          ref={settle}
          src={url}
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
            setBroken(url);
          }}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </div>
  );
}
