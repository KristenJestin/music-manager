#!/usr/bin/env bun
/**
 * Record the cassettes of `./cassettes/`. **The only networked code under `test/`.**
 *
 * It is never run by `vitest`, by `bun run test` or by `bun run check` — those replay what
 * this produced. Run it by hand when a source's shape changes:
 *
 *     bun run apps/web/test/record-cassettes.ts             # all of them
 *     bun run apps/web/test/record-cassettes.ts musicbrainz # one
 *
 * It goes through the very clients the tests exercise, so the recorded keys are by
 * construction the keys the tests will ask for — a cassette cannot drift from its client.
 * MusicBrainz is paced by the client's own 1 req/s limiter, as §4 requires.
 *
 * Credentials are redacted by `keyOf`/`saveCassette` before anything touches the disk, and
 * lyrics are redacted by `redactLyrics`.
 */
import { defaults } from "#/server/services/settings.ts";
import { sourcesConfig, type SourceContext } from "#/server/integrations/config.ts";
import { memoryStore } from "#/server/integrations/cached.ts";
import { resetFetch, setFetch, type FetchLike } from "#/server/integrations/http.ts";
import * as caa from "#/server/integrations/coverartarchive.ts";
import * as deezer from "#/server/integrations/deezer.ts";
import * as lastfm from "#/server/integrations/lastfm.ts";
import * as listenbrainz from "#/server/integrations/listenbrainz.ts";
import * as lrclib from "#/server/integrations/lrclib.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import * as wikimedia from "#/server/integrations/wikimedia.ts";
import {
  redactedRequest,
  redactLyrics,
  saveCassette,
  type Cassette,
  type CassetteEntry,
} from "./cassette.ts";

/* The Discovery scenario, the same one `packages/domain/fixtures` records. */
const RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";
const RECORDING = "60fa767a-d85d-4991-82bc-4294e0b11ae7";
const WORK = "4bb47ffc-9006-32cf-8aa9-e213334550dc";
const ARTIST = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";
/** The two ISRCs MusicBrainz has for "One More Time", in its own order. */
const ISRCS = ["GBAHT1305744", "GBDUW0000053"];
const ARTIST_NAME = "Daft Punk";
const TRACK_NAME = "One More Time";
const ALBUM_NAME = "Discovery";

/** Wrap the real fetch and keep everything it answered. */
function recorder(): { entries: CassetteEntry[]; restore: () => void } {
  const entries: CassetteEntry[] = [];
  const real: FetchLike = (url, init) => fetch(url, init);
  setFetch(async (url, init) => {
    const response = await real(url, init);
    const text = await response.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      /* keep the raw text; a cassette records what came back, not what we hoped for */
    }
    const request = redactedRequest(url, init);
    entries.push({
      method: request.method,
      url: request.url,
      ...(request.form === undefined ? {} : { form: request.form }),
      status: response.status,
      body: redactLyrics(body),
    });
    return response;
  });
  return { entries, restore: resetFetch };
}

function context(): SourceContext {
  // Defaults, not the database: the recorder must run without a stack up. The credentials
  // therefore come from the environment (v2/.env), which is where they live anyway.
  const settings = defaults();
  return {
    db: null as never, // never touched: the store below is in memory
    store: memoryStore(),
    config: sourcesConfig(settings),
    offline: false,
    refresh: true,
  };
}

type Tape = (ctx: SourceContext) => Promise<void>;

const TAPES: Record<string, { note: string; run: Tape }> = {
  musicbrainz: {
    note: "Daft Punk — Discovery: the release, the recording, its work and its artist, with the §4 inc presets.",
    run: async (ctx) => {
      await musicbrainz.lookupRelease(ctx, RELEASE);
      await musicbrainz.lookupRecording(ctx, RECORDING);
      await musicbrainz.lookupWork(ctx, WORK);
      await musicbrainz.lookupArtist(ctx, ARTIST);
      await musicbrainz.lookupReleaseGroup(ctx, "48117b90-a16e-34ca-a514-19c702df1158");
      await musicbrainz.browseReleaseGroupsByArtist(ctx, ARTIST, { limit: 5 });
      await musicbrainz.search(ctx, "release", `release:"Discovery" AND artist:"Daft Punk"`, {
        limit: 5,
      });
      // A deliberate 404, so the "absent is a fact" path is recorded rather than imagined.
      await musicbrainz.lookupRelease(ctx, "11111111-2222-4333-8444-555555555555");
    },
  },
  coverartarchive: {
    note: "The Discovery cover index, and a release the archive has nothing for (the frequent 404 of §4).",
    run: async (ctx) => {
      await caa.index(ctx, RELEASE);
      await caa.index(ctx, "11111111-2222-4333-8444-555555555555");
    },
  },
  lrclib: {
    note: "One More Time: the exact lookup and the search. Lyrics redacted, timestamps kept.",
    run: async (ctx) => {
      await lrclib.lyricsFor(ctx, {
        artist: ARTIST_NAME,
        track: TRACK_NAME,
        album: ALBUM_NAME,
        durationSeconds: 320,
      });
      await lrclib.lyricsFor(ctx, {
        artist: ARTIST_NAME,
        track: "A Track That Does Not Exist At All",
        album: ALBUM_NAME,
        durationSeconds: 123,
      });
    },
  },
  deezer: {
    note: "By ISRC: one that Deezer knows, and one it answers HTTP 200 + error body for.",
    run: async (ctx) => {
      // Both, in MusicBrainz order: `firstKnownIsrc` walks them until Deezer answers, and
      // the tape has to hold whatever it says about each — including a miss.
      for (const isrc of ISRCS) await deezer.byIsrc(ctx, isrc);
      await deezer.byIsrc(ctx, "ZZZZZ0000000");
    },
  },
  lastfm: {
    note: "Top tags for the track and for the artist — the genre fallback of §4. Key redacted.",
    run: async (ctx) => {
      await lastfm.trackTopTags(ctx, ARTIST_NAME, TRACK_NAME);
      await lastfm.artistTopTags(ctx, ARTIST_NAME);
      await lastfm.artistSimilar(ctx, ARTIST_NAME, 5);
    },
  },
  listenbrainz: {
    note: "Community tags for the recording, and the similar-artists graph P09 will read.",
    run: async (ctx) => {
      await listenbrainz.recordingTags(ctx, RECORDING);
      await listenbrainz.similarArtists(ctx, ARTIST);
    },
  },
  wikimedia: {
    note: "Wikidata entity for Daft Punk — the P18 claim that becomes artist.jpg (§3).",
    run: async (ctx) => {
      const artist = await musicbrainz.lookupArtist(ctx, ARTIST);
      await wikimedia.artistImage(ctx, artist.data as never);
    },
  },
};

const wanted = process.argv.slice(2);
const names = wanted.length === 0 ? Object.keys(TAPES) : wanted;

for (const name of names) {
  const tape = TAPES[name];
  if (tape === undefined) {
    console.error(`unknown cassette "${name}". One of: ${Object.keys(TAPES).join(", ")}`);
    process.exit(2);
  }
  const { entries, restore } = recorder();
  try {
    await tape.run(context());
  } catch (error) {
    // Keep what was recorded before the failure: a half tape plus a loud message beats
    // losing four successful lookups because the fifth was rate-limited.
    console.error(`  ! ${name}: ${String(error)}`);
  } finally {
    restore();
  }
  const cassette: Cassette = {
    recordedAt: new Date().toISOString(),
    note: tape.note,
    entries,
  };
  saveCassette(name, cassette);
  console.log(`${name}: ${String(entries.length)} entr(ies)`);
}
