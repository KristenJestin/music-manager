/**
 * What a pasted MusicBrainz reference actually **is**, and what this import can do with it.
 *
 * ## The complaint
 *
 * The wizard's box on a single read *"Search recordings, or paste a recording MBID…"*, and it
 * meant it. The owner pasted `966e9be9-…` — the id from the album page he had just been
 * looking at — and got **"No MusicBrainz recording with id 966e9be9-…"**. That id is a
 * perfectly good *release*. The feature worked exactly as specified and the specification was
 * the bug: a box that accepts one entity type, when the id somebody has in the clipboard is
 * whichever one the page they came from happened to be about.
 *
 * ## The rule
 *
 * Look it up **before** refusing. One extra request through the one-per-second gate is cheap
 * next to a person retyping, and it turns the worst sentence available — "that id is wrong",
 * when the id is right — into the useful one: *"that is a release, not a recording. Use it to
 * pin this import?"* with a button that does it.
 *
 * ## The two halves
 *
 * `parseMbRef` in `@mm/domain` reads the string: a bare id, a musicbrainz.org address with or
 * without scheme, host, query, fragment or trailing segment, the beta host, the web service
 * URL. It is pure and it claims nothing it cannot prove — a bare id carries no entity, and a
 * URL's own word is a *hint* that orders the lookups rather than an answer.
 *
 * This file is the other half: it asks MusicBrainz which of the five entities the id names,
 * and then answers the only question the caller has — **what happens if I press the button?**
 * That depends on the import: a release id on a single is "find your video's track on it", the
 * same id on an album is "pin it", and neither is a refusal.
 */
import {
  creditName,
  flattenTracks,
  titleSimilarity,
  type MbArtist,
  type MbRelease,
  type MbReleaseGroup,
  type MbRecording,
  type MbWork,
  type MbEntityName,
  type MbRef,
} from "@mm/domain";
import { parseMbRef, MB_ENTITY_NOUN } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import type { Import } from "#/server/db/schema/index.ts";
import {
  lookupArtist,
  lookupRecording,
  lookupRelease,
  lookupReleaseGroup,
  lookupWork,
} from "#/server/integrations/musicbrainz.ts";
import { sourceContextFor } from "#/server/services/matching.context.ts";
import { cassetteNameOf } from "#/server/services/matching.cassettes.ts";
import { gatewayForUrl } from "#/server/services/matching.queries.ts";

/** What the Console can do with a reference, for the import it was pasted on. */
export type RefAction =
  | "use-recording"
  | "track-of-release"
  | "pin-release"
  | "editions-of-group"
  | "search-artist"
  | "none";

export interface ResolvedRef {
  readonly mbid: string;
  /** What MusicBrainz says it is. `null` when none of the five lookups knows it. */
  readonly entity: MbEntityName | null;
  /** The entity as a noun, for a sentence: "That is a **release group**." */
  readonly noun: string | null;
  readonly title: string | null;
  readonly artist: string | null;
  /** Seconds, for a recording. */
  readonly lengthSeconds: number | null;
  readonly year: number | null;
  /** Tracks on a release, or releases in a group. */
  readonly count: number | null;
  /** Extra words MusicBrainz adds to tell two identical titles apart. */
  readonly disambiguation: string | null;
  readonly action: RefAction;
  /** What the button says. Always an action, never a noun. */
  readonly actionLabel: string | null;
  /**
   * Why this is what happens — one sentence, shown under the preview.
   *
   * It carries the conversion offer too: on a single, a pasted release reads "That is a
   * release, not a recording. Its tracklist will be matched against your video." The person
   * then knows what pressing the button does *before* pressing it.
   */
  readonly explanation: string;
  /**
   * The id the action applies to, which is **not** always the one pasted.
   *
   * A release pasted on a single resolves to one of its recordings; a recording pasted on an
   * album resolves to a release it appears on. Carrying the target explicitly is what lets the
   * button name what it will do rather than what was typed.
   */
  readonly targetMbid: string | null;
  /** For the two actions that run a search rather than pin an id: what to search for. */
  readonly searchText: string | null;
}

