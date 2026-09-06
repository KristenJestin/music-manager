/**
 * The diagnostics, with every outward call injected.
 *
 * The property that matters here is not what any one probe returns — it is that **nothing
 * throws**. A Tools page that raises because MusicBrainz timed out replaces the diagnostics
 * with the failure they were meant to explain, so every function is asserted to come back
 * with a result even when the thing behind it is on fire.
 */
import { describe, expect, it } from "vitest";
import { MMError } from "@mm/contracts";
import { TOOLBOX_CONTRACT_HASH, TOOLBOX_SCHEMA_VERSION } from "@mm/contracts/toolbox/contract";
import type { ToolboxClient } from "#/server/toolbox/client.ts";
import { defaults, type Settings } from "./settings.ts";
import {
  compareContract,
  cookiesStatus,
  downloaderHealth,
  serviceLatencies,
  testUrl,
} from "./tools.ts";

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaults(), ...patch });

/** Just enough of the toolbox client for one function under test. */
const fakeToolbox = (methods: Partial<ToolboxClient>): ToolboxClient =>
  ({ baseUrl: "http://toolbox.test", ...methods }) as ToolboxClient;

const jsonResponse = (status = 200): Response =>
  new Response("{}", { status, headers: { "content-type": "application/json" } });

/*
 * The failure that opened both MCP test reports: a container older than the code calling it.
 * Everything else about it looks healthy — it answers, it has its four binaries — and the only
 * symptom is a 422 on a field its pydantic models have never heard of, which reads as a bug in
 * the app. These three cases are the whole of the detection.
 */
describe("compareContract", () => {
  it("matches when the image implements the contract this code was generated against", () => {
    const verdict = compareContract({
      schema_version: TOOLBOX_SCHEMA_VERSION,
      contract_hash: TOOLBOX_CONTRACT_HASH,
    });
    expect(verdict.matches).toBe(true);
    expect(verdict.note).toBe("");
    expect(verdict.actual).toBe(TOOLBOX_CONTRACT_HASH);
  });

  it("calls a different hash a stale image, and names the rebuild", () => {
    const verdict = compareContract({
      schema_version: TOOLBOX_SCHEMA_VERSION,
      contract_hash: "0000000000000000",
    });
    expect(verdict.matches).toBe(false);
    expect(verdict.note).toContain("stack:up --build");
    expect(verdict.note).toContain("extra_forbidden");
  });

  it("treats an image that reports no contract at all as stale", () => {
    // Every image built before this check existed — including the one that produced the
    // original `UNKNOWN / 500` in the report, which `get_status` called healthy.
    const verdict = compareContract({});
    expect(verdict.matches).toBe(false);
    expect(verdict.actual).toBe(null);
    expect(verdict.note).toContain("does not report a contract hash");
  });

  it("refuses to judge across contract-statement versions rather than guessing", () => {
    const verdict = compareContract({
      schema_version: TOOLBOX_SCHEMA_VERSION + 1,
      contract_hash: "0000000000000000",
    });
    // Two hashes from two algorithms are not comparable; reporting a difference would send
    // somebody to rebuild an image that is perfectly current.
    expect(verdict.matches).toBe(true);
    expect(verdict.note).toContain("not comparable");
  });
});

describe("downloaderHealth", () => {
  it("reports the versions and the settings that steer them", async () => {
    const health = await downloaderHealth({
      settings: settings({ ytdlpChannel: "nightly", ytdlpPin: "2026.08.14" }),
      toolbox: fakeToolbox({
        health: () =>
          Promise.resolve({
            ok: true,
            fixtures: false,
            downloading: false,
            versions: {
              "yt-dlp": "2026.08.14",
              ffmpeg: "7.1.1",
              fpcalc: "1.5.1",
              rsgain: "3.5",
            },
            // A live toolbox states which contract it implements; `downloaderHealth` compares
            // it with the one the client was generated from. An image that reports neither is
            // an image built before the check existed — covered separately below.
            schema_version: TOOLBOX_SCHEMA_VERSION,
            contract_hash: TOOLBOX_CONTRACT_HASH,
          }),
      }),
    });
    expect(health.reachable).toBe(true);
    expect(health.versions["yt-dlp"]).toBe("2026.08.14");
    expect(health.channel).toBe("nightly");
    expect(health.pin).toBe("2026.08.14");
    expect(health.error).toBe(null);
    expect(health.contract?.matches).toBe(true);
    expect(health.contract?.note).toBe("");
  });

  it("comes back with `reachable: false` rather than throwing when the toolbox is down", async () => {
    const health = await downloaderHealth({
      settings: settings(),
      toolbox: fakeToolbox({
        health: () => Promise.reject(new MMError("TOOLBOX_UNREACHABLE", "nothing is listening")),
      }),
    });
    expect(health.reachable).toBe(false);
    expect(health.error).toContain("nothing is listening");
    expect(health.versions["yt-dlp"]).toBe(null);
  });
});

