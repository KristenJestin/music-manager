/**
 * The Navidrome client, against a cassette recorded from the dockerised server.
 *
 * Two kinds of assertion live here and they are worth telling apart:
 *
 *  - **protocol**: the token is `md5(password + salt)`, the salt is fresh every time, a
 *    `status: "failed"` envelope inside an HTTP 200 is an error and not an empty library;
 *  - **shape**: the fields Navidrome 0.63.2 really returns, which is what the read-back
 *    depends on and what a future upgrade might change. A cassette re-recorded against a new
 *    version is the diff that tells you.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MMError } from "@mm/contracts";
import { NavidromeClient, SUBSONIC_API_VERSION } from "./client.ts";
import { cassetteFetch, cassetteKey, envelopeFetch, loadCassette } from "./cassettes.ts";

const cassette = loadCassette();

function client(fetchImpl = cassetteFetch(cassette)): NavidromeClient {
  return new NavidromeClient(
    { url: "http://localhost:4533", user: "admin", password: "admin" },
    { fetch: fetchImpl },
  );
}

describe("authentication", () => {
  it("sends t = md5(password + salt) and never the password", async () => {
    const seen: URL[] = [];
    const api = new NavidromeClient(
      { url: "http://nav.test", user: "admin", password: "hunter2" },
      {
        salt: () => "deadbeef",
        fetch: (url) => {
          seen.push(new URL(url));
          return Promise.resolve(
            new Response(JSON.stringify({ "subsonic-response": { status: "ok" } }), {
              headers: { "content-type": "application/json" },
            }),
          );
        },
      },
    );
    await api.ping();

    const query = seen[0]?.searchParams;
    expect(query?.get("t")).toBe(createHash("md5").update("hunter2deadbeef").digest("hex"));
    expect(query?.get("s")).toBe("deadbeef");
    expect(query?.get("v")).toBe(SUBSONIC_API_VERSION);
    expect(query?.get("f")).toBe("json");
    // The password itself must appear nowhere, not even as the deprecated `p`.
    expect(seen[0]?.toString()).not.toContain("hunter2");
    expect(query?.get("p")).toBeNull();
  });

  it("uses a different salt on every request", async () => {
    const salts: string[] = [];
    const api = new NavidromeClient(
      { url: "http://nav.test", user: "admin", password: "x" },
      {
        fetch: (url) => {
          salts.push(new URL(url).searchParams.get("s") ?? "");
          return Promise.resolve(
            new Response(JSON.stringify({ "subsonic-response": { status: "ok" } }), {
              headers: { "content-type": "application/json" },
            }),
          );
        },
      },
    );
    await api.ping();
    await api.ping();
    expect(salts[0]).not.toBe(salts[1]);
  });

  it("turns a wrong password into NAVIDROME_AUTH rather than an empty answer", async () => {
    const api = client(
      envelopeFetch({
        status: "failed",
        error: { code: 40, message: "Wrong username or password" },
      }),
    );
    await expect(api.ping()).rejects.toMatchObject({ code: "NAVIDROME_AUTH" });
  });

  it("refuses to call anything when nothing is configured", async () => {
    const api = new NavidromeClient({ url: "", user: "", password: "" });
    expect(api.configured).toBe(false);
    await expect(api.ping()).rejects.toMatchObject({ code: "NAVIDROME_NOT_CONFIGURED" });
  });

  it("reports a transport failure as NAVIDROME_UNREACHABLE", async () => {
    const api = client(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(api.ping()).rejects.toMatchObject({ code: "NAVIDROME_UNREACHABLE" });
  });

  it("does not mistake an HTML page for a Subsonic server", async () => {
    const api = client(() =>
      Promise.resolve(
        new Response("<html>not here</html>", { headers: { "content-type": "text/html" } }),
      ),
    );
    await expect(api.ping()).rejects.toBeInstanceOf(MMError);
  });
});

describe("the views the read-back uses", () => {
  it("ping identifies the server and says it speaks OpenSubsonic", async () => {
    const identity = await client().ping();
    expect(identity.ok).toBe(true);
    expect(identity.type).toBe("navidrome");
    expect(identity.serverVersion).not.toBe("");
    expect(identity.openSubsonic).toBe(true);
  });

  it("getScanStatus reports a finished scan with a count", async () => {
    const status = await client().getScanStatus();
    expect(status.scanning).toBe(false);
    expect(status.count ?? 0).toBeGreaterThan(0);
  });

  it("search3 finds the album and getAlbum carries the album-level fields", async () => {
    const api = client();
    const found = await api.search3("Discovery", { albumCount: 50 });
    const summary = (found.album ?? []).find((entry) => entry.name === "Discovery");
    expect(summary).toBeDefined();

    const album = await api.getAlbum(summary?.id ?? "");
    expect(album?.name).toBe("Discovery");
    expect(album?.artist).toBe("Daft Punk");
    expect(album?.songCount).toBe(14);
    // The fields docs/03 §7 asks about, as this version returns them.
    expect(album?.musicBrainzId).toMatch(/^[0-9a-f-]{36}$/);
    expect(album?.releaseTypes).toContain("album");
    expect(album?.recordLabels?.map((entry) => entry.name)).toContain("Virgin");
    expect(album?.originalReleaseDate?.year).toBe(2001);
    expect((album?.genres ?? []).length).toBeGreaterThan(0);
  });

  it("getSong carries the per-track fields, including replay gain", async () => {
    const api = client();
    const album = await api.getAlbum(
      (await api.search3("Discovery", { albumCount: 50 })).album?.[0]?.id ?? "",
    );
    const first = (album?.song ?? [])[0];
    const song = await api.getSong(first?.id ?? "");
    expect(song?.title).toBe("One More Time");
    expect(song?.musicBrainzId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof song?.replayGain?.trackGain).toBe("number");
  });

  it("getLyricsBySongId reports whether the lyrics are synced", async () => {
    const api = client();
    const album = await api.getAlbum(
      (await api.search3("Discovery", { albumCount: 50 })).album?.[0]?.id ?? "",
    );
    const lyrics = await api.getLyricsBySongId((album?.song ?? [])[0]?.id ?? "");
    expect(lyrics.length).toBeGreaterThan(0);
    expect(lyrics[0]?.synced).toBe(true);
  });

  it("getCoverArt returns the size and the magic number, never the bytes", async () => {
    const api = client();
    const album = await api.getAlbum(
      (await api.search3("Discovery", { albumCount: 50 })).album?.[0]?.id ?? "",
    );
    const cover = await api.getCoverArt(album?.coverArt ?? "", 200);
    expect(cover.ok).toBe(true);
    expect(cover.kind).toBe("jpeg");
    expect(cover.bytes).toBeGreaterThan(0);
  });

  it("getAlbumList2, getStarred2 and getTopSongs unwrap to plain arrays", async () => {
    const api = client();
    expect(Array.isArray(await api.getAlbumList2({ type: "newest", size: 10 }))).toBe(true);
    const starred = await api.getStarred2();
    expect(Array.isArray(starred.album)).toBe(true);
    expect(Array.isArray(await api.getTopSongs("Daft Punk", 5))).toBe(true);
  });

  it("a cover the server has nothing for is `not ok`, not an exception", async () => {
    const api = client(() =>
      Promise.resolve(
        new Response(JSON.stringify({ "subsonic-response": { status: "failed" } }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const cover = await api.getCoverArt("nothing");
    expect(cover.ok).toBe(false);
    expect(cover.kind).toBe("");
  });
});

describe("waitForScan", () => {
  it("returns as soon as the scanner is idle and has counted something", async () => {
    const api = client();
    const status = await api.waitForScan({ timeoutMs: 1_000, pollMs: 1 });
    expect(status.scanning).toBe(false);
  });

  it("gives up with a hint rather than hanging forever", async () => {
    const api = client(envelopeFetch({ status: "ok", scanStatus: { scanning: true, count: 0 } }));
    await expect(api.waitForScan({ timeoutMs: 5, pollMs: 1 })).rejects.toMatchObject({
      code: "NAVIDROME_SCAN_TIMEOUT",
    });
  });
});

describe("cassetteKey", () => {
  it("ignores the credentials, so a re-recording is a readable diff", () => {
    const params = new URLSearchParams({
      u: "admin",
      t: "abc",
      s: "def",
      v: "1.16.1",
      c: "mm",
      f: "json",
      id: "42",
    });
    expect(cassetteKey("getAlbum", params)).toBe("getAlbum?id=42");
  });
});
