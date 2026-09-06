import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigFile, resolveRemote } from "./remote.ts";

/**
 * How `mm` decides it is talking to somebody else.
 *
 * The precedence rule is the whole of it — flag, then environment, then file — and it is worth
 * pinning because getting it backwards produces the worst possible bug in this CLI: a command
 * meant for a remote server silently running against the local database.
 */

function withConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mm-config-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("readConfigFile", () => {
  it("reads a bare `key = value` file", () => {
    const path = withConfig(`url = "http://localhost:3600"\ntoken = "mm_abc"\n`);
    expect(readConfigFile(path)).toEqual({ url: "http://localhost:3600", token: "mm_abc" });
  });

  it("reads the `[default]` section, and skips any other", () => {
    const path = withConfig(
      `[default]\nurl = "http://a.test"\ntoken = "mm_a"\n\n[staging]\nurl = "http://b.test"\n`,
    );
    expect(readConfigFile(path)).toEqual({ url: "http://a.test", token: "mm_a" });
  });

  it("ignores comments, blank lines and keys it does not know", () => {
    const path = withConfig(
      `# my server\n\nurl = "http://a.test"\ncolour = "blue"\ntoken = 'mm_a'\n`,
    );
    expect(readConfigFile(path)).toEqual({ url: "http://a.test", token: "mm_a" });
  });

  it("returns nothing at all when the file is absent", () => {
    expect(readConfigFile(join(tmpdir(), "definitely-not-here", "config.toml"))).toEqual({});
  });
});

describe("resolveRemote", () => {
  it("stays local when nothing says otherwise", () => {
    expect(resolveRemote({}, {}, {})).toBeNull();
    expect(resolveRemote({ url: true }, {}, {})).toBeNull();
  });

  it("prefers the flag over the environment over the file", () => {
    const file = { url: "http://file.test", token: "mm_file" };
    const env = { MM_URL: "http://env.test", MM_TOKEN: "mm_env" };

    expect(resolveRemote({ url: "http://flag.test", token: "mm_flag" }, env, file)).toEqual({
      url: "http://flag.test",
      token: "mm_flag",
    });
    expect(resolveRemote({}, env, file)).toEqual({ url: "http://env.test", token: "mm_env" });
    expect(resolveRemote({}, {}, file)).toEqual({ url: "http://file.test", token: "mm_file" });
  });

  it("mixes the sources per field, so a file URL can take a flag token", () => {
    expect(resolveRemote({ token: "mm_flag" }, {}, { url: "http://file.test" })).toEqual({
      url: "http://file.test",
      token: "mm_flag",
    });
  });

  it("trims the trailing slash, so paths are never doubled", () => {
    expect(resolveRemote({ url: "http://a.test/" }, {}, {})?.url).toBe("http://a.test");
    expect(resolveRemote({ url: "http://a.test///" }, {}, {})?.url).toBe("http://a.test");
  });

  it("is still remote with a URL and no token", () => {
    // Deliberate: the 401 that follows says what is missing, which beats silently running
    // against the local database the caller was trying not to use.
    expect(resolveRemote({ url: "http://a.test" }, {}, {})).toEqual({
      url: "http://a.test",
      token: "",
    });
  });
});