describe("cookiesStatus", () => {
  it("calls anonymous a mode, not a problem", async () => {
    const status = await cookiesStatus({ settings: settings({ cookiesMode: "anonymous" }) });
    expect(status.ok).toBe(true);
    expect(status.problems).toEqual([]);
    expect(status.note).toContain("Anonymous");
  });

  it("flags a cookie mode with no file behind it", async () => {
    const status = await cookiesStatus({
      settings: settings({ cookiesMode: "file", cookiesFile: "" }),
    });
    expect(status.ok).toBe(false);
    expect(status.problems[0]).toContain("No cookies.txt path");
  });

  it("passes the toolbox's verdict through when there is a file", async () => {
    const status = await cookiesStatus({
      settings: settings({ cookiesMode: "file", cookiesFile: "/data/cookies.txt" }),
      toolbox: fakeToolbox({
        testCookies: () =>
          Promise.resolve({
            ok: true,
            cookies: 12,
            domains: [".youtube.com"],
            authenticated: true,
            expires_at: "2026-10-01T00:00:00Z",
            expired: 0,
            problems: [],
          }),
      }),
    });
    expect(status.ok).toBe(true);
    expect(status.cookies).toBe(12);
    expect(status.expiresAt).toBe("2026-10-01T00:00:00Z");
  });

  it("turns an unreadable file into a problem, not an exception", async () => {
    const status = await cookiesStatus({
      settings: settings({ cookiesMode: "file", cookiesFile: "/nope.txt" }),
      toolbox: fakeToolbox({
        testCookies: () => Promise.reject(new MMError("UNKNOWN", "No such file")),
      }),
    });
    expect(status.ok).toBe(false);
    expect(status.problems[0]).toContain("No such file");
  });
});

describe("serviceLatencies", () => {
  it("probes every enabled source once and reports a latency", async () => {
    const seen: string[] = [];
    const results = await serviceLatencies({
      settings: settings(),
      fetch: (url) => {
        seen.push(new URL(url).host);
        return Promise.resolve(jsonResponse());
      },
    });
    expect(results).toHaveLength(7);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(seen).toContain("musicbrainz.org");
    expect(seen).toContain("lrclib.net");
    // One call per source and no more: this page must not spend a rate limit.
    expect(seen).toHaveLength(7);
  });

  it("does not call a source that is switched off", async () => {
    const seen: string[] = [];
    const results = await serviceLatencies({
      settings: settings({ sourcesEnabled: { ...defaults().sourcesEnabled, deezer: false } }),
      fetch: (url) => {
        seen.push(new URL(url).host);
        return Promise.resolve(jsonResponse());
      },
    });
    expect(seen.some((host) => host.includes("deezer"))).toBe(false);
    const deezer = results.find((result) => result.name === "deezer");
    expect(deezer?.enabled).toBe(false);
    expect(deezer?.note).toBe("disabled in settings");
  });

  it("accepts a 4xx from the probes whose endpoint answers without a key", async () => {
    const results = await serviceLatencies({
      settings: settings(),
      fetch: () => Promise.resolve(jsonResponse(400)),
    });
    const byName = new Map(results.map((result) => [result.name, result]));
    // A 400 from AcoustID proves the host answered; a 400 from LRCLIB does not.
    expect(byName.get("acoustid")?.ok).toBe(true);
    expect(byName.get("lrclib")?.ok).toBe(false);
  });

  it("reports an unreachable host as a row, never as a rejection", async () => {
    const results = await serviceLatencies({
      settings: settings(),
      fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    });
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results[0]?.error).toContain("ENOTFOUND");
  });
});

describe("testUrl", () => {
  it("summarises what the URL resolves to", async () => {
    const result = await testUrl("fixture://discovery", {
      settings: settings(),
      toolbox: fakeToolbox({
        extract: () =>
          Promise.resolve({
            kind: "album",
            title: "Discovery",
            url: "fixture://discovery",
            uploader: null,
            entries: [
              { id: "a", title: "One More Time", url: "u", duration: 320, uploader: null, raw: {} },
              { id: "b", title: "Aerodynamic", url: "u", duration: 212, uploader: null, raw: {} },
            ],
          } as never),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(2);
    expect(result.sample[0]?.title).toBe("One More Time");
  });

  it("decodes a failure into the code, the hint and the button", async () => {
    const result = await testUrl("https://youtube.com/watch?v=x", {
      settings: settings(),
      toolbox: fakeToolbox({
        extract: () =>
          Promise.reject(
            new MMError(
              "YTDLP_BOT_CHECK",
              "YouTube asked this client to confirm it is not a bot.",
              {
                hint: "YouTube challenges anonymous or datacenter IPs.",
                action: "Configure cookies",
              },
            ),
          ),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      code: "YTDLP_BOT_CHECK",
      message: "YouTube asked this client to confirm it is not a bot.",
      hint: "YouTube challenges anonymous or datacenter IPs.",
      action: "Configure cookies",
    });
  });
});
