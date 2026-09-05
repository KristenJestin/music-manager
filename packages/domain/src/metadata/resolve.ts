/**
 * One track's document, assembled from the raw cache.
 *
 * This is the recomputable step of `docs/03-metadonnees.md` §1: give it the source responses
 * that were stored (never purged, §8) and it returns the document. No network, no clock, no
 * randomness — the same cache always produces the same document, which is exactly what makes
 * the background re-tag safe and the golden files meaningful.
 *
 * Locked values are applied last so nothing a resolver produces can take them back.
 */

import { merge, type DocumentPatch, type Field, type TrackDocument } from "./document.ts";
import {
  fromAcoustId,
  fromApp,
  fromCoverArtArchiveIndex,
  fromDeezerTrack,
  fromLrclib,
  fromMusicBrainzRecording,
  fromMusicBrainzRelease,
  fromMusicBrainzWork,
  fromRsgain,
  fromYouTubeEntry,
  SOURCE_PRECEDENCE,
  type AcoustIdOptions,
  type AcoustIdResponse,
  type AppProvenance,
  type CaaIndex,
  type DeezerTrack,
  type LrclibEntry,
  type MbRecording,
  type MbRelease,
  type MbWork,
  type RsgainResult,
  type YouTubeResolverOptions,
  type YtdlpEntry,
} from "./resolvers/index.ts";
import { TAG_SCHEMA_VERSION } from "./schema.ts";

/** A cached response plus the instant it was fetched — one entry of the raw cache. */
export interface Cached<T> {
  readonly data: T;
  readonly fetchedAt: string;
}

export interface TrackResolutionInput {
  readonly release?: Cached<MbRelease> & {
    readonly mediumPosition?: number;
    readonly trackPosition: number;
  };
  readonly recording?: Cached<MbRecording>;
  readonly work?: Cached<MbWork>;
  readonly coverArt?: Cached<CaaIndex>;
  /** The LRCLIB entry already chosen out of a search (see `chooseLrclibEntry`). */
  readonly lyrics?: Cached<LrclibEntry | null>;
  readonly deezer?: Cached<DeezerTrack>;
  readonly acoustId?: Cached<AcoustIdResponse> & Omit<AcoustIdOptions, "fetchedAt">;
  readonly youtube?: Cached<YtdlpEntry> & Omit<YouTubeResolverOptions, "fetchedAt">;
  readonly rsgain?: Cached<RsgainResult> & { readonly opus: boolean };
  readonly app: Omit<AppProvenance, "fetchedAt"> & { readonly fetchedAt: string };
  /** Values you entered or confirmed. They are locked and win every merge (§1). */
  readonly locked?: Readonly<Record<string, Field>>;
}

export function resolveTrackDocument(input: TrackResolutionInput): TrackDocument {
  const patches: DocumentPatch[] = [];

  if (input.youtube !== undefined) {
    const { data, fetchedAt, ...options } = input.youtube;
    patches.push(fromYouTubeEntry(data, { ...options, fetchedAt }));
  }
  if (input.release !== undefined) {
    const { data, fetchedAt, mediumPosition, trackPosition } = input.release;
    patches.push(fromMusicBrainzRelease(data, { mediumPosition, trackPosition, fetchedAt }));
  }
  if (input.recording !== undefined) {
    patches.push(
      fromMusicBrainzRecording(input.recording.data, { fetchedAt: input.recording.fetchedAt }),
    );
  }
  if (input.work !== undefined) {
    patches.push(fromMusicBrainzWork(input.work.data, { fetchedAt: input.work.fetchedAt }));
  }
  if (input.coverArt !== undefined) {
    patches.push(
      fromCoverArtArchiveIndex(input.coverArt.data, { fetchedAt: input.coverArt.fetchedAt }),
    );
  }
  if (input.lyrics !== undefined) {
    patches.push(fromLrclib(input.lyrics.data, { fetchedAt: input.lyrics.fetchedAt }));
  }
  if (input.deezer !== undefined) {
    patches.push(fromDeezerTrack(input.deezer.data, { fetchedAt: input.deezer.fetchedAt }));
  }
  if (input.acoustId !== undefined) {
    const { data, fetchedAt, ...options } = input.acoustId;
    patches.push(fromAcoustId(data, { ...options, fetchedAt }));
  }
  if (input.rsgain !== undefined) {
    patches.push(
      fromRsgain(input.rsgain.data, { fetchedAt: input.rsgain.fetchedAt, opus: input.rsgain.opus }),
    );
  }

  patches.push(fromApp({ ...input.app }));

  if (input.locked !== undefined) {
    patches.push({ fields: lockAll(input.locked) });
  }

  return merge(patches, { schemaVersion: TAG_SCHEMA_VERSION, precedence: SOURCE_PRECEDENCE });
}

function lockAll(fields: Readonly<Record<string, Field>>): Record<string, Field> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, held]) => [name, { ...held, locked: true }]),
  );
}
