/**
 * The server functions behind the album's "Navidrome" tab and the Tools read-back row.
 *
 * `verifyOne` runs the read-back inline rather than through a queue, because it is a handful
 * of HTTP calls to a server on the same network and the operator pressed a button and is
 * looking at the screen. `verifyAll` is the opposite — one scan and then every album — so it
 * goes on the queue and the page follows the journal.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { navidromeStatus, type NavidromeStatus } from "#/server/services/navidrome.ts";
import {
  albumSubject,
  verifyAlbum,
  verifyLibrary,
  type AlbumVerification,
  type LibraryVerifyReport,
} from "#/server/services/verify.ts";

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

/** "Verify library": one scan, then every album. */
export const verifyAll = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ rescan: z.boolean().optional() }).default({}))
  .handler(async ({ data }): Promise<LibraryVerifyReport> => {
    try {
      return await verifyLibrary({
        db: db(),
        ...(data.rescan === undefined ? {} : { rescan: data.rescan }),
      });
    } catch (error) {
      return toFailure(error);
    }
  });