export interface ResolveInput {
  readonly job: Import;
  /** True when this import is one video: the entity dispatch differs entirely. */
  readonly single: boolean;
  /** The video's title, for choosing a track on a pasted release. */
  readonly videoTitle: string | null;
  readonly videoSeconds: number | null;
  readonly db?: Database;
  readonly signal?: AbortSignal;
  /**
   * The lookups, supplied.
   *
   * The seam the dispatch is tested through. Every interesting case here is "what does a
   * pasted *release* id do on a single", and answering that with a live MusicBrainz or a
   * recorded cassette per branch would be six cassettes to prove five `if`s. The production
   * callers never pass this.
   */
  readonly lookups?: Lookups;
}

/**
 * The five lookups, behind one object.
 *
 * `release` and `recording` go through the **gateway**, so a `fixture://` import replays its
 * cassette and stays offline; the other three have no cassette and go to P04's client directly,
 * through the same limiter and the same raw cache as everything else. Every one of them turns a
 * throw into `null`: a lookup that fails is "not this entity" as far as the dispatch below is
 * concerned, and the caller finds out from the *absence* of an answer rather than from a stack
 * trace — which is exactly what a cassette that does not hold an artist document should look
 * like.
 */
export interface Lookups {
  release(mbid: string): Promise<MbRelease | null>;
  recording(mbid: string): Promise<MbRecording | null>;
  releaseGroup(mbid: string): Promise<MbReleaseGroup | null>;
  artist(mbid: string): Promise<MbArtist | null>;
  work(mbid: string): Promise<MbWork | null>;
}

/**
 * The same five lookups with **no import behind them**.
 *
 * `lookupsFor` below needs a job, because a `fixture://` import has to replay its cassette.
 * The command palette has no job — somebody pasted an id into ⌘K before deciding what to do
 * with it — so it takes the plain client for all five, through the same one-per-second gate
 * and the same raw cache. `offline` is `MM_FIXTURES` at the call site, which is what keeps
 * fixtures mode from reaching a socket.
 */
export function directLookups(db: Database, signal?: AbortSignal, offline = false): Lookups {
  const ctx = async () => await sourceContextFor(db, signal, offline);
  const quietly = async <T>(run: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await run();
    } catch {
      return null;
    }
  };
  return {
    release: async (mbid) =>
      await quietly(async () => (await lookupRelease(await ctx(), mbid)).data),
    recording: async (mbid) =>
      await quietly(async () => (await lookupRecording(await ctx(), mbid)).data),
    releaseGroup: async (mbid) =>
      await quietly(async () => (await lookupReleaseGroup(await ctx(), mbid)).data),
    artist: async (mbid) => await quietly(async () => (await lookupArtist(await ctx(), mbid)).data),
    work: async (mbid) => await quietly(async () => (await lookupWork(await ctx(), mbid)).data),
  };
}

async function lookupsFor(job: Import, db: Database, signal?: AbortSignal): Promise<Lookups> {
  const gateway = await gatewayForUrl(job.url, db, signal);
  /*
   * **A `fixture://` import never leaves the process.** Its release and recording lookups
   * replay a cassette, and the three that have no cassette must answer from the raw cache or
   * not at all — `offline` is what says so. Without this, pasting an id into the wizard on a
   * fixture import would reach real MusicBrainz, which is precisely the rule AGENTS.md states
   * about fixtures mode staying fully offline.
   */
  const offline = cassetteNameOf(job.url) !== null;
  const ctx = async () => await sourceContextFor(db, signal, offline);
  const quietly = async <T>(run: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await run();
    } catch {
      return null;
    }
  };
  return {
    release: async (mbid) => await quietly(async () => await gateway.lookupRelease(mbid)),
    recording: async (mbid) => await quietly(async () => await gateway.lookupRecording(mbid)),
    releaseGroup: async (mbid) =>
      await quietly(async () => (await lookupReleaseGroup(await ctx(), mbid)).data),
    artist: async (mbid) => await quietly(async () => (await lookupArtist(await ctx(), mbid)).data),
    work: async (mbid) => await quietly(async () => (await lookupWork(await ctx(), mbid)).data),
  };
}

