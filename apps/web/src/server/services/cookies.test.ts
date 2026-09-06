/**
 * The three cookie modes (owner review B6), and the promise that none of them leaks.
 */
import { describe, expect, it } from "vitest";
import { cookieJar, describe as describeJar, isMisconfigured } from "./cookies.ts";
import { defaults, type Settings } from "./settings.ts";

const JAR = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsecret-value\n";

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaults(), ...patch });

describe("cookieJar", () => {
  it("carries nothing at all in anonymous mode", () => {
    expect(cookieJar(settings())).toEqual({});
    expect(cookieJar(settings({ cookiesMode: "anonymous", cookiesText: JAR }))).toEqual({});
  });

  it("sends a path as a path", () => {
    const jar = cookieJar(settings({ cookiesMode: "file", cookiesFile: " /data/cookies.txt " }));
    expect(jar).toEqual({ path: "/data/cookies.txt" });
  });

  it("sends a pasted jar inline, because a server has no path into the container", () => {
    const jar = cookieJar(settings({ cookiesMode: "paste", cookiesText: JAR }));
    expect(jar).toEqual({ content: JAR });
    expect(jar.path).toBeUndefined();
  });

  it("treats a blank value in either mode as nothing configured", () => {
    expect(cookieJar(settings({ cookiesMode: "file", cookiesFile: "  " }))).toEqual({});
    expect(cookieJar(settings({ cookiesMode: "paste", cookiesText: " \n " }))).toEqual({});
  });
});

describe("isMisconfigured", () => {
  it("is false for anonymous, and true for a mode with nothing behind it", () => {
    expect(isMisconfigured(settings({ cookiesMode: "anonymous" }))).toBe(false);
    expect(isMisconfigured(settings({ cookiesMode: "file" }))).toBe(true);
    expect(isMisconfigured(settings({ cookiesMode: "paste" }))).toBe(true);
    expect(isMisconfigured(settings({ cookiesMode: "paste", cookiesText: JAR }))).toBe(false);
  });
});

describe("describe", () => {
  it("never says a cookie out loud", () => {
    const line = describeJar(settings({ cookiesMode: "paste", cookiesText: JAR }));
    expect(line).toBe("pasted jar: 2 line(s)");
    expect(line).not.toContain("SAPISID");
    expect(line).not.toContain("secret-value");
  });

  it("names the mode in the other two cases", () => {
    expect(describeJar(settings())).toContain("anonymous");
    expect(describeJar(settings({ cookiesMode: "file", cookiesFile: "/data/c.txt" }))).toContain(
      "/data/c.txt",
    );
    expect(describeJar(settings({ cookiesMode: "file" }))).toContain("no path configured");
  });
});
