/**
 * The rule every source call obeys: through the raw cache, or not at all.
 *
 * `docs/03-metadonnees.md` §1 says nothing is ever thrown away, and P03's `cache.service`
 * honours that literally — no eviction, no purge. The TTL added here is a *revalidation*
 * policy layered on top: past the age the row is overwritten, never deleted, and offline it
 * is still served, stale, because a stale document beats no document at all.
 */
import { describe, expect, it } from "vitest";
import { cached, memoryStore, absentPayload } from "#/server/integrations/cached.ts";

const DAY = 86_400_000;

function answering<T>(value: T): { fetch: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    fetch: () => {
      calls += 1;
      return Promise.resolve(value);
    },
    calls: () => calls,
  };
}

describe("cached", () => {
  it("calls the source once and serves the row afterwards", async () => {
    const store = memoryStore();
    const source = answering({ title: "Discovery" });

    const first = await cached("musicbrainz", "release/x", source.fetch, {
      store,
      offline: false,
    });
    const second = await cached("musicbrainz", "release/x", source.fetch, {
      store,
      offline: false,
    });

    expect(source.calls()).toBe(1);
    expect(first.fresh).toBe(true);
    expect(second.fresh).toBe(false);
    expect(second.data).toEqual({ title: "Discovery" });
  });

  it("remembers an absence, so 'the archive has nothing' is asked once", async () => {
    const store = memoryStore();
    let calls = 0;
    const fetcher = (): Promise<null> => {
      calls += 1;
      return Promise.resolve(null);
    };

    expect(
      (await cached("coverartarchive", "release/x", fetcher, { store, offline: false })).data,
    ).toBeNull();
    expect(
      (await cached("coverartarchive", "release/x", fetcher, { store, offline: false })).data,
    ).toBeNull();
    expect(calls).toBe(1);
  });

  it("refreshes past the TTL, and overwrites rather than deleting", async () => {
    const old = new Date(Date.now() - 40 * DAY);
    const store = memoryStore([["musicbrainz release/x", { title: "old" }]], () => old);
    const source = answering({ title: "new" });

    const answer = await cached("musicbrainz", "release/x", source.fetch, {
      store,
      offline: false,
      ttlMs: 30 * DAY,
    });

    expect(source.calls()).toBe(1);
    expect(answer.data).toEqual({ title: "new" });
    expect(await store.get("musicbrainz", "release/x")).not.toBeNull();
  });

  it("leaves a young row alone", async () => {
    const store = memoryStore([["musicbrainz release/x", { title: "recent" }]]);
    const source = answering({ title: "new" });
    const answer = await cached("musicbrainz", "release/x", source.fetch, {
      store,
      offline: false,
      ttlMs: 30 * DAY,
    });
    expect(source.calls()).toBe(0);
    expect(answer.data).toEqual({ title: "recent" });
  });

  it("refetches on demand, which is what --refresh is", async () => {
    const store = memoryStore([["musicbrainz release/x", { title: "recent" }]]);
    const source = answering({ title: "new" });
    const answer = await cached("musicbrainz", "release/x", source.fetch, {
      store,
      offline: false,
      ttlMs: 0,
      refresh: true,
    });
    expect(source.calls()).toBe(1);
    expect(answer.data).toEqual({ title: "new" });
  });

  it("serves a stale row offline, and says so, rather than failing", async () => {
    const old = new Date(Date.now() - 400 * DAY);
    const store = memoryStore([["musicbrainz release/x", { title: "old" }]], () => old);
    const source = answering({ title: "new" });

    const answer = await cached("musicbrainz", "release/x", source.fetch, {
      store,
      offline: true,
      ttlMs: 30 * DAY,
    });

    expect(source.calls()).toBe(0);
    expect(answer.data).toEqual({ title: "old" });
    expect(answer.stale).toBe(true);
  });

  it("refuses to invent a row it has never seen", async () => {
    const store = memoryStore();
    const source = answering({ title: "new" });
    await expect(
      cached("musicbrainz", "release/never", source.fetch, { store, offline: true }),
    ).rejects.toMatchObject({ code: "OFFLINE_CACHE_MISS" });
    expect(source.calls()).toBe(0);
  });

  it("reads a seeded absence as an absence, not as a body", async () => {
    const store = memoryStore([["lrclib get?track=x", absentPayload("LRCLIB has no exact match")]]);
    const answer = await cached("lrclib", "get?track=x", () => Promise.resolve({ id: 1 }), {
      store,
      offline: true,
    });
    expect(answer.data).toBeNull();
  });
});
