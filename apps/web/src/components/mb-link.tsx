/**
 * A link to an entity on musicbrainz.org.
 *
 * Four pages were building the same `https://musicbrainz.org/<kind>/<mbid>` anchor by hand,
 * each with its own idea of how much of the id to show and whether the external-link glyph
 * got an accessible name. One component, so "how does the Console link to MusicBrainz" has a
 * single answer — and so the `not set` case, which is the common one for a library imported
 * from YouTube alone, reads the same everywhere instead of being a blank cell on one page and
 * a dash on another.
 *
 * `target="_blank"` with `rel="noreferrer"` throughout: MusicBrainz is a reference you consult
 * beside the Console, never a place you navigate away to.
 */
import { ExternalLink } from "lucide-react";
import { cn } from "cn";
import { short } from "#/lib/format.ts";

/** The entity types the Console actually links to. */
export type MbEntity = "artist" | "release" | "release-group" | "recording" | "work" | "label";

/** How the entity is named in a sentence, for the accessible name of the glyph. */
const NOUN: Readonly<Record<MbEntity, string>> = {
  artist: "artist",
  release: "release",
  "release-group": "release group",
  recording: "recording",
  work: "work",
  label: "label",
};

/** `https://musicbrainz.org/<kind>/<mbid>`, or `null` when there is no id to link to. */
export function musicBrainzUrl(kind: MbEntity, mbid: string | null | undefined): string | null {
  if (mbid === null || mbid === undefined) return null;
  const trimmed = mbid.trim();
  return trimmed === "" ? null : `https://musicbrainz.org/${kind}/${trimmed}`;
}

export interface MbLinkProps {
  readonly kind: MbEntity;
  readonly mbid: string | null | undefined;
  /**
   * What the anchor reads. Defaults to the id itself — truncated when `truncate` is set,
   * which is what a table cell wants and a detail page does not.
   */
  readonly label?: string;
  /** Show the first eight characters of the id rather than all thirty-six. */
  readonly truncate?: boolean;
  /** What to render when there is no id. A page that shows nothing has said nothing. */
  readonly missing?: string;
  readonly className?: string;
  readonly "data-testid"?: string;
  /** A row that is itself clickable needs the link to keep the click to itself. */
  readonly stopPropagation?: boolean;
}

export function MbLink({
  kind,
  mbid,
  label,
  truncate = false,
  missing = "not linked",
  className,
  "data-testid": testId,
  stopPropagation = false,
}: MbLinkProps) {
  const href = musicBrainzUrl(kind, mbid);
  if (href === null) {
    return (
      <span data-testid={testId} className={cn("font-mono text-2xs text-fg-3", className)}>
        {missing}
      </span>
    );
  }

  const id = (mbid ?? "").trim();
  const text = label ?? (truncate ? short(id) : id);

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
      data-mb-kind={kind}
      title={`Open this ${NOUN[kind]} on MusicBrainz`}
      className={cn(
        "inline-flex items-center gap-1 font-mono text-2xs text-fg-3 hover:text-primary",
        className,
      )}
      onClick={
        stopPropagation
          ? (event) => {
              event.stopPropagation();
            }
          : undefined
      }
    >
      {text}
      <ExternalLink className="size-3" aria-hidden="true" />
      <span className="sr-only">(opens musicbrainz.org in a new tab)</span>
    </a>
  );
}
