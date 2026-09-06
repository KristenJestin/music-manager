/**
 * The server functions behind `/discover`.
 *
 * `discoverImport` is the one that matters, and it is the whole point of the phase: it turns a
 * MusicBrainz id into an open wizard, at **step 2, with the release already selected**. It does
 * so in four moves — find a YouTube source, create the import, park it, and pick which of the
 * candidates the matcher found is the one Discover meant — and it returns a search-parameter
 * triple rather than navigating, so the route stays the only thing that knows about routing.
 *
 * The fourth move is the subtle one. The wizard already preselects a release; left alone it
 * would preselect *its* favourite, which is usually right but is not necessarily the record you
 * clicked. So the candidate whose **release-group** matches the item is preferred, and the
 * matcher's own choice is the fallback. That is the difference between "the wizard preselected
 * something" and "Discover preselected the thing you asked for".
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import { pauseImport } from "#/server/services/jobs/index.ts";
import { rankFor } from "#/server/services/matching.queries.ts";
import { sourceContextFor } from "#/server/services/matching.context.ts";
import { browseReleaseGroupsByArtist } from "#/server/integrations/musicbrainz.ts";
import { accepts, filtersOf } from "#/server/services/discography.ts";
import { preselectedRelease, resolveDiscoverSource } from "#/server/services/discover.bridge.ts";
import {
  discoverView,
  forgetDismissals,
  getItem,
  later,
  markImported,
  notInterested,
  syncDiscover,
  type DiscoverView,
  type SyncReport,
} from "#/server/services/discover.ts";
import { newId } from "#/server/ids.ts";
import { discoverItems } from "#/server/db/schema/index.ts";
import { loadSettings } from "#/server/services/settings.ts";

export const fetchDiscover = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<DiscoverView> => {
    try {
      return await discoverView({ db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

export const runDiscoverSync = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<SyncReport> => {
    try {
      return await syncDiscover({ db: db(), trigger: "console" });
    } catch (error) {
      return toFailure(error);
    }
  });

export const dismissDiscoverItem = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ itemId: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    try {
      await notInterested(data.itemId, db());
      return { ok: true };
    } catch (error) {
      return toFailure(error);
    }
  });

export const postponeDiscoverItem = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ itemId: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    try {
      await later(data.itemId, db());
      return { ok: true };
    } catch (error) {
      return toFailure(error);
    }
  });

export const forgetDiscoverDismissals = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<{ forgotten: number }> => {
    try {
      return { forgotten: await forgetDismissals(db()) };
    } catch (error) {
      return toFailure(error);
    }
  });

export interface DiscoverImportTarget {
  readonly importId: string;
  readonly step: number;
  /** The release MBID to preselect. Null when the source is a single video. */
  readonly release: string | null;
  readonly found: boolean;
  readonly label: string;
}

export const discoverImport = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ itemId: z.string().min(1) }))
  .handler(async ({ data }): Promise<DiscoverImportTarget> => {
    try {
      const item = await getItem(data.itemId, db());
      if (item === null) {
        throw new MMError("NOT_FOUND", `No Discover item with id ${data.itemId}.`, { status: 404 });
      }
      if (item.kind === "similar_artist") {
        throw new MMError(
          "INVALID_INPUT",
          "An artist is not importable on its own — open their discography and choose.",
          { hint: "Use “Add discography” on the artist card.", action: "Add discography" },
        );
      }

      const isAlbum = item.kind === "discography" || item.payload["itemKind"] !== "track";
      const source = await resolveDiscoverSource(
        isAlbum
          ? { kind: "album", artist: item.artist, album: item.albumTitle ?? item.title }
          : {
              kind: "track",
              artist: item.artist,
              title: item.title,
              durationSeconds:
                typeof item.payload["durationSeconds"] === "number"
                  ? item.payload["durationSeconds"]
                  : null,
            },
      );
      if (source.url === "") {
        throw new MMError("NOT_FOUND", source.label, {
          hint: "Paste a YouTube URL into the wizard instead.",
          action: "Open the wizard",
          status: 404,
        });
      }

      const created = await createFromUrl(source.url, { db: db() });
      await pauseImport(created.job.id, "Waiting for the import wizard (from Discover).", db());
      await markImported(data.itemId, created.job.id, db());

      const release = await preselectFor(created.job.id, item.releaseGroupMbid);
      return {
        importId: created.job.id,
        step: 2,
        release,
        found: source.found,
        label: source.label,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Which release the wizard should open on.
 *
 * The matcher is run once here so the answer is a real candidate rather than a guess: a
 * `release` search value the candidate list does not contain would leave step 2 with nothing
 * highlighted, which is worse than no preselection at all.
 */
async function preselectFor(
  importId: string,
  releaseGroupMbid: string | null,
): Promise<string | null> {
  const job = await getImport(importId, db());
  if (job === null) {
    throw new MMError("NOT_FOUND", `No import with id ${importId}.`, { status: 404 });
  }
  const settings = await loadSettings(db());
  const result = await rankFor({ job, settings, db: db() });
  // A lone video has no release to preselect; the wizard's step 2 lists recordings instead.
  if (result.kind === "single") return null;
  return preselectedRelease(
    result.ranking.candidates,
    releaseGroupMbid,
    result.ranking.preselected?.id ?? null,
  );
}

/**
 * "Add discography" on a similar-artist card.
 *
 * `docs/05` is explicit that importing an artist never means "everything by X": this inserts
 * their release-groups as ordinary Discover items so you pick, one record at a time, in the
 * block that already exists for exactly that.
 */
export const addArtistDiscography = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ itemId: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ added: number; artist: string }> => {
    try {
      const item = await getItem(data.itemId, db());
      if (item === null || item.artistMbid === null) {
        throw new MMError("NOT_FOUND", "That artist has no MusicBrainz id to browse.", {
          hint: "Only artists ListenBrainz named with an MBID can be expanded.",
          status: 404,
        });
      }
      const settings = await loadSettings(db());
      const ctx = await sourceContextFor(db());
      const answer = await browseReleaseGroupsByArtist(ctx, item.artistMbid, { limit: 100 });
      const groups = (answer.data?.["release-groups"] ?? []).filter((group) =>
        accepts(group, filtersOf(settings)),
      );

      let added = 0;
      for (const group of groups) {
        if (group.id === undefined) continue;
        const inserted = await db()
          .insert(discoverItems)
          .values({
            id: newId("discoverItem"),
            kind: "discography",
            subject: `release-group:${group.id}`,
            title: group.title ?? "Untitled",
            artist: item.artist,
            albumTitle: group.title ?? null,
            artistMbid: item.artistMbid,
            releaseGroupMbid: group.id,
            year: yearOf(group["first-release-date"] ?? null),
            primaryType: group["primary-type"] ?? null,
            secondaryTypes: [...(group["secondary-types"] ?? [])],
            score: item.score,
            reason: `similar to ${String(item.payload["similarTo"] ?? "an artist you play")} — nothing of theirs in your library`,
            source: item.source,
            inLibrary: false,
            payload: { have: 0, total: groups.length, plays: 0 },
          })
          .onConflictDoNothing()
          .returning({ id: discoverItems.id });
        added += inserted.length;
      }
      return { added, artist: item.artist };
    } catch (error) {
      return toFailure(error);
    }
  });

function yearOf(date: string | null): number | null {
  if (date === null) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}
