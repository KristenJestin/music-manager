/**
 * The "Recommended" playlist push, against a fake Subsonic server.
 *
 * Three reported symptoms, one heading each, and all three were the same two mistakes: the
 * playlist was found by an exact case-sensitive name and never written down, and it was
 * emptied using `songCount` off the *list* endpoint, where the field is optional.
 *
 * The fake implements the five methods `PlaylistClient` declares and keeps the playlists in a
 * map, so "did this append or replace?" is a length assertion rather than a mock call count —
 * which is the property that actually matters to somebody looking at Feishin.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { writePlaylist, type PlaylistClient, type PlaylistTarget } from "./discover.ts";

interface FakePlaylist {
  id: string;
  name: string;
  songs: string[];
  /** `false` reproduces a server that omits `songCount` from `getPlaylists`. */
  reportsCount: boolean;
  /** `false` reproduces one that will not return the entries either. */
  reportsEntries: boolean;
}

class FakeNavidrome implements PlaylistClient {
  readonly playlists = new Map<string, FakePlaylist>();
  private next = 1;
  created = 0;
  deleted = 0;

  seed(playlist: Omit<FakePlaylist, "id"> & { id?: string }): FakePlaylist {
    const id = playlist.id ?? `pl-${String(this.next++)}`;
    const row: FakePlaylist = { ...playlist, id };
    this.playlists.set(id, row);
    return row;
  }

  getPlaylists(): Promise<readonly { id: string; name?: string; songCount?: number }[]> {
    return Promise.resolve(
      [...this.playlists.values()].map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        ...(playlist.reportsCount ? { songCount: playlist.songs.length } : {}),
      })),
    );
  }

  getPlaylist(playlistId: string): Promise<{ id: string; name?: string } | null> {
    const found = this.playlists.get(playlistId);
    return Promise.resolve(found === undefined ? null : { id: found.id, name: found.name });
  }

  createPlaylist(name: string, songIds: readonly string[]): Promise<{ id: string; name?: string }> {
    this.created += 1;
    const made = this.seed({
      name,
      songs: [...songIds],
      reportsCount: true,
      reportsEntries: true,
    });
    return Promise.resolve({ id: made.id, name: made.name });
  }

  replacePlaylist(playlistId: string, songIds: readonly string[]): Promise<void> {
    const found = this.playlists.get(playlistId);
    if (found === undefined) throw new Error("no such playlist");
    // The real client reads the entries back and refuses to append blindly when it cannot.
    if (!found.reportsEntries && !found.reportsCount) {
      throw new Error("Navidrome would not say how many songs the playlist holds.");
    }
    found.songs = [...songIds];
    return Promise.resolve();
  }

  deletePlaylist(playlistId: string): Promise<void> {
    this.deleted += 1;
    this.playlists.delete(playlistId);
    return Promise.resolve();
  }
}

/**
 * A `db` that only has to answer the two queries `writePlaylist` makes.
 *
 * Standing up Postgres for "is the id remembered?" would make this an integration test, and
 * the question is about the branch taken, not about SQL.
 */
function fakeDb(store: Map<string, { playlistId: string; name: string }>, key: string) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const row = store.get(key);
            return Promise.resolve(row === undefined ? [] : [{ server: key, ...row }]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: { server: string; playlistId: string; name: string }) => ({
        onConflictDoUpdate: () => {
          store.set(row.server, { playlistId: row.playlistId, name: row.name });
          return Promise.resolve();
        },
      }),
    }),
  };
}

const SERVER = "http://navidrome.local";

let store: Map<string, { playlistId: string; name: string }>;
let client: FakeNavidrome;

function target(name = "Recommended"): PlaylistTarget {
  // The two fakes stand in for a Drizzle database and a Subsonic client; both are structural.
  return {
    db: fakeDb(store, SERVER) as unknown as PlaylistTarget["db"],
    client,
    server: SERVER,
    name,
  };
}

beforeEach(() => {
  store = new Map();
  client = new FakeNavidrome();
});

describe("the first sync", () => {
  it("creates the playlist and writes its id down", async () => {
    const id = await writePlaylist(target(), ["a", "b"]);
    expect(client.created).toBe(1);
    expect(client.playlists.get(id)?.songs).toEqual(["a", "b"]);
    expect(store.get(SERVER)).toEqual({ playlistId: id, name: "Recommended" });
  });
});

describe("a server that omits songCount", () => {
  /**
   * The reported bug, reduced to four lines.
   *
   * `replacePlaylist` used to be handed `existing.songCount ?? 0`, so a server that does not
   * send the field removed zero songs and then added the new ones — and the playlist grew by
   * its own length on every single sync.
   */
  it("replaces the contents instead of appending to them", async () => {
    const seeded = client.seed({
      name: "Recommended",
      songs: ["old-1", "old-2", "old-3"],
      reportsCount: false,
      reportsEntries: true,
    });
    const id = await writePlaylist(target(), ["a", "b"]);
    expect(id).toBe(seeded.id);
    expect(client.playlists.get(id)?.songs).toEqual(["a", "b"]);
    expect(client.created).toBe(0);
  });

  it("deletes and recreates when nothing can say how long it is", async () => {
    const seeded = client.seed({
      name: "Recommended",
      songs: ["old-1", "old-2"],
      reportsCount: false,
      reportsEntries: false,
    });
    const id = await writePlaylist(target(), ["a"]);
    expect(client.deleted).toBe(1);
    expect(client.created).toBe(1);
    expect(id).not.toBe(seeded.id);
    expect(client.playlists.size).toBe(1);
    expect(client.playlists.get(id)?.songs).toEqual(["a"]);
    // And the new id replaces the old one, so the next sync does not go looking for a ghost.
    expect(store.get(SERVER)?.playlistId).toBe(id);
  });
});

describe("a playlist that was renamed", () => {
  it("is found by its stored id, not by the name it no longer has", async () => {
    const seeded = client.seed({
      name: "Recommended",
      songs: [],
      reportsCount: true,
      reportsEntries: true,
    });
    store.set(SERVER, { playlistId: seeded.id, name: "Recommended" });
    // Somebody renamed it in Navidrome; the setting still says "Recommended".
    seeded.name = "Suggestions du soir";

    const id = await writePlaylist(target(), ["a"]);
    expect(id).toBe(seeded.id);
    expect(client.created).toBe(0);
    expect(client.playlists.size).toBe(1);
  });

  it("matches a name that differs only in case or padding", async () => {
    client.seed({
      name: "  recommended ",
      songs: ["old"],
      reportsCount: true,
      reportsEntries: true,
    });
    await writePlaylist(target("Recommended"), ["a"]);
    // The old code compared with `===` and made a second playlist here.
    expect(client.created).toBe(0);
    expect(client.playlists.size).toBe(1);
  });
});

describe("a stored id that no longer exists", () => {
  it("falls back to the name, then to creating one, and re-writes the id", async () => {
    store.set(SERVER, { playlistId: "deleted-by-hand", name: "Recommended" });
    const id = await writePlaylist(target(), ["a"]);
    expect(client.created).toBe(1);
    expect(id).not.toBe("deleted-by-hand");
    expect(store.get(SERVER)?.playlistId).toBe(id);
  });
});

describe("running it twice", () => {
  it("leaves exactly one playlist holding exactly the second list", async () => {
    const first = await writePlaylist(target(), ["a", "b", "c"]);
    const second = await writePlaylist(target(), ["b", "d"]);
    expect(second).toBe(first);
    expect(client.playlists.size).toBe(1);
    expect(client.playlists.get(second)?.songs).toEqual(["b", "d"]);
  });
});
