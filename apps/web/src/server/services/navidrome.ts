/**
 * `navidrome.service` — the client, configured from the settings store, plus the one
 * question Settings → Integrations asks: "does this actually work?".
 *
 * The client itself (`server/integrations/navidrome/client.ts`) knows nothing about settings
 * or about the database; this is the seam where the two meet, so a test can build a client
 * against a cassette without a `settings` table anywhere in sight.
 *
 * The URL falls back to `MM_NAVIDROME_URL` for the same reason every credential in P04 does:
 * a container is configured by its environment, and the Console is configured by a person.
 */
import { MMError } from "@mm/contracts";
import type { Database } from "#/server/db/client.ts";
import {
  NavidromeClient,
  type NavidromeClientOptions,
} from "#/server/integrations/navidrome/client.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

/** Environment fallbacks, in the shape the rest of the app uses them. */
function fromEnv(env: Record<string, string | undefined>): {
  url: string;
  user: string;
  password: string;
} {
  return {
    url: env.MM_NAVIDROME_URL ?? "",
    user: env.MM_NAVIDROME_USER ?? "",
    password: env.MM_NAVIDROME_PASSWORD ?? "",
  };
}

/** Settings first, environment second — the same rule as every P04 credential. */
export function navidromeConfig(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
): { url: string; user: string; password: string; enabled: boolean } {
  const defaults = fromEnv(env);
  const pick = (chosen: string, fallback: string): string =>
    chosen.trim() === "" ? fallback.trim() : chosen.trim();
  const url = pick(settings.navidromeUrl, defaults.url);
  const user = pick(settings.navidromeUser, defaults.user);
  return {
    url,
    user,
    password: pick(settings.navidromePassword, defaults.password),
    // Configured *and* switched on: a half-filled form must not make `verify` start failing.
    enabled: settings.navidromeEnabled && url !== "" && user !== "",
  };
}

export function navidromeClient(
  settings: Settings,
  options: NavidromeClientOptions & { env?: Record<string, string | undefined> } = {},
): NavidromeClient {
  const config = navidromeConfig(settings, options.env ?? process.env);
  return new NavidromeClient(
    {
      url: config.url,
      user: config.user,
      password: config.password,
      timeoutMs: 60_000,
    },
    options,
  );
}

export interface NavidromeStatus {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly url: string;
  readonly user: string;
  readonly ok: boolean;
  readonly server: string;
  readonly serverVersion: string;
  readonly apiVersion: string;
  readonly openSubsonic: boolean;
  readonly latencyMs: number;
  readonly albumCount: number | null;
  readonly scanning: boolean;
  readonly lastScan: string | null;
  readonly songCount: number | null;
  readonly error: string | null;
}

/**
 * The "Test" button of Settings → Integrations, and the Navidrome row of Tools.
 *
 * It never throws: a wrong password is an answer, and the Console wants to render it next to
 * the field that caused it rather than in an error boundary.
 */
export async function navidromeStatus(options: {
  db?: Database;
  settings?: Settings;
  client?: NavidromeClient;
}): Promise<NavidromeStatus> {
  const settings = options.settings ?? (await loadSettings(options.db));
  const config = navidromeConfig(settings);
  const base: NavidromeStatus = {
    configured: config.url !== "" && config.user !== "",
    enabled: config.enabled,
    url: config.url,
    user: config.user,
    ok: false,
    server: "",
    serverVersion: "",
    apiVersion: "",
    openSubsonic: false,
    latencyMs: 0,
    albumCount: null,
    scanning: false,
    lastScan: null,
    songCount: null,
    error: null,
  };
  if (!base.configured) {
    return { ...base, error: "No Navidrome server is configured." };
  }

  const client = options.client ?? navidromeClient(settings);
  try {
    const identity = await client.ping();
    const status = await client.getScanStatus();
    const albums = await client.getAlbumList2({ type: "newest", size: 1 });
    return {
      ...base,
      ok: true,
      server: identity.type,
      serverVersion: identity.serverVersion,
      apiVersion: identity.apiVersion,
      openSubsonic: identity.openSubsonic,
      latencyMs: identity.latencyMs,
      albumCount: albums.length === 0 ? 0 : null,
      scanning: status.scanning,
      lastScan: status.lastScan ?? null,
      songCount: status.count ?? null,
      error: null,
    };
  } catch (error) {
    return { ...base, error: MMError.from(error).message };
  }
}

/** Ask for a scan and say what happened. The Tools "Rescan" button. */
export async function requestRescan(options: {
  db?: Database;
  settings?: Settings;
  client?: NavidromeClient;
  full?: boolean;
}): Promise<{ started: boolean; scanning: boolean; error: string | null }> {
  const settings = options.settings ?? (await loadSettings(options.db));
  const client = options.client ?? navidromeClient(settings);
  try {
    const status = await client.startScan({ full: options.full === true });
    return { started: true, scanning: status.scanning, error: null };
  } catch (error) {
    return { started: false, scanning: false, error: MMError.from(error).message };
  }
}
