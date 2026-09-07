/**
 * "Refetch from MusicBrainz", for one album.
 *
 * This is the button behind `quality.missing[].action` (`REFRESH_ALBUM_ACTION`). The third
 * test report's §4 was not only that `musicbrainz_releasegroupid` never appeared in `missing`
 * — it was that naming a field without a way to fix it is half an answer. So the action exists
 * as a service, called by MCP's `refresh_album` and by `POST /api/v1/library/albums/{id}/refresh`.
 *
 * What it does, and deliberately no more:
 *
 *  1. re-fetches the album's MusicBrainz release **bypassing the cache TTL** (`refresh: true`),
 *     which is the only way to pick up an edit made upstream since the import;
 *  2. writes back what the release says about the album's own identity — today that is the
 *     release group, the one field the pipeline could lose (a supplied mapping recorded `null`
 *     for it, and `place` copied that onto the album row);
 *  3. queues an album-scoped re-tag with `onlyBehind: false`, so the files are re-projected
 *     from the refreshed documents rather than left describing yesterday's answer.
 *
 * It does **not** re-download anything, does not touch the mapping, and does not run the
 * re-tag itself: the worker owns writes to a library's worth of files, and a tool that blocked
 * for a hundred files would be a worse version of the queue that already exists.
 */
import { eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { imports, libraryAlbums } from "#/server/db/schema/index.ts";
import { sourcesConfig } from "#/server/integrations/config.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import { createRun } from "#/server/services/retag.ts";
import { enqueueRetagRun } from "#/server/services/queue.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

export interface AlbumRefresh {
  readonly albumId: string;
  readonly releaseMbid: string | null;
  /** What the album's release group was before, and what it is now. */
  readonly releaseGroupMbid: { readonly before: string | null; readonly after: string | null };
  /** Which of the album's own fields this call actually repaired. */
  readonly repaired: readonly string[];
  /** The queued re-tag, or `null` when there was nothing to re-project. */
  readonly retagRunId: string | null;
  readonly note: string;
}

export async function refreshAlbumFromSource(
  albumId: string,
  options: { db?: Database; settings?: Settings } = {},
): Promise<AlbumRefresh> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));

  const [album] = await db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);
  if (album === undefined) {
    throw new MMError("NOT_FOUND", `No album with id ${albumId}.`, { status: 404 });
  }

  const releaseMbid = album.releaseMbid;
  if (releaseMbid === null || releaseMbid === "") {
    throw new MMError(
      "INVALID_INPUT",
      "This album has no MusicBrainz release, so there is nothing to refetch.",
      {
        hint: "It was imported without MusicBrainz (`untagged`). Re-import it against a release to give it one.",
        action: "Re-import against a release",
        status: 400,
      },
    );
  }

  // `refresh: true` is the point of the call: without it the cache answers with the same
  // document the import stored, and "refetch" would be a synonym for "read".
  const answer = await musicbrainz.lookupRelease(
    { db, config: sourcesConfig(settings), offline: false, refresh: true },
    releaseMbid,
  );
  const release = answer.data;
  if (release === null) {
    throw new MMError("NOT_FOUND", `MusicBrainz has no release ${releaseMbid}.`, {
      hint: "It may have been merged upstream; open it on musicbrainz.org and re-import against the survivor.",
      status: 404,
    });
  }

  const before = album.releaseGroupMbid;
  const after = release["release-group"]?.id ?? before;
  const repaired: string[] = [];

  if (after !== before && after !== undefined && after !== null) {
    await db
      .update(libraryAlbums)
      .set({ releaseGroupMbid: after, updatedAt: new Date() })
      .where(eq(libraryAlbums.id, albumId));
    // The import rows that produced this album carry the same column, and they are what a
    // re-run of the pipeline would read back. Repairing one and not the other would make the
    // fix undo itself on the next `place`.
    await db
      .update(imports)
      .set({ releaseGroupMbid: after, updatedAt: new Date() })
      .where(eq(imports.releaseMbid, releaseMbid));
    repaired.push("releaseGroupMbid");
  }

  /*
   * A re-tag with `onlyBehind: false`, because nothing about the tag *schema* changed — what
   * changed is the answer MusicBrainz gives, and a run filtered on "behind the schema" would
   * find nothing to do and report success without opening a file.
   */
  const run = await createRun({
    db,
    settings,
    scope: "album",
    targetId: albumId,
    onlyBehind: false,
    trigger: "sources",
  });
  if (run.total > 0) await enqueueRetagRun(run.id);

  return {
    albumId,
    releaseMbid,
    releaseGroupMbid: { before, after: after ?? null },
    repaired,
    retagRunId: run.total > 0 ? run.id : null,
    note:
      repaired.length === 0
        ? `The release was refetched and says the same as before.${run.total > 0 ? " A re-tag is queued anyway, so the files match the documents." : ""}`
        : `Repaired ${repaired.join(", ")} from MusicBrainz.${run.total > 0 ? ` A re-tag of ${String(run.total)} file(s) is queued; \`get_status.worker\` says whether anything will run it.` : ""}`,
  };
}
