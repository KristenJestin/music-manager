/**
 * The allow-list, on its own, with no database and no toolbox.
 *
 * `resolveSourcePath` is the one function in this feature that stands between an HTTP body and
 * `open(2)`. Without it, `POST …/tracks/…/file {"path": "/etc/shadow"}` copies that file into
 * the library under a `.opus` name and hands it to the tagger, which reads it back. So it gets
 * a test that is about the *attacks* rather than about the happy path: `..`, a symlink out of
 * an allowed folder, a directory, an empty file, and a relative path.
 *
 * Real directories in the OS temp folder rather than a mocked `fs`, because two of the five
 * only exist at the filesystem level: `realpath` resolving a symlink and `resolve` collapsing
 * `..` are the things being tested, and a mock would be a restatement of the assumption.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MMError } from "@mm/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseNameOf, resolveSourcePath } from "./adopt.ts";

let root = "";
let allowed = "";
let secret = "";

/** The code `resolveSourcePath` refused with, or `"(allowed)"` when it did not refuse. */
function refusal(path: string, roots: readonly string[]): string {
  try {
    resolveSourcePath(path, roots);
    return "(allowed)";
  } catch (error) {
    return MMError.from(error).code;
  }
}

describe("resolveSourcePath", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mm-adopt-"));
    allowed = join(root, "allowed");
    secret = join(root, "secret");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(secret, { recursive: true });
    mkdirSync(join(allowed, "subfolder"), { recursive: true });
    writeFileSync(join(allowed, "track.opus"), "not really opus, but not empty either");
    writeFileSync(join(allowed, "subfolder", "deep.flac"), "bytes");
    writeFileSync(join(allowed, "empty.opus"), "");
    writeFileSync(join(secret, "passwords.txt"), "hunter2");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("allows a file inside an allowed root, at any depth", () => {
    expect(resolveSourcePath(join(allowed, "track.opus"), [allowed])).toContain("track.opus");
    expect(resolveSourcePath(join(allowed, "subfolder", "deep.flac"), [allowed])).toContain(
      "deep.flac",
    );
  });

  it("refuses a file outside every root", () => {
    expect(refusal(join(secret, "passwords.txt"), [allowed])).toBe("ADOPT_PATH_REFUSED");
  });

  it("refuses an empty allow-list", () => {
    expect(refusal(join(allowed, "track.opus"), [])).toBe("ADOPT_PATH_REFUSED");
  });

  it("collapses `..` before comparing, so a prefix cannot be walked out of", () => {
    // The string starts with an allowed root and names a file that is not in it. A naive
    // `startsWith` test passes this; `resolve` is what does not.
    const escape = join(allowed, "..", "secret", "passwords.txt");
    expect(refusal(escape, [allowed])).toBe("ADOPT_PATH_REFUSED");
  });

  it("follows symlinks before comparing, so one inside an allowed root cannot point out", () => {
    const link = join(allowed, "shortcut.opus");
    try {
      symlinkSync(join(secret, "passwords.txt"), link, "file");
    } catch {
      // Windows refuses a symlink without Developer Mode or elevation. The check itself is
      // platform-independent; skipping the *fixture* is honest, asserting nothing is not.
      return;
    }
    expect(refusal(link, [allowed])).toBe("ADOPT_PATH_REFUSED");
  });

  it("refuses a directory and an empty file, which are not tracks", () => {
    expect(refusal(join(allowed, "subfolder"), [allowed])).toBe("INVALID_INPUT");
    expect(refusal(join(allowed, "empty.opus"), [allowed])).toBe("INVALID_INPUT");
  });

  it("refuses a relative path rather than resolving it against the server's cwd", () => {
    expect(refusal("track.opus", [allowed])).toBe("INVALID_INPUT");
    expect(refusal("", [allowed])).toBe("INVALID_INPUT");
  });

  it("refuses a path with a NUL byte, which truncates inside the C library", () => {
    expect(refusal(`${join(allowed, "track.opus")}\0.png`, [allowed])).toBe("INVALID_INPUT");
  });

  it("says `not found`, not `refused`, for a missing file inside an allowed root", () => {
    // The distinction is safe to make here — the operator configured the root — and it is the
    // difference between "you mistyped it" and "ask for access".
    expect(refusal(join(allowed, "no-such-file.opus"), [allowed])).toBe("NOT_FOUND");
    // …and it must *not* be made outside, or the route becomes a filesystem oracle.
    expect(refusal(join(secret, "no-such-file.opus"), [allowed])).toBe("ADOPT_PATH_REFUSED");
  });
});

describe("baseNameOf", () => {
  it("keeps only the file's own name, whichever separator it arrived with", () => {
    expect(baseNameOf("D:\\Musique\\album\\03 Digital Love.flac")).toBe("03 Digital Love.flac");
    expect(baseNameOf("/srv/music/album/03.flac")).toBe("03.flac");
    expect(baseNameOf("03.flac")).toBe("03.flac");
    // An uploaded `filename` is attacker-controlled; only its basename is ever used, and the
    // destination name is the track id, so this is a second fence rather than the first.
    expect(baseNameOf("../../../etc/passwd")).toBe("passwd");
  });
});
