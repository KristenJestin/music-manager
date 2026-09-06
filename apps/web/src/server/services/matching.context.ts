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
): Promise<SourceContext> {
  const settings = await loadSettings(db);
  return {
    db,
    config: sourcesConfig(settings),
    offline: false,
    refresh: false,
    ...(signal === undefined ? {} : { signal }),
  };
}
