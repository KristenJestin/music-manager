/**
 * "Test" buttons: does this source answer, and how fast.
 *
 * Each test is the cheapest *real* call the source offers — a known MusicBrainz release, a
 * known Cover Art Archive index, a fingerprint AcoustID already knows — with `refresh: true`,
 * because a test that was answered from our own cache would prove nothing at all.
 *
 * A failure is never thrown. "AcoustID: 401, the key is wrong" is the *result* of the test,
 * not an error condition, and the page shows it next to the field it is about.
 *
 * These are the only calls in P07a that leave the machine, and they are made by a person
 * pressing a button. Fixtures mode answers them from the recorded cassettes like everything
 * else, so the E2E suite exercises the button without touching a network.
 */
import { MMError } from "@mm/contracts";
import type { Database } from "#/server/db/client.ts";
import { sourcesConfig, type SourceContext } from "#/server/integrations/config.ts";
import * as acoustid from "#/server/integrations/acoustid.ts";
import * as coverartarchive from "#/server/integrations/coverartarchive.ts";
import * as deezer from "#/server/integrations/deezer.ts";
import * as lastfm from "#/server/integrations/lastfm.ts";
import * as listenbrainz from "#/server/integrations/listenbrainz.ts";
import * as lrclib from "#/server/integrations/lrclib.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import * as wikimedia from "#/server/integrations/wikimedia.ts";
import { SOURCE_NAMES, type Settings, type SourceName } from "#/server/services/settings.ts";

/** Daft Punk — Discovery. Already in the fixture cache, so the test works offline too. */
const RELEASE = "d073287b-1e6f-4c7c-8e5f-1f9b6a6f6b8c";
const RECORDING = "6b9a509f-6907-4d6e-9a99-3f6d6e0c1f5a";
const ARTIST = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";

export interface SourceTestResult {
  readonly source: SourceName;
  readonly ok: boolean;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly latencyMs: number;
  readonly message: string;
}

function contextFor(settings: Settings, db: Database): SourceContext {
  return { db, config: sourcesConfig(settings), offline: false, refresh: true };
}

/** Run one probe and time it, whatever it does and however it fails. */
async function timed(
  source: SourceName,
  enabled: boolean,
  configured: boolean,
  probe: () => Promise<string>,
): Promise<SourceTestResult> {
  const started = Date.now();
  if (!enabled) {
    return {
      source,
      ok: false,
      enabled,
      configured,
      latencyMs: 0,
      message: "Disabled — enable it to test.",
    };
  }
  if (!configured) {
    return {
      source,
      ok: false,
      enabled,
      configured,
      latencyMs: 0,
      message: "No credential configured.",
    };
  }
  try {
    const message = await probe();
    return { source, ok: true, enabled, configured, latencyMs: Date.now() - started, message };
  } catch (error) {
    return {
      source,
      ok: false,
      enabled,
      configured,
      latencyMs: Date.now() - started,
      message: MMError.from(error).message,
    };
  }
}

/** Test one source. */
export async function testSource(
  source: SourceName,
  options: { db: Database; settings: Settings },
): Promise<SourceTestResult> {
  const { settings, db } = options;
  const config = sourcesConfig(settings);
  const ctx = contextFor(settings, db);
  const on = config.enabled[source];

  switch (source) {
    case "musicbrainz":
      return await timed(source, on, true, async () => {
        const answer = await musicbrainz.lookupRelease(ctx, RELEASE);
        return answer.data === null
          ? "Answered, but that release is unknown to it."
          : `Answered as ${config.userAgent}.`;
      });
    case "coverartarchive":
      return await timed(source, on, true, async () => {
        const answer = await coverartarchive.index(ctx, RELEASE);
        return answer.data === null ? "Answered: no cover for that release." : "Answered.";
      });
    case "acoustid":
      return await timed(source, on, config.acoustidKey !== "", async () => {
        // A fingerprint short enough to be a probe and long enough to be accepted.
        const answer = await acoustid.lookup(ctx, "AQAAA0mUaEkSRZEGAA", 224);
        return answer === null
          ? "No key configured, so nothing was asked."
          : "The key was accepted.";
      });
    case "lrclib":
      return await timed(source, on, true, async () => {
        const answer = await lrclib.search(ctx, { track: "One More Time", artist: "Daft Punk" });
        return answer.data === null
          ? "Answered: nothing found."
          : `Answered with ${String(answer.data.length)} candidate(s).`;
      });
    case "deezer":
      return await timed(source, on, true, async () => {
        await deezer.byIsrc(ctx, "GBAYE0100251");
        return "Answered.";
      });
    case "lastfm":
      return await timed(source, on, config.lastfmKey !== "", async () => {
        const answer = await lastfm.artistTopTags(ctx, "Daft Punk");
        return answer === null
          ? "No key configured, so nothing was asked."
          : "The key was accepted.";
      });
    case "listenbrainz":
      return await timed(source, on, true, async () => {
        await listenbrainz.recordingTags(ctx, RECORDING);
        return "Answered.";
      });
    case "wikimedia":
      return await timed(source, on, true, async () => {
        await wikimedia.wikidataEntity(ctx, "Q159433");
        return "Answered.";
      });
  }
}

/** Test every source, in parallel — the "Test all" of the Sources table. */
export async function testAllSources(options: {
  db: Database;
  settings: Settings;
}): Promise<SourceTestResult[]> {
  return await Promise.all(SOURCE_NAMES.map(async (name) => await testSource(name, options)));
}

export { ARTIST as TEST_ARTIST_MBID, RELEASE as TEST_RELEASE_MBID };
