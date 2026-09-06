/**
 * MusicBrainz search queries, built and escaped.
 *
 * Ported from v1's `MusicBrainzMatcherService.cs` (`EscapeLuceneValue`,
 * `BuildReleaseGroupQuery`, `BuildReleaseQuery`, `BuildRecordingQuery`), with one correction.
 *
 * v1 escaped only `\` and `"` and then wrapped the value in quotes. That is *almost* right —
 * inside a quoted phrase Lucene only treats those two as special — but it broke on the values
 * that matter most here: an album called `AC/DC — Back in Black` or a title ending in `?` are
 * fine quoted, whereas an empty value produced a bare `""` clause that MusicBrainz answers
 * with a 400. So the escaping is kept verbatim and the *callers* drop empty clauses instead of
 * emitting them, which is the actual fix. v1 had a commented-out full special-character regex
 * it never enabled; enabling it would double-escape inside quotes and is not what we want.
 *
 * Pure string work, hence `packages/domain`: the query is part of the matching algorithm, not
 * of the HTTP client, and it is the thing a cassette's key is derived from.
 */

/**
 * Escape one value for use inside a quoted Lucene phrase, and quote it.
 *
 * Backslash first — otherwise the backslashes introduced by the quote escaping would be
 * escaped a second time.
 */
export function escapeLuceneValue(value: string | null | undefined): string {
  if (value == null || value === "") return '""';
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Join the clauses that have a value. An empty value contributes nothing at all. */
function and(clauses: readonly (string | null)[]): string {
  return clauses
    .filter((clause): clause is string => clause !== null && clause !== "")
    .join(" AND ");
}

function clause(field: string, value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  return `${field}:${escapeLuceneValue(value.trim())}`;
}

/**
 * The first search: the release *group*, i.e. the album as a work rather than as a pressing.
 *
 * No type filter, exactly as v1 decided ("Do NOT filter by primarytype initially for broader
 * search") — a record filed as an EP is still the record the playlist came from, and excluding
 * it here would mean never seeing it at all.
 */
export function releaseGroupQuery(album: string, artist: string | null | undefined): string {
  return and([clause("releasegroup", album), clause("artist", artist)]);
}

/**
 * The second search: the releases of that group, or a direct release search when the group
 * search found nothing.
 *
 * `status:Official` is appended unquoted and uncapitalised-as-written, as v1 did: MusicBrainz
 * treats it as an enum term, and quoting it makes the clause match nothing.
 */
export function releaseQuery(options: {
  readonly album: string;
  readonly artist?: string | null;
  readonly releaseGroupId?: string | null;
  readonly year?: number | null;
  readonly disambiguation?: string | null;
  readonly officialOnly?: boolean;
}): string {
  const parts: (string | null)[] = [];
  if (options.releaseGroupId != null && options.releaseGroupId !== "") {
    // An MBID is already a safe token: quoting it would make Lucene look for a phrase.
    parts.push(`rgid:${options.releaseGroupId}`);
  } else {
    parts.push(clause("release", options.album));
    parts.push(clause("artist", options.artist));
  }
  if (options.officialOnly !== false) parts.push("status:Official");
  if (options.year != null && options.year > 1800) parts.push(`date:${String(options.year)}`);
  parts.push(clause("comment", options.disambiguation));
  return and(parts);
}

/**
 * The recording search for a lone video.
 *
 * The duration window is v1's: ±5 s in milliseconds, lower bound clamped at zero. It is wider
 * than the ±2 s the scorer calls a match on purpose — this one is a *filter*, and a filter
 * that is as tight as the scorer can only ever hide the candidate you needed to see rejected.
 */
export const RECORDING_DURATION_WINDOW_MS = 5000;

export function recordingQuery(options: {
  readonly title: string;
  readonly artist?: string | null;
  readonly releaseId?: string | null;
  readonly releaseGroupId?: string | null;
  readonly durationSeconds?: number | null;
}): string {
  const parts: (string | null)[] = [
    clause("recording", options.title),
    clause("artist", options.artist),
  ];

  // `reid` takes priority over `rgid`, never both — as v1's strict if/else if had it.
  if (options.releaseId != null && options.releaseId !== "")
    parts.push(`reid:${options.releaseId}`);
  else if (options.releaseGroupId != null && options.releaseGroupId !== "") {
    parts.push(`rgid:${options.releaseGroupId}`);
  }

  if (options.durationSeconds != null && options.durationSeconds > 0) {
    const ms = Math.trunc(options.durationSeconds * 1000);
    const low = Math.max(0, ms - RECORDING_DURATION_WINDOW_MS);
    const high = ms + RECORDING_DURATION_WINDOW_MS;
    parts.push(`dur:[${String(low)} TO ${String(high)}]`);
  }

  return and(parts);
}
