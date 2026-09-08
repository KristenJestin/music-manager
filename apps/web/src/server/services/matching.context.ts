/**
 * A `SourceContext` for the matcher.
 *
 * P04 owns `integrations/config.ts` and the shape of the context; this is the two-line factory
 * P05 needs to build one and nothing more, kept in its own file so that the day P04 publishes
 * a shared factory this module becomes a one-line re-export instead of a merge conflict.
 *
 * `offline` is false here: outside fixtures mode the matcher is allowed to reach MusicBrainz,
 * once per second, through the cache. Fixtures mode never gets this far — it uses the cassette
 * gateway, which has no notion of a socket.
 */
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { sourcesConfig, type SourceContext } from "#/server/integrations/config.ts";
import { loadSettings } from "#/server/services/settings.ts";

export async function sourceContextFor(
  db: Database = defaultDb(),
  signal?: AbortSignal,
  /**
   * `true` forbids any outgoing request: `cached()` then serves the raw cache, stale and all,
   * and raises `OFFLINE_CACHE_MISS` for a key it has never seen.
   *
   * The wizard uses it as a **second chance** rather than a mode. When MusicBrainz refuses,
   * the candidates it computed on a previous visit are still in `source_cache`, and showing
   * those with "this is what we had" beats showing nothing at all (decision 165).
   */
  offline = false,
): Promise<SourceContext> {
  const settings = await loadSettings(db);
  return {
    db,
    config: sourcesConfig(settings),
    offline,
    refresh: false,
    ...(signal === undefined ? {} : { signal }),
  };
}
