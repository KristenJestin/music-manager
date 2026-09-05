/**
 * Fixture loading — **test support only**.
 *
 * The domain itself is pure: no network, no filesystem, no environment. Tests, on the other
 * hand, must read the recorded source responses of `../../fixtures/`, and this is the one
 * place that resolves their paths. Nothing under `src/` outside `*.test.ts` may import it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Absolute path of a file under `packages/domain/fixtures/`. */
export function fixturePath(relative: string): string {
  return resolve(PACKAGE_ROOT, "fixtures", relative);
}

/** Absolute path of a file under `packages/domain/golden/`. */
export function goldenPath(relative: string): string {
  return resolve(PACKAGE_ROOT, "golden", relative);
}

/** Read and parse a JSON fixture. The caller states the shape it expects. */
export function readFixture<T>(relative: string): T {
  return JSON.parse(readFileSync(fixturePath(relative), "utf8")) as T;
}
