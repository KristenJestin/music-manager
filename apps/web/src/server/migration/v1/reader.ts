/**
 * Reading the v1 database — the only place in v2 that opens a second Postgres connection.
 *
 * Two rules govern this file, and both are enforced rather than promised:
 *
 *  - **The connection is read-only.** `default_transaction_read_only=on` is sent as a startup
 *    option *and* set on the session *and* read back with `SHOW`, because "we only wrote
 *    SELECTs" is not a guarantee, it is an intention. A migration that damaged the source it
 *    was migrating from would be the worst possible bug in this phase, and the v1 database is
 *    the user's only copy of what v1 knew.
 *  - **The pool is one connection wide and short-lived.** Nothing here is a service; a read
 *    opens, reads, and closes. The v1 database may be a laptop's docker container that the
 *    owner wants to stop again afterwards.
 *
 * Every identifier is double-quoted PascalCase: v1 is EF Core with no naming convention
 * configured, so `select id from songs` is a syntax error against it.
 */
import postgres from "postgres";
import { MMError } from "@mm/contracts";
import {
  decodeForce,
  decodeSong,
  type V1Dataset,
  type V1ForceMetadata,
  type V1Playlist,
  type V1PlaylistSong,
  type V1Song,
} from "./schema.ts";

export interface ReaderOptions {
  readonly url: string;
  /** Cap on `"Songs"` rows, lowest id first. `mm migrate v1 --limit N`. */
  readonly limit?: number;
  readonly connectTimeoutSeconds?: number;
}

export interface V1Reader {
  read(): Promise<V1Dataset>;
  close(): Promise<void>;
}

/** A connection string with its password replaced, safe to store and to print. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    return parsed.toString();
  } catch {
    // Not a URL we can parse — say nothing rather than risk leaking half of it.
    return "(unparseable connection string)";
  }
}

type Sql = ReturnType<typeof postgres>;

function connect(options: ReaderOptions): Sql {
  return postgres(options.url, {
    max: 1,
    connect_timeout: options.connectTimeoutSeconds ?? 15,
    // Belt: the server refuses a write on this session before we ever send one.
    connection: { options: "-c default_transaction_read_only=on" },
    // A v1 database full of notices should not become v2's log.
    onnotice: () => {},
    // v1 stores `bigint` durations; JavaScript numbers are exact well past any of them.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });
}

/**
 * Assert the session cannot write.
 *
 * Braces to the startup option's belt: a `SET` we issue ourselves, then a `SHOW` we read
 * back. If the answer is not `on`, the migration refuses to start — there is no scenario in
 * which carrying on with a writable connection to somebody's only v1 database is the better
 * choice.
 */
async function enforceReadOnly(sql: Sql): Promise<void> {
  await sql.unsafe("set session characteristics as transaction read only");
  await sql.unsafe("set default_transaction_read_only = on");
  const rows = (await sql.unsafe("show default_transaction_read_only")) as unknown as {
    default_transaction_read_only?: string;
  }[];
  const value = rows[0]?.default_transaction_read_only;
  if (value !== "on") {
    throw new MMError(
      "INVALID_INPUT",
      "The v1 connection refused to become read-only, so the migration will not touch it.",
      {
        hint: `default_transaction_read_only came back as "${String(value)}".`,
        action: "Check the role's settings on the v1 database",
      },
    );
  }
}

/**
 * Fail with something a human can act on.
 *
 * The three things that actually go wrong here are a wrong host, a wrong password and a
 * database that is not v1 at all — and the third one is worth naming, because pointing this
 * command at the *v2* database is an easy mistake and its error would otherwise be a bare
 * `relation "Songs" does not exist`.
 */
function readFailure(error: unknown, url: string): MMError {
  const message = error instanceof Error ? error.message : String(error);
  if (/relation .* does not exist/i.test(message)) {
    return new MMError("INVALID_INPUT", `${redactUrl(url)} does not look like a v1 database.`, {
      hint: 'It has no "Songs" table. v1 uses quoted PascalCase identifiers.',
      action: "Check the connection string",
    });
  }
  return new MMError("UPSTREAM", `Could not read the v1 database: ${message}`, {
    hint: `Tried ${redactUrl(url)}.`,
    action: "Check that the v1 database is reachable",
  });
}

/**
 * Open a read-only reader over a v1 database.
 *
 * The caller always closes it, including on failure — see `run.ts`, which wraps every use in
 * a `finally`.
 */
export function openV1Reader(options: ReaderOptions): V1Reader {
  const sql = connect(options);
  let checked = false;

  const ensure = async (): Promise<void> => {
    if (checked) return;
    await enforceReadOnly(sql);
    checked = true;
  };

  return {
    async read(): Promise<V1Dataset> {
      try {
        await ensure();

        const limit = options.limit;
        const songRows = (await (limit === undefined || limit <= 0
          ? sql.unsafe('select * from "Songs" order by "Id"')
          : sql.unsafe('select * from "Songs" order by "Id" limit $1', [
              limit,
            ]))) as unknown as Record<string, unknown>[];
        const songs: V1Song[] = songRows.map(decodeSong);

        const ids = new Set(songs.map((song) => song.id));

        const forceRows = (await sql.unsafe(
          'select * from "SongForceMetadata" order by "SongId", "Field"',
        )) as unknown as Record<string, unknown>[];
        const forces = new Map<number, V1ForceMetadata[]>();
        for (const raw of forceRows) {
          const entry = decodeForce(raw);
          if (!ids.has(entry.songId)) continue;
          const bucket = forces.get(entry.songId);
          if (bucket === undefined) forces.set(entry.songId, [entry]);
          else bucket.push(entry);
        }

        const playlistRows = (await sql.unsafe(
          'select "Id", "Name", "Description" from "UserPlaylists" order by "Id"',
        )) as unknown as Record<string, unknown>[];
        const playlists: V1Playlist[] = playlistRows.map((raw) => ({
          id: Number(raw["Id"] ?? 0),
          name: String(raw["Name"] ?? ""),
          description: typeof raw["Description"] === "string" ? raw["Description"] : null,
        }));

        const linkRows = (await sql.unsafe(
          'select "PlaylistId", "SongId", "Order" from "UserPlaylistSongs" order by "PlaylistId", "Order"',
        )) as unknown as Record<string, unknown>[];
        const playlistSongs: V1PlaylistSong[] = linkRows
          .map((raw) => ({
            playlistId: Number(raw["PlaylistId"] ?? 0),
            songId: Number(raw["SongId"] ?? 0),
            order: Number(raw["Order"] ?? 0),
          }))
          .filter((link) => ids.has(link.songId));

        return { songs, forces, playlists, playlistSongs };
      } catch (error) {
        if (error instanceof MMError) throw error;
        throw readFailure(error, options.url);
      }
    },

    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
