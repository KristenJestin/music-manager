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
import {
  CREDENTIAL_ENV_KEY,
  sourcesConfig,
  type CredentialName,
  type CredentialOrigin,
  type SourceContext,
} from "#/server/integrations/config.ts";
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
  /** Where the credential this run used came from. `undefined` for sources that need none. */
  readonly credential?: CredentialOrigin;
}

/**
 * "The key from the settings" / "the key from MM_ACOUSTID_KEY" / "no key at all".
 *
 * A test that does not say which credential it used is not a test (owner review B8): the
 * owner read "The key was accepted" over an empty field, because the key had come from the
 * environment and nothing on the page said so.
 */
function says(name: CredentialName, origin: CredentialOrigin): string {
  if (origin === "settings") return "the key from the settings";
  if (origin === "environment") return `the key from ${CREDENTIAL_ENV_KEY[name]}`;
  return "no key";
}

/** The failure a source with no credential deserves: it names the two places to put one. */
function missing(name: CredentialName, label: string): string {
  return `No ${label} key is configured, in the settings or in ${CREDENTIAL_ENV_KEY[name]}.`;
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
  extra: { credential?: CredentialOrigin; unconfigured?: string } = {},
): Promise<SourceTestResult> {
  const started = Date.now();
  const base = {
    source,
    enabled,
    configured,
    ...(extra.credential === undefined ? {} : { credential: extra.credential }),
  };
  if (!enabled) {
    return { ...base, ok: false, latencyMs: 0, message: "Disabled: enable it to test." };
  }
  if (!configured) {
    return {
      ...base,
      ok: false,
      latencyMs: 0,
      message: extra.unconfigured ?? "No credential configured.",
    };
  }
  try {
    const message = await probe();
    return { ...base, ok: true, latencyMs: Date.now() - started, message };
  } catch (error) {
    return {
      ...base,
      ok: false,
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
      return await timed(
        source,
        on,
        true,
        async () => {
          const answer = await musicbrainz.lookupRelease(ctx, RELEASE);
          // The User-Agent is quoted in full on purpose: §4 requires a contact in it, and
          // the Console had no way to show that the one from the environment was really the
          // one being sent (owner review B7).
          return answer.data === null
            ? `Answered as ${config.userAgent}, but that release is unknown to it.`
            : `Answered as ${config.userAgent}.`;
        },
        { credential: config.origin.contact },
      );
    case "coverartarchive":
      return await timed(source, on, true, async () => {
        const answer = await coverartarchive.index(ctx, RELEASE);
        return answer.data === null ? "Answered: no cover for that release." : "Answered.";
      });
    case "acoustid":
      return await timed(
        source,
        on,
        config.acoustidKey !== "",
        async () => {
          // A synthetic fingerprint: AcoustID checks the key before it looks at the audio,
          // so "invalid fingerprint" back means the credential got through, and "invalid API
          // key" back is a real failure rather than the shrug it used to be (decision 053).
          const answer = await acoustid.lookup(ctx, "AQAAA0mUaEkSRZEGAA", 224);
          const who = says("acoustidKey", config.origin.acoustidKey);
          return answer === null
            ? `AcoustID accepted ${who} and had nothing to say about the probe fingerprint.`
            : `AcoustID accepted ${who}.`;
        },
        {
          credential: config.origin.acoustidKey,
          unconfigured: missing("acoustidKey", "AcoustID"),
        },
      );
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
      return await timed(
        source,
        on,
        config.lastfmKey !== "",
        async () => {
          const answer = await lastfm.artistTopTags(ctx, "Daft Punk");
          const who = says("lastfmKey", config.origin.lastfmKey);
          // `null` means the client saw no key at all — which `configured` above already
          // ruled out, so it would be a bug here rather than a verdict on the credential.
          if (answer === null) {
            throw new MMError("INVALID_INPUT", "Nothing was asked: no key reached the client.");
          }
          return `Last.fm accepted ${who}.`;
        },
        { credential: config.origin.lastfmKey, unconfigured: missing("lastfmKey", "Last.fm") },
      );
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
