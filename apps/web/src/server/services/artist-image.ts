/**
 * `artist.jpg` — the sidecar `packages/domain/src/paths/index.ts`'s `sidecarPaths().artistImage`
 * already names, and `placedArtistImage` (`services/library.ts`) already reads back for
 * `GET /api/artist-image`. Nothing wrote it until this module: `artists_cache.imageUrl` is
 * filled by `rememberArtist` (`services/documents.ts`, from `integrations/wikimedia.ts`), and
 * this is what turns that URL into a file beside the artist's folder.
 *
 * Modelled on `writeCover` (`jobs/steps/place.ts`): same "never overwrite, never fail the
 * caller" contract, so every call site — `place`, the v1 migration, the online refresh paths —
 * can call it without a `try`/`catch` of its own. The one difference is the write itself: a
 * cover is written straight to its final name because `place` already guarantees no two jobs
 * touch the same album concurrently (decision 147); the artist folder has no such guarantee —
 * two albums of the same artist can be placed by two different per-track jobs at once — so this
 * writes to a temp file first and `rename`s it into place, which is atomic on the same
 * filesystem and safe if a second caller wins the race (the loser's rename simply never
 * happens once the target exists).
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import type { MbArtistLike } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { artistsCache } from "#/server/db/schema/index.ts";
import type { SourceContext } from "#/server/integrations/config.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import * as wikimedia from "#/server/integrations/wikimedia.ts";
import { hostPath, type PathMap } from "#/server/paths.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";

/**
 * Names `library_albums.album_artist` carries for a compilation, none of which is a person or
 * a band with a picture worth fetching — and writing one under "Various Artists" would be the
 * one artist folder every compilation in the library shares.
 */
const COMPILATION_NAMES = new Set(["various artists", "various", "va"]);

export function isCompilationArtist(name: string): boolean {
  return COMPILATION_NAMES.has(name.trim().toLowerCase());
}

export type ArtistImageOutcome =
  "written" | "disabled" | "compilation" | "exists" | "no-image" | "no-folder" | "error";

export interface ArtistImageResult {
  readonly outcome: ArtistImageOutcome;
  readonly error?: string;
}

export interface WriteArtistImageOptions {
  readonly db?: Database;
  readonly toolbox?: ToolboxClient;
  readonly paths: PathMap;
  /** `library_albums.album_artist` — what `artists_cache.name` is matched against. */
  readonly artistName: string;
  /** The artist's folder, relative to the library root — the first segment of `folder`. */
  readonly artistFolder: string;
  readonly size: number;
  /** `settings.writeArtistImage`. */
  readonly enabled: boolean;
}

/**
 * `artists_cache`'s image, fetched if the row has none yet.
 *
 * The online half of `rememberArtist` (`services/documents.ts`), pulled out standalone: a
 * background refresh — the weekly `cron.refresh-sources` sweep, "refetch from MusicBrainz" —
 * already has an artist MBID and no document-building context to borrow one from, and the
 * document builder's own `rememberArtist` is private to it, keyed off the whole `Collected`
 * accumulator rather than a bare MBID. Same three-hop chase (`integrations/wikimedia.ts`
 * `artistImage`), same "an artist with no picture is a fact, not a failure" contract: a lookup
 * that finds nothing returns `null` rather than throwing, and the row is written either way so
 * the miss is not retried on every call.
 */
export async function refreshArtistImageCache(
  ctx: SourceContext,
  artistMbid: string,
): Promise<string | null> {
  const [existing] = await ctx.db
    .select()
    .from(artistsCache)
    .where(eq(artistsCache.artistMbid, artistMbid))
    .limit(1);
  if (existing?.imageUrl !== undefined && existing.imageUrl !== null) return existing.imageUrl;

  const looked = await musicbrainz.lookupArtist(ctx, artistMbid);
  if (looked.data === null) return existing?.imageUrl ?? null;
  // `artistFull` includes `url-rels`, which `MbArtist` does not declare — same cast
  // `rememberArtist` (`services/documents.ts`) makes for the same reason.
  const artist = looked.data as MbArtistLike;

  const found = await wikimedia.artistImage(ctx, artist);
  const imageUrl = found?.url ?? null;

  await ctx.db
    .insert(artistsCache)
    .values({
      artistMbid,
      name: artist.name ?? existing?.name ?? "",
      sortName: artist["sort-name"] ?? existing?.sortName ?? null,
      country: artist.country ?? existing?.country ?? null,
      imageUrl,
      payload: artist as unknown as Record<string, unknown>,
      fetchedAt: new Date(looked.fetchedAt),
    })
    .onConflictDoUpdate({
      target: artistsCache.artistMbid,
      set: {
        name: artist.name ?? existing?.name ?? "",
        sortName: artist["sort-name"] ?? existing?.sortName ?? null,
        country: artist.country ?? existing?.country ?? null,
        imageUrl,
        payload: artist as unknown as Record<string, unknown>,
        fetchedAt: new Date(looked.fetchedAt),
      },
    });

  return imageUrl;
}

/**
 * Write `<artistFolder>/artist.jpg` from `artists_cache.imageUrl`, if there is one to write and
 * nothing is there already.
 *
 * Never throws: a failed download is exactly as ordinary as an artist nobody has a picture of,
 * and the caller (a `place` step, a migration, a background refresh) has its own job to finish
 * whether or not this one succeeded. The `error` outcome is the caller's cue to journal it,
 * not to fail on it.
 */
export async function writeArtistImageSidecar(
  options: WriteArtistImageOptions,
): Promise<ArtistImageResult> {
  const db = options.db ?? defaultDb();
  const toolbox = options.toolbox ?? defaultToolbox();
  const { paths, artistName, artistFolder, size, enabled } = options;

  if (!enabled) return { outcome: "disabled" };
  if (artistFolder === "") return { outcome: "no-folder" };
  if (isCompilationArtist(artistName)) return { outcome: "compilation" };

  const target = hostPath(paths, `${artistFolder}/artist.jpg`);
  if (existsSync(target)) return { outcome: "exists" };

  try {
    const [row] = await db
      .select({ imageUrl: artistsCache.imageUrl })
      .from(artistsCache)
      .where(sql`lower(${artistsCache.name}) = lower(${artistName})`)
      .limit(1);
    const url = row?.imageUrl ?? null;
    if (url === null || url === "") return { outcome: "no-image" };

    const prepared = await toolbox.prepareArtwork({ url, size, square: true });
    const buffer = Buffer.from(prepared.data_base64, "base64");

    mkdirSync(dirname(target), { recursive: true });
    // A temp file in the same directory, then a rename: the rename is atomic on the same
    // filesystem, and a second writer that loses the race below simply discards its own copy
    // rather than overwriting the winner's.
    const temp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temp, buffer);
    if (existsSync(target)) {
      rmSync(temp, { force: true });
      return { outcome: "exists" };
    }
    renameSync(temp, target);
    return { outcome: "written" };
  } catch (error) {
    return { outcome: "error", error: MMError.from(error).message };
  }
}
