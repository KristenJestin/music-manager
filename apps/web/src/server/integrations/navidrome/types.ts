/**
 * The slice of the OpenSubsonic response shapes the read-back needs.
 *
 * These are hand-written rather than generated because there is no machine-readable schema
 * for Subsonic: the reference is <https://opensubsonic.netlify.app/docs/>, plus what
 * Navidrome actually returns, which the P02 conformance test measured (`P02-build-1.md`).
 * Every field is optional on purpose — a server that does not index something omits the key
 * entirely, and "absent" is one of the three verdicts §7 asks for, not an error.
 */

/** The envelope every `/rest/*` view answers with. */
export interface SubsonicEnvelope {
  readonly status: "ok" | "failed";
  readonly version?: string;
  /** Navidrome, gonic, LMS… — `ping` is how we learn which server we are talking to. */
  readonly type?: string;
  readonly serverVersion?: string;
  readonly openSubsonic?: boolean;
  readonly error?: { readonly code: number; readonly message: string };
  readonly [view: string]: unknown;
}

export interface SubsonicItemName {
  readonly id?: string;
  readonly name?: string;
}

/** `originalReleaseDate` and friends come back as parts, not as an ISO string. */
export interface SubsonicDateParts {
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
}

export interface SubsonicReplayGain {
  readonly trackGain?: number;
  readonly albumGain?: number;
  readonly trackPeak?: number;
  readonly albumPeak?: number;
}

export interface SubsonicSong {
  readonly id: string;
  readonly title?: string;
  readonly album?: string;
  readonly artist?: string;
  readonly artists?: readonly SubsonicItemName[];
  readonly albumArtists?: readonly SubsonicItemName[];
  readonly track?: number;
  readonly discNumber?: number;
  readonly year?: number;
  readonly genre?: string;
  readonly genres?: readonly SubsonicItemName[];
  readonly moods?: readonly string[];
  readonly bpm?: number;
  readonly isrc?: readonly string[] | string;
  readonly comment?: string;
  readonly musicBrainzId?: string;
  readonly coverArt?: string;
  readonly duration?: number;
  readonly size?: number;
  readonly suffix?: string;
  readonly path?: string;
  readonly explicitStatus?: string;
  readonly replayGain?: SubsonicReplayGain;
  readonly contributors?: readonly {
    readonly role?: string;
    readonly subRole?: string;
    readonly artist?: SubsonicItemName;
  }[];
  readonly displayComposer?: string;
  readonly sortName?: string;
  /* The listening signals P09 reads. Per user, and absent when the user never played it. */
  readonly playCount?: number;
  /** ISO instant of the last play. */
  readonly played?: string;
  /** ISO instant at which it was starred; absent means not starred. */
  readonly starred?: string;
  /** 1–5. */
  readonly userRating?: number;
}

export interface SubsonicAlbum {
  readonly id: string;
  readonly name?: string;
  readonly artist?: string;
  readonly artists?: readonly SubsonicItemName[];
  readonly year?: number;
  readonly genre?: string;
  readonly genres?: readonly SubsonicItemName[];
  readonly moods?: readonly string[];
  readonly songCount?: number;
  readonly duration?: number;
  readonly coverArt?: string;
  readonly musicBrainzId?: string;
  readonly releaseTypes?: readonly string[];
  readonly recordLabels?: readonly SubsonicItemName[];
  readonly originalReleaseDate?: SubsonicDateParts;
  readonly releaseDate?: SubsonicDateParts;
  readonly discTitles?: readonly { readonly disc?: number; readonly title?: string }[];
  readonly explicitStatus?: string;
  readonly isCompilation?: boolean;
  readonly song?: readonly SubsonicSong[];
  /* The listening signals P09 reads (`getAlbumList2?type=frequent`, `getStarred2`). */
  readonly playCount?: number;
  readonly played?: string;
  readonly starred?: string;
  readonly userRating?: number;
}

/** What `getPlaylists` / `createPlaylist` answer. P09 writes one list and only one. */
export interface SubsonicPlaylist {
  readonly id: string;
  readonly name?: string;
  readonly comment?: string;
  readonly owner?: string;
  readonly public?: boolean;
  readonly songCount?: number;
  readonly duration?: number;
  readonly created?: string;
  readonly changed?: string;
  readonly entry?: readonly SubsonicSong[];
}

export interface SubsonicScanStatus {
  readonly scanning: boolean;
  readonly count?: number;
  readonly folderCount?: number;
  readonly lastScan?: string;
}

export interface SubsonicStructuredLyrics {
  readonly lang?: string;
  readonly synced?: boolean;
  readonly displayArtist?: string;
  readonly displayTitle?: string;
  readonly line?: readonly { readonly start?: number; readonly value?: string }[];
}

export interface SubsonicSearchResult {
  readonly artist?: readonly SubsonicItemName[];
  readonly album?: readonly SubsonicAlbum[];
  readonly song?: readonly SubsonicSong[];
}

/** What `ping` tells us: enough to show a server line in Tools and in Settings. */
export interface NavidromeIdentity {
  readonly ok: boolean;
  readonly type: string;
  readonly serverVersion: string;
  readonly apiVersion: string;
  readonly openSubsonic: boolean;
  /** Round trip, in milliseconds. */
  readonly latencyMs: number;
}

/** The head of a cover: we prove there is an image, never carry the bytes around. */
export interface CoverArtInfo {
  readonly ok: boolean;
  readonly bytes: number;
  readonly contentType: string;
  /** `jpeg`, `png`, or `""` when the magic number matched nothing. */
  readonly kind: string;
}
