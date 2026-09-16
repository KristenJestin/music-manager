/**
 * An MBID, rendered as a link to the entity on musicbrainz.org.
 *
 * Every identifier the Console shows is worth one click: "is this really the release I think it
 * is" is a question only MusicBrainz can answer, and retyping a UUID into the address bar is the
 * kind of friction that stops people checking at all.
 *
 * `kind` is the path segment MusicBrainz uses — `recording`, `release`, `release-group`,
 * `artist`, `track`. A missing id renders as plain text rather than a dead link.
 */
import { ExternalLink } from "lucide-react";

export type MbKind = "recording" | "release" | "release-group" | "artist" | "track" | "work";

export function MbLink({
  kind,
  mbid,
  label,
}: {
  readonly kind: MbKind;
  readonly mbid: string | null | undefined;
  /** Shown instead of the raw id when the caller has a name for it. */
  readonly label?: string;
}): React.JSX.Element {
  if (mbid === null || mbid === undefined || mbid === "") {
    return <span className="text-fg-3">not set</span>;
  }
  return (
    <a
      href={`https://musicbrainz.org/${kind}/${mbid}`}
      target="_blank"
      rel="noreferrer"
      title={`Open this ${kind.replace("-", " ")} on MusicBrainz`}
      className="inline-flex items-center gap-1 font-mono text-2xs hover:text-primary"
    >
      {label ?? mbid}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}
