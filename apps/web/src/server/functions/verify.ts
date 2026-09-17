/**
 * The server functions behind the album's "Navidrome" tab and the Tools read-back row.
 *
 * `verifyOne` runs the read-back inline rather than through a queue, because it is a handful
 * of HTTP calls to a server on the same network and the operator pressed a button and is
 * looking at the screen. `verifyAll` is the opposite — one scan and then every album — so it
 * goes on the queue and the page follows the journal.
 *
 * That second sentence was aspirational until 2026-09-17: `verifyAll` ran `verifyLibrary`
 * inline, and a quarter of an hour of Subsonic calls inside one HTTP request is exactly the
 * shape of bug this file's neighbours were fixed for. It really does go on the queue now; see
 * `worker/handlers/verify.ts`.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { navidromeStatus, type NavidromeStatus } from "#/server/services/navidrome.ts";
import { enqueueLibraryVerify } from "#/server/services/queue.ts";
import { libraryCounts } from "#/server/services/scan.ts";
import { albumSubject, verifyAlbum, type AlbumVerification } from "#/server/services/verify.ts";

export interface AlbumVerifyPayload {
  readonly albumId: string;
  readonly title: string;
  readonly albumArtist: string;
  readonly verifiedAt: string | null;
  readonly verification: AlbumVerification | null;
  readonly navidrome: NavidromeStatus;
  readonly trackCount: number;
}

/** Everything the Navidrome tab shows, without running anything. */
export const fetchAlbumVerification = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ albumId: z.string().min(1) }))
  .handler(async ({ data }): Promise<AlbumVerifyPayload> => {
    try {
      const database = db();
      const subject = await albumSubject(data.albumId, database);
      const status = await navidromeStatus({ db: database });
      return {
        albumId: subject.album.id,
        title: subject.album.title,
        albumArtist: subject.album.albumArtist,
        verifiedAt: subject.album.verifiedAt?.toISOString() ?? null,
        verification:
          subject.album.verification === null
            ? null
            : (subject.album.verification as unknown as AlbumVerification),
        navidrome: status,
        trackCount: subject.tracks.length,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/** "Re-verify": read this one album back now. */
export const verifyOne = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ albumId: z.string().min(1), rescan: z.boolean().optional() }))
  .handler(async ({ data }): Promise<AlbumVerification> => {
    try {
      return await verifyAlbum(data.albumId, {
        db: db(),
        ...(data.rescan === undefined ? {} : { rescan: data.rescan }),
      });
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * "Verify library": one scan, then every album — on the queue, where it always claimed to be.
 *
 * The header of this file has said since P07 that this goes on the queue and the page follows
 * the journal. It did not. It ran `verifyLibrary` inline, in the HTTP request the button made:
 * a Navidrome rescan wait of up to `navidromeWaitTimeoutMs` (four minutes by default) followed
 * by six or seven Subsonic calls **per album**, serially, uncapped. Six hundred albums is a
 * quarter of an hour, and there is no connection timeout that makes that acceptable — the
 * production runtime hangs up after ten seconds of silence by default, and even the raised
 * ceiling of `server/http/abort.ts` is four minutes.
 *
 * So it now enqueues and returns, like `startScan` and `startRetag` next door. `total` is what
 * the page needs in order to say something true immediately ("reading back 412 albums"), and
 * the per-album lines arrive on `/api/events` as `verify.progress`, ending in `verify.done`
 * with the counts the toast used to carry.
 */
export const verifyAll = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ rescan: z.boolean().optional() }).default({}))
  .handler(async ({ data }): Promise<{ queued: boolean; total: number }> => {
    try {
      const { albums: total } = await libraryCounts(db());
      const jobId = await enqueueLibraryVerify({
        trigger: "manual",
        ...(data.rescan === undefined ? {} : { rescan: data.rescan }),
      });
      return { queued: jobId !== null, total };
    } catch (error) {
      return toFailure(error);
    }
  });
