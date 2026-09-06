#!/usr/bin/env bun
/**
 * Record the Navidrome cassette used by the unit tests.
 *
 *     docker compose -f docker-compose.dev.yml up -d navidrome
 *     uv run --directory services/toolbox pytest -m conformance   # places the fixture album
 *     bun run apps/web/src/server/integrations/navidrome/record-cassettes.ts
 *
 * It walks the same views the read-back uses, in the same order, and writes one JSON file.
 * The token and the salt are stripped from the key (see `cassettes.ts`), so re-recording
 * produces a diff only where the server's answer really changed — which is exactly what you
 * want to read when a Navidrome upgrade breaks something.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NavidromeClient } from "./client.ts";
import { cassetteKey, type NavidromeCassette } from "./cassettes.ts";

const BASE = process.env.MM_NAVIDROME_URL ?? "http://localhost:4533";
const USER = process.env.MM_NAVIDROME_USER ?? "admin";
const PASSWORD = process.env.MM_NAVIDROME_PASSWORD ?? "admin";
const ALBUM_QUERY = process.argv[2] ?? "Discovery";
const NAME = process.argv[3] ?? "discovery";

const entries: Record<string, unknown> = {};
const binary: NavidromeCassette["binary"] = {};

/** The recording `fetch`: does the real call, keeps the body, hands it back untouched. */
const recordingFetch = async (url: string, init: RequestInit): Promise<Response> => {
  const response = await fetch(url, init);
  const parsed = new URL(url);
  const view = parsed.pathname.replace(/^.*\/rest\//, "");
  const key = cassetteKey(view, parsed.searchParams);
  const type = response.headers.get("content-type") ?? "";

  if (type.includes("application/json")) {
    const text = await response.text();
    entries[key] = JSON.parse(text);
    return new Response(text, { status: response.status, headers: response.headers });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  binary[key] = {
    contentType: type,
    // Only the first bytes: the test checks the magic number and the length, not the image.
    bytesBase64: btoa(String.fromCharCode(...bytes.slice(0, 512))),
  };
  return new Response(bytes, { status: response.status, headers: response.headers });
};

const client = new NavidromeClient(
  { url: BASE, user: USER, password: PASSWORD },
  { fetch: recordingFetch },
);

const identity = await client.ping();
console.log(`recording against ${identity.type} ${identity.serverVersion}`);

await client.getScanStatus();
await client.getAlbumList2({ type: "newest", size: 10 });
await client.getStarred2();

const search = await client.search3(ALBUM_QUERY, { albumCount: 50 });
const album = (search.album ?? [])[0];
if (album === undefined) {
  console.error(
    `No album matches "${ALBUM_QUERY}". Place the fixture album first:\n` +
      "  uv run --directory services/toolbox pytest -m conformance",
  );
  process.exit(1);
}

const full = await client.getAlbum(album.id);
const song = (full?.song ?? [])[0];
if (song !== undefined) {
  await client.getSong(song.id);
  await client.getLyricsBySongId(song.id);
}
await client.getCoverArt(full?.coverArt ?? album.id, 200);
await client.getTopSongs(album.artist ?? "Daft Punk", 5);

const cassette: NavidromeCassette = {
  recordedAt: new Date().toISOString(),
  serverVersion: `${identity.type} ${identity.serverVersion}`,
  entries,
  binary,
};

const target = join(dirname(fileURLToPath(import.meta.url)), "cassettes", `${NAME}.json`);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
console.log(
  `wrote ${target}: ${String(Object.keys(entries).length)} JSON view(s), ${String(Object.keys(binary).length)} binary`,
);
