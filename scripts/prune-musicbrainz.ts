/**
 * Reduce a MusicBrainz payload to the fields the **matcher** reads.
 *
 * A full release lookup with P04's `inc=` list is enormous — every track carries its
 * recording's producer, composer and performer relations, its genres, its tags and its
 * aliases, because the *document builder* needs all of that. The matcher does not: it reads a
 * title, a date, a country, a status, a format, a label, a release group, and a tracklist of
 * (position, title, length, recording id). Recording the rest costs about thirty megabytes
 * across four scenarios and buys nothing a test asserts.
 *
 * So the cassettes are pruned, and — this is the part that matters — they are therefore **not
 * a general-purpose MusicBrainz fixture**. They are never seeded into the raw cache, because a
 * release with its relations amputated would make P04's document build quietly produce a worse
 * document. The document side has recorded sources of its own, under
 * `apps/web/test/cassettes/musicbrainz.json`.
 *
 * Pruning is by allow-list rather than deny-list: a field the matcher starts reading has to be
 * added here, which is a re-record and a review, rather than silently working because it
 * happened to survive.
 */

/** The keys of a release the matcher and the Console's candidate table read. */
const RELEASE_KEYS = [
  "id",
  "title",
  "disambiguation",
  "date",
  "country",
  "status",
  "barcode",
  "score",
  "packaging",
  "quality",
] as const;

const RECORDING_KEYS = ["id", "title", "disambiguation", "length", "video", "score"] as const;

const GROUP_KEYS = [
  "id",
  "title",
  "primary-type",
  "secondary-types",
  "first-release-date",
  "disambiguation",
] as const;

type Json = Record<string, unknown>;

function pick(source: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** An artist credit, with just enough to rebuild the credited name and keep the MBIDs. */
function pruneCredit(credit: unknown): Json[] {
  return asArray(credit).map((entry) => ({
    ...pick(entry, ["name", "joinphrase"]),
    ...(isObject(entry["artist"])
      ? { artist: pick(entry["artist"], ["id", "name", "sort-name", "disambiguation"]) }
      : {}),
  }));
}

function pruneLabelInfo(info: unknown): Json[] {
  return asArray(info).map((entry) => ({
    ...pick(entry, ["catalog-number"]),
    ...(isObject(entry["label"]) ? { label: pick(entry["label"], ["id", "name"]) } : {}),
  }));
}

function pruneGroup(group: unknown): Json | undefined {
  if (!isObject(group)) return undefined;
  return {
    ...pick(group, GROUP_KEYS),
    ...(group["artist-credit"] === undefined
      ? {}
      : { "artist-credit": pruneCredit(group["artist-credit"]) }),
  };
}

/** One track: the position, the title, the length, and which recording it is. */
function pruneTrack(track: Json): Json {
  const recording = track["recording"];
  return {
    ...pick(track, ["id", "position", "number", "title", "length"]),
    ...(track["artist-credit"] === undefined
      ? {}
      : { "artist-credit": pruneCredit(track["artist-credit"]) }),
    ...(isObject(recording)
      ? {
          recording: {
            ...pick(recording, [...RECORDING_KEYS, "isrcs", "first-release-date"]),
            ...(recording["artist-credit"] === undefined
              ? {}
              : { "artist-credit": pruneCredit(recording["artist-credit"]) }),
          },
        }
      : {}),
  };
}

function pruneMedia(media: unknown): Json[] {
  return asArray(media).map((medium) => ({
    ...pick(medium, ["position", "format", "title", "track-count", "track-offset"]),
    ...(medium["tracks"] === undefined
      ? {}
      : { tracks: asArray(medium["tracks"]).map(pruneTrack) }),
  }));
}

export function pruneRelease(release: Json): Json {
  return {
    ...pick(release, RELEASE_KEYS),
    ...(release["artist-credit"] === undefined
      ? {}
      : { "artist-credit": pruneCredit(release["artist-credit"]) }),
    ...(release["label-info"] === undefined
      ? {}
      : { "label-info": pruneLabelInfo(release["label-info"]) }),
    ...(pruneGroup(release["release-group"]) === undefined
      ? {}
      : { "release-group": pruneGroup(release["release-group"]) }),
    ...(release["media"] === undefined ? {} : { media: pruneMedia(release["media"]) }),
  };
}

export function pruneRecording(recording: Json): Json {
  return {
    ...pick(recording, [...RECORDING_KEYS, "isrcs", "first-release-date"]),
    ...(recording["artist-credit"] === undefined
      ? {}
      : { "artist-credit": pruneCredit(recording["artist-credit"]) }),
    ...(recording["releases"] === undefined
      ? {}
      : { releases: asArray(recording["releases"]).map(pruneRelease) }),
  };
}

/** A search result, or a lookup, whichever this is. */
export function prune(payload: unknown): unknown {
  if (!isObject(payload)) return payload;

  // A lookup: it has an `id` and no result array.
  if (typeof payload["id"] === "string" && payload["releases"] === undefined) {
    return payload["media"] !== undefined || payload["release-group"] !== undefined
      ? pruneRelease(payload)
      : pruneRecording(payload);
  }
  if (typeof payload["id"] === "string") return pruneRecording(payload);

  const out: Json = pick(payload, ["created", "count", "offset"]);
  if (payload["releases"] !== undefined) {
    out["releases"] = asArray(payload["releases"]).map(pruneRelease);
  }
  if (payload["recordings"] !== undefined) {
    out["recordings"] = asArray(payload["recordings"]).map(pruneRecording);
  }
  if (payload["release-groups"] !== undefined) {
    out["release-groups"] = asArray(payload["release-groups"]).map(
      (group) => pruneGroup(group) ?? {},
    );
  }
  return out;
}
