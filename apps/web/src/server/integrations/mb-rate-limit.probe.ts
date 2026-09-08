#!/usr/bin/env bun
/**
 * One of the two processes of `mb-rate-limit.integration.test.ts`. Not a test itself.
 *
 * It exists because the claim being proven — "the whole installation sends one MusicBrainz
 * request per second, not one per process" — cannot be stated inside a single process. Two
 * coroutines sharing a module-level limiter would pass the old code too; that is exactly the
 * bug. So the test spawns this file twice, each copy opens its **own** database handle, and
 * both hammer a stub MusicBrainz that records when each request arrived.
 *
 * Usage: `bun run <this file> <baseUrl> <count>`, with `DATABASE_URL` in the environment.
 * It prints nothing on success; the proof is on the server's side of the wire.
 */
import { createDatabase } from "#/server/db/client.ts";
import { getJson } from "./http.ts";
import { gateFor } from "./rate-gate.ts";
import { MB_MIN_INTERVAL_MS } from "./musicbrainz.ts";

const baseUrl = process.argv[2] ?? "";
const count = Number(process.argv[3] ?? "3");
const label = process.argv[4] ?? "probe";

if (baseUrl === "") {
  console.error("usage: mb-rate-limit.probe.ts <baseUrl> <count> [label]");
  process.exit(2);
}

const db = createDatabase(process.env["DATABASE_URL"] ?? "", 1);
const gate = gateFor(db, "musicbrainz", MB_MIN_INTERVAL_MS);

for (let n = 0; n < count; n += 1) {
  await getJson({
    source: "musicbrainz",
    url: `${baseUrl}/ws/2/release?probe=${label}&n=${String(n)}`,
    minIntervalMs: MB_MIN_INTERVAL_MS,
    gate,
    // One attempt: a retry would space itself and hide a limiter that does not.
    attempts: 1,
  });
}

process.exit(0);