/**
 * The order the entities are tried in, most likely first.
 *
 * A URL that named an entity puts that one first, so the common case — somebody pasting the
 * address of the page they are on — costs exactly one request. A bare id starts with
 * `recording` on a single and `release` on an album, which is what the box used to assume and
 * is still right most of the time; the difference is that being wrong now costs a second
 * lookup instead of a wrong sentence.
 */
export function entityOrder(
  claimed: MbEntityName | null,
  single: boolean,
): readonly MbEntityName[] {
  const natural: readonly MbEntityName[] = single
    ? ["recording", "release", "release-group", "artist", "work"]
    : ["release", "release-group", "recording", "artist", "work"];
  if (claimed === null) return natural;
  return [claimed, ...natural.filter((entity) => entity !== claimed)];
}

/** The year of a `YYYY-MM-DD`, `YYYY-MM` or `YYYY` date. */
function yearOfDate(date: string | null | undefined): number | null {
  if (date === null || date === undefined || date === "") return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * Resolve a pasted string, or `null` when it holds no MusicBrainz reference at all.
 *
 * `null` is not a failure: it means "this is free text", which is the caller's signal to run a
 * search instead. Everything else comes back as a `ResolvedRef` — including the ones this app
 * cannot use, because *naming* them is the whole point.
 */
export async function resolveMbRef(
  input: string,
  options: ResolveInput,
): Promise<ResolvedRef | null> {
  const ref = parseMbRef(input);
  if (ref === null) return null;

  const db = options.db ?? defaultDb();
  const lookups = options.lookups ?? (await lookupsFor(options.job, db, options.signal));

  const found = await identify(ref, lookups, entityOrder(ref.claimed, options.single));
  if (found !== null) return describe(found, ref.mbid, options);

  return {
    mbid: ref.mbid,
    entity: null,
    noun: null,
    title: null,
    artist: null,
    lengthSeconds: null,
    year: null,
    count: null,
    disambiguation: null,
    action: "none",
    actionLabel: null,
    explanation:
      ref.claimed === null
        ? "MusicBrainz does not know this id as a recording, a release, a release group, an artist or a work."
        : `MusicBrainz does not know a ${MB_ENTITY_NOUN[ref.claimed]} with this id.`,
    targetMbid: null,
    searchText: null,
  };
}

/**
 * **What it is**, with the document that proved it — the half that has no opinion.
 *
 * `ResolvedRef` answers "what happens if I press the button", which only means something for
 * an import that already exists. The command palette asks the question one step earlier: an
 * id pasted into ⌘K has no job behind it, and the affordances it offers (pin an import to this
 * release, show the tracks that match this recording) are not the wizard's. So the lookup loop
 * lives here, on its own, and both callers take it.
 */
export type MbEntityDoc =
  | { readonly entity: "recording"; readonly doc: MbRecording }
  | { readonly entity: "release"; readonly doc: MbRelease }
  | { readonly entity: "release-group"; readonly doc: MbReleaseGroup }
  | { readonly entity: "artist"; readonly doc: MbArtist }
  | { readonly entity: "work"; readonly doc: MbWork };

export interface IdentifiedRef {
  readonly ref: MbRef;
  /** `null` when none of the five lookups knows the id — which is a fact, not a failure. */
  readonly found: MbEntityDoc | null;
}

/**
 * Parse a pasted string and ask MusicBrainz which of the five entities it names.
 *
 * `null` means the string holds no MusicBrainz reference at all, which is the caller's signal
 * that this is free text and belongs in a search.
 */
export async function identifyMbRef(
  input: string,
  options: { readonly lookups: Lookups; readonly single?: boolean },
): Promise<IdentifiedRef | null> {
  const ref = parseMbRef(input);
  if (ref === null) return null;
  return {
    ref,
    found: await identify(ref, options.lookups, entityOrder(ref.claimed, options.single ?? false)),
  };
}

/** The loop: try the likeliest entity first, stop at the first document that comes back. */
async function identify(
  ref: MbRef,
  lookups: Lookups,
  tries: readonly MbEntityName[],
): Promise<MbEntityDoc | null> {
  for (const entity of tries) {
    if (entity === "recording") {
      const doc = await lookups.recording(ref.mbid);
      if (doc !== null) return { entity, doc };
    } else if (entity === "release") {
      const doc = await lookups.release(ref.mbid);
      if (doc !== null) return { entity, doc };
    } else if (entity === "release-group") {
      const doc = await lookups.releaseGroup(ref.mbid);
      if (doc !== null) return { entity, doc };
    } else if (entity === "artist") {
      const doc = await lookups.artist(ref.mbid);
      if (doc !== null) return { entity, doc };
    } else if (entity === "work") {
      const doc = await lookups.work(ref.mbid);
      if (doc !== null) return { entity, doc };
    }
  }
  return null;
}

/** What the wizard can do with an identified reference, for the import it was pasted on. */
function describe(identified: MbEntityDoc, mbid: string, options: ResolveInput): ResolvedRef {
  const entity = identified.entity;
  const base = {
    mbid,
    entity,
    noun: MB_ENTITY_NOUN[entity],
    lengthSeconds: null as number | null,
    year: null as number | null,
    count: null as number | null,
    disambiguation: null as string | null,
    targetMbid: null as string | null,
    searchText: null as string | null,
  };

  if (identified.entity === "recording") {
    const found = identified.doc;
    const releases = (found as { releases?: readonly MbRelease[] }).releases ?? [];
    const first = releases[0];
    return {
      ...base,
      title: found.title ?? "unknown recording",
      artist: creditName(found["artist-credit"]),
      lengthSeconds: found.length === undefined ? null : Math.round(found.length / 1000),
      disambiguation: found.disambiguation === "" ? null : (found.disambiguation ?? null),
      count: releases.length,
      ...(options.single
        ? {
            action: "use-recording" as const,
            actionLabel: "Use this recording",
            explanation: "This is the recording your video will be filed as.",
            targetMbid: mbid,
          }
        : first === undefined
          ? {
              action: "none" as const,
              actionLabel: null,
              explanation:
                "That is a recording, and this import is an album. MusicBrainz puts it on no release, so there is nothing to pin.",
            }
          : {
              action: "pin-release" as const,
              actionLabel: "Pin the release it is on",
              explanation: `That is a recording, and this import is an album. It appears on “${first.title ?? "a release"}”, which can be pinned instead.`,
              targetMbid: first.id ?? null,
            }),
    };
  }

  if (identified.entity === "release") {
    const found = identified.doc;
    const tracks = flattenTracks(found);
    const common = {
      ...base,
      title: found.title ?? "unknown release",
      artist: creditName(found["artist-credit"]),
      year: yearOfDate(found.date),
      count: tracks.length,
      disambiguation: found.disambiguation === "" ? null : (found.disambiguation ?? null),
    };
    if (!options.single) {
      return {
        ...common,
        action: "pin-release",
        actionLabel: "Pin this release",
        explanation: "The mapping will be computed against this release's tracklist.",
        targetMbid: mbid,
      };
    }
    /*
     * A release on a single is the case the owner actually hit. He pasted the album because
     * the album is what he had; the last step — which of its tracks is this video? — is one the
     * app can take on its own, and saying which track it picked is what makes that safe.
     */
    const best = bestTrackFor(tracks, options.videoTitle, options.videoSeconds);
    if (best === null) {
      return {
        ...common,
        action: "none",
        actionLabel: null,
        explanation:
          "That is a release, not a recording, and its tracklist is empty — there is no track to file your video as.",
      };
    }
    return {
      ...common,
      targetMbid: best.recordingMbid,
      action: "track-of-release",
      actionLabel: `Use track ${String(best.position)}, “${best.title}”`,
      explanation: `That is a release, not a recording. Of its ${String(tracks.length)} track(s), “${best.title}” fits your video best.`,
    };
  }

  if (identified.entity === "release-group") {
    const found = identified.doc;
    /*
     * `MbReleaseGroup` is typed for the fields the *document* resolvers read, and a lookup
     * carries more than that — the credits and the releases among them. Read through a narrow
     * local shape rather than widening the shared type for a preview panel.
     */
    const extra = found as {
      "artist-credit"?: Parameters<typeof creditName>[0];
      disambiguation?: string;
      releases?: readonly MbRelease[];
    };
    const releases = extra.releases ?? [];
    return {
      ...base,
      title: found.title ?? "unknown release group",
      artist: creditName(extra["artist-credit"]),
      year: yearOfDate(found["first-release-date"]),
      count: releases.length,
      disambiguation:
        extra.disambiguation === undefined || extra.disambiguation === ""
          ? null
          : extra.disambiguation,
      action: releases.length === 0 ? "none" : "editions-of-group",
      actionLabel: releases.length === 0 ? null : "Show its editions",
      targetMbid: releases.length === 0 ? null : mbid,
      searchText: found.title ?? null,
      explanation:
        releases.length === 0
          ? "That is a release group, and MusicBrainz lists no release under it."
          : `That is a release group — ${String(releases.length)} edition(s) of one record. They go through the same edition selection as any other candidate.`,
    };
  }

  if (identified.entity === "artist") {
    const found = identified.doc;
    return {
      ...base,
      title: found.name ?? "unknown artist",
      artist: null,
      disambiguation: found.disambiguation === "" ? null : (found.disambiguation ?? null),
      action: "search-artist",
      actionLabel: `List ${found.name ?? "this artist"}’s ${options.single ? "recordings" : "records"}`,
      searchText: found.name ?? null,
      // It lists the catalogue rather than searching it for this import's title, which is what
      // the artist-only search does everywhere else now — one behaviour, one sentence.
      explanation: `That is an artist, not a ${options.single ? "recording" : "release"}. Their ${options.single ? "recordings" : "release groups"} can be listed instead.`,
    };
  }

  const found = identified.doc;
  return {
    ...base,
    title: found.title ?? "unknown work",
    artist: null,
    disambiguation: found.disambiguation === "" ? null : (found.disambiguation ?? null),
    action: "none",
    actionLabel: null,
    explanation:
      "That is a work — a composition, not a recording of one. Paste the recording, the release or the release group instead.",
  };
}

/**
 * Which track of a pasted release this video is.
 *
 * Title first, duration as the tie-breaker, which is the same order of evidence the matcher
 * uses and the same one a person uses. The answer is *named* on the button rather than applied
 * silently, so a wrong guess costs a glance instead of a wrong import.
 */
function bestTrackFor(
  tracks: readonly ReturnType<typeof flattenTracks>[number][],
  videoTitle: string | null,
  videoSeconds: number | null,
): { recordingMbid: string | null; title: string; position: number } | null {
  if (tracks.length === 0) return null;
  let best = tracks[0];
  let bestScore = -1;
  for (const track of tracks) {
    const title = videoTitle === null ? 0 : titleSimilarity(videoTitle, track.title);
    const delta =
      videoSeconds === null || track.lengthSeconds === null
        ? 0
        : Math.max(0, 1 - Math.abs(videoSeconds - track.lengthSeconds) / 30);
    const score = title * 3 + delta;
    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }
  if (best === undefined) return null;
  return { recordingMbid: best.recordingMbid, title: best.title, position: best.position };
}
