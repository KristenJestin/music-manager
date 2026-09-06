/**
 * The cover placeholder.
 *
 * P07 downloads real artwork; until then every release, job and Inbox item is drawn as one of
 * the eleven gradients of `styles.css`, chosen from its id so it is stable. The letter in the
 * middle is what actually makes two adjacent rows tellable apart at 36 px.
 */
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

export interface CoverProps extends VariantProps<typeof coverVariants> {
  /** What the gradient is derived from — an import id, an MBID, a title. */
  readonly seed?: string | null;
  /** Shown as a tooltip and as the initial in the middle. */
  readonly label?: string | null;
  readonly className?: string;
}

export function Cover({ seed, label, size, className }: CoverProps) {
  const gradient = GRADIENTS[coverIndex(seed ?? label ?? "") - 1] ?? GRADIENTS[7];
  const title = label ?? "";
  return (
    <div
      data-slot="cover"
      className={cn(coverVariants({ size }), gradient, className)}
      title={title}
      aria-hidden={title === "" ? true : undefined}
    >
      <span className="font-bold text-white/55 mix-blend-overlay">
        {title.slice(0, 1).toUpperCase()}
      </span>
    </div>
  );
}
