/**
 * The variant cache, end to end against a real toolbox: a thumbnail is produced **once** and
 * read off disk every time after that.
 *
 * The cheap half of this is unit-tested next door (`image-variants.test.ts`: the closed set of
 * sizes, and the key). What only a running toolbox can prove is the part that matters to a
 * page load — that `/artwork/prepare` really shrinks the JPEG, that the result lands in
 * `.mm-cache/images/` inside the library both sides share, and that the second request costs
 * no round trip at all. A cache that re-generates on every hit is not a cache, and nothing
 * about the response would say so.
 *
 * Needs this checkout's toolbox up in **fixtures mode** (`MM_TOOLBOX_FIXTURES=1
 * bun run stack:up`), because that is how the source JPEG is produced without a network:
 * `/artwork/prepare` answers a `fixture://` URL with a deterministic gradient of the size
 * asked for. Self-skips without one, like its neighbours.
 */
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtworkResult } from "#/server/toolbox/client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-image-variant-test");

const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

/** The toolbox must be up *and* in fixtures mode: that is where the source picture comes from. */
async function toolboxIsReady(): Promise<string | null> {
  try {
    const response = await fetch(`${TOOLBOX_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return `toolbox answered ${String(response.status)} on ${TOOLBOX_URL}`;
    const health = (await response.json()) as { fixtures?: boolean };
    if (health.fixtures !== true) {
      return `toolbox at ${TOOLBOX_URL} is not in fixtures mode (MM_TOOLBOX_FIXTURES=1)`;
    }
    return null;
  } catch {
    return `no toolbox on ${TOOLBOX_URL}`;
  }
}

const unavailable = await toolboxIsReady();
if (unavailable !== null) {
  console.log(`  (image variant tests skipped: ${unavailable})`);
}

process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = "/library/.mm-image-variant-test";

const { resetServerEnv } = await import("#/server/env.ts");
const { pathMap } = await import("#/server/paths.ts");
const { ToolboxClient } = await import("#/server/toolbox/client.ts");
const { IMAGE_CACHE_DIR, resetImageVariants, variantFor, variantKey } =
  await import("./image-variants.ts");

resetServerEnv();

const paths = pathMap({
  host: LIBRARY_HOST,
  container: "/library/.mm-image-variant-test",
});

type PrepareRequest = Parameters<InstanceType<typeof ToolboxClient>["prepareArtwork"]>[0];

/** Counts the calls that actually reach `/artwork/prepare`. Nothing else is wrapped. */
class CountingToolbox extends ToolboxClient {
  calls = 0;
  override async prepareArtwork(request: PrepareRequest): Promise<ArtworkResult> {
    this.calls += 1;
    return await super.prepareArtwork(request);
  }
}

const client = new CountingToolbox({ baseUrl: TOOLBOX_URL, token: "" });
const original = join(LIBRARY_HOST, "Daft Punk", "Discovery (2001)", "cover.jpg");

describe.skipIf(unavailable !== null)("the image variant cache", () => {
  beforeAll(async () => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(dirname(original), { recursive: true });
    // A 1200 px JPEG, which is what `place` really writes: fixtures mode turns any URL into a
    // deterministic gradient of the requested size, so no network is involved.
    const seeded = await client.prepareArtwork({
      url: "fixture://image-variant-test",
      size: 1200,
      square: true,
    });
    writeFileSync(original, Buffer.from(seeded.data_base64, "base64"));
    client.calls = 0;
    resetImageVariants();
  }, 60_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  it("generates the variant on the first request and reads it back on the second", async () => {
    const stats = statSync(original);
    const source = { file: original, bytes: stats.size, mtimeMs: stats.mtimeMs };

    const first = await variantFor({ source, size: 320, paths, toolbox: client });
    expect(first).not.toBeNull();
    expect(first?.cached).toBe(false);
    expect(client.calls).toBe(1);

    // Where it went: inside the library mount, under the dot-prefixed directory Navidrome's
    // scanner skips — not beside the audio files it does index.
    expect(first?.file.replaceAll("\\", "/")).toContain(IMAGE_CACHE_DIR);
    expect(first?.file.endsWith(variantKey(source, 320))).toBe(true);
    expect(existsSync(first?.file ?? "")).toBe(true);

    // The point of the exercise: a fraction of the original's bytes.
    expect(first?.bytes).toBeGreaterThan(0);
    expect(first?.bytes).toBeLessThan(stats.size / 2);

    // Second time round: same file, no round trip.
    const second = await variantFor({ source, size: 320, paths, toolbox: client });
    expect(second?.cached).toBe(true);
    expect(second?.file).toBe(first?.file);
    expect(second?.bytes).toBe(first?.bytes);
    expect(client.calls).toBe(1);

    // And the ETag is the same, so a conditional request is a 304 with nothing in it.
    expect(second?.etag).toBe(first?.etag);
  }, 60_000);

  it("gives a smaller size its own entry, and never mixes two sizes up", async () => {
    const stats = statSync(original);
    const source = { file: original, bytes: stats.size, mtimeMs: stats.mtimeMs };
    const before = client.calls;

    const small = await variantFor({ source, size: 64, paths, toolbox: client });
    expect(client.calls).toBe(before + 1);
    expect(small?.cached).toBe(false);

    const big = await variantFor({ source, size: 320, paths, toolbox: client });
    expect(big?.cached).toBe(true);
    expect(small?.file).not.toBe(big?.file);
    expect(small?.bytes ?? 0).toBeLessThan(big?.bytes ?? 0);
  }, 60_000);

  it("resizes again once the original has been re-tagged", async () => {
    const stats = statSync(original);
    const source = { file: original, bytes: stats.size, mtimeMs: stats.mtimeMs };
    await variantFor({ source, size: 160, paths, toolbox: client });
    const before = client.calls;

    // A re-tag rewrites cover.jpg. Only the mtime is moved here, which is the weaker of the
    // two signals in the key and therefore the one worth asserting on its own.
    const later = new Date(Date.now() + 60_000);
    utimesSync(original, later, later);
    const retagged = { ...source, mtimeMs: statSync(original).mtimeMs };
    expect(retagged.mtimeMs).not.toBe(source.mtimeMs);

    const fresh = await variantFor({ source: retagged, size: 160, paths, toolbox: client });
    expect(fresh?.cached).toBe(false);
    expect(client.calls).toBe(before + 1);
  }, 60_000);

  it("answers one toolbox call when the same tile is asked for twice at once", async () => {
    const stats = statSync(original);
    const source = { file: original, bytes: stats.size, mtimeMs: stats.mtimeMs };
    // A size nothing above has touched, so the race is real rather than a cache hit.
    const before = client.calls;
    const [a, b] = await Promise.all([
      variantFor({ source, size: 640, paths, toolbox: client }),
      variantFor({ source, size: 640, paths, toolbox: client }),
    ]);
    expect(a?.file).toBe(b?.file);
    expect(client.calls).toBe(before + 1);
  }, 60_000);
});
