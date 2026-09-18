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
import {
  adoptSourceOf,
  adoptUrlSchema,
  baseNameOf,
  isAdoptableUrl,
  MAX_ADOPT_URL_LENGTH,
  nameFromUrl,
  resolveSourcePath,
} from "./adopt.ts";

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

/**
 * The other half of the same door, for the kind that takes an address instead of a path.
 *
 * `resolveSourcePath` above stands between an HTTP body and `open(2)`; this stands between an
 * HTTP body and **yt-dlp**, which is a much larger surface than "fetch a web page". yt-dlp
 * speaks `file:`, and a `file:///etc/shadow` that merely had to *look* like a URL would
 * re-create, through the address field, exactly the file-read primitive the allow-list exists
 * to deny on the path field. So the test is about the schemes that must not get through, and
 * it is deliberately a **closed list**: the assertion is "anything not enumerated is refused",
 * not "these particular bad ones are refused".
 */
describe("isAdoptableUrl", () => {
  it("accepts the two schemes the toolbox is allowed to download from", () => {
    expect(isAdoptableUrl("https://www.youtube.com/watch?v=kJQP7kiw5Fk")).toBe(true);
    expect(isAdoptableUrl("http://media.example.test/song.opus")).toBe(true);
    // `fixture://` is how the offline E2E run and the integration tests reach this path
    // without a network. It is useless against a toolbox that is not in fixtures mode.
    expect(isAdoptableUrl("fixture://skinny-love")).toBe(true);
    expect(isAdoptableUrl("  https://youtu.be/abc  ")).toBe(true);
  });

  it("refuses every other scheme, which is the whole of the guard", () => {
    // The one that matters: yt-dlp would happily read this and we would tag and file it.
    expect(isAdoptableUrl("file:///etc/shadow")).toBe(false);
    expect(isAdoptableUrl("file://C:/Windows/System32/config/SAM")).toBe(false);
    expect(isAdoptableUrl("data:audio/opus;base64,AAAA")).toBe(false);
    expect(isAdoptableUrl("javascript:alert(1)")).toBe(false);
    expect(isAdoptableUrl("ftp://example.test/song.opus")).toBe(false);
    // Not a scheme at all — a bare path, which is the `path` kind's business and not this one.
    expect(isAdoptableUrl("/etc/shadow")).toBe(false);
    expect(isAdoptableUrl("D:\\Musique\\track.flac")).toBe(false);
    expect(isAdoptableUrl("")).toBe(false);
    expect(isAdoptableUrl("   ")).toBe(false);
  });

  it("refuses a NUL byte, which truncates inside the C library", () => {
    expect(isAdoptableUrl("https://example.test/a\0.opus")).toBe(false);
  });

  it("refuses an address longer than any real one", () => {
    expect(isAdoptableUrl(`https://example.test/${"a".repeat(MAX_ADOPT_URL_LENGTH)}`)).toBe(false);
  });

  it("is what the schema enforces, so the two can never drift apart", () => {
    // `/api/v1` and the Console spell this boundary with their own zod; the service applies
    // the schema below. They have to be one rule, so the schema is built from the predicate.
    expect(adoptUrlSchema.safeParse("file:///etc/shadow").success).toBe(false);
    expect(adoptUrlSchema.safeParse("https://youtu.be/abc").success).toBe(true);
    // …and the schema trims, so a pasted address with a stray space is not a refusal.
    expect(adoptUrlSchema.parse("  https://youtu.be/abc ")).toBe("https://youtu.be/abc");
  });
});

/**
 * A replacement download has no filename of its own, so one is derived from the address — and
 * it ends up in `ORIGINALFILENAME`, so it must be a name and never a path.
 */
describe("nameFromUrl", () => {
  it("uses the video id, which is what an ordinary download would have been called", () => {
    expect(nameFromUrl("https://www.youtube.com/watch?v=kJQP7kiw5Fk", ".opus")).toBe(
      "kJQP7kiw5Fk.opus",
    );
    expect(nameFromUrl("https://youtu.be/kJQP7kiw5Fk", ".opus")).toBe("kJQP7kiw5Fk.opus");
    // `v=` wins over the path, because `watch?list=…&v=…` has both and only one is the video.
    expect(nameFromUrl("https://www.youtube.com/watch?list=OLAK5uy_x&v=kJQP7kiw5Fk", ".m4a")).toBe(
      "kJQP7kiw5Fk.m4a",
    );
  });

  it("never produces a path, whatever the address contained", () => {
    // This string becomes a filename in a tag. A separator in it would be a directory.
    expect(nameFromUrl("https://example.test/a/b/../../etc/passwd", ".opus")).not.toContain("/");
    expect(nameFromUrl("https://example.test/a/b/../../etc/passwd", ".opus")).not.toContain("\\");
    expect(nameFromUrl("https://example.test/%2e%2e%2f%2e%2e%2fshadow", ".opus")).not.toContain(
      "/",
    );
  });

  it("degrades to a usable stem rather than to an empty one", () => {
    // An empty stem would reach `suffixOf` as `.opus`, which reads as a file with no name and
    // an extension — and would be refused for a file that is perfectly fine.
    expect(nameFromUrl("https://example.test", ".opus")).toBe("example.test.opus");
    expect(nameFromUrl("not a url at all", ".opus")).toBe("download.opus");
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

/**
 * The one decoder of the wire union, tested because four doors now call it.
 *
 * `POST /imports/{id}/tracks/{trackId}/file`, `POST /library/albums/{id}/missing/…/file`, the
 * two MCP tools and the Console's two server functions all hand it the same JSON shape. Each
 * of them used to restate the mapping inline, and that is exactly how the imports page came to
 * be missing the address form for a while: three copies, one of them older than the others.
 */
describe("adoptSourceOf", () => {
  it("passes a server path through unchanged", () => {
    expect(adoptSourceOf({ source: "path", path: "/music/03.flac" })).toEqual({
      kind: "path",
      path: "/music/03.flac",
    });
  });

  it("passes an address through unchanged", () => {
    expect(adoptSourceOf({ source: "url", url: "https://youtu.be/abc" })).toEqual({
      kind: "url",
      url: "https://youtu.be/abc",
    });
  });

  it("decodes an upload's base64 into the bytes it stands for", () => {
    const decoded = adoptSourceOf({
      source: "upload",
      filename: "03.flac",
      // "hello" — checked as bytes rather than as a round trip, because the failure this
      // guards against is a decoder that silently produces something plausible.
      content: "aGVsbG8=",
    });
    expect(decoded.kind).toBe("upload");
    if (decoded.kind !== "upload") return;
    expect(decoded.filename).toBe("03.flac");
    expect([...decoded.bytes]).toEqual([104, 101, 108, 108, 111]);
  });
});
