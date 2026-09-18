import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiClient } from "./remote.ts";
import { runRemote, type RemoteArgs } from "./remote-commands.ts";

/**
 * The remote half of the album-holes commands, checked as *requests*.
 *
 * The rule the whole feature is built to is that a gesture exists in the interface and in the
 * API both, and `mm --url … library missing|adopt` is the third leg of that: somebody driving a
 * deployed installation from his own machine finds an album with holes in it from a terminal
 * and wants to fix it from the same terminal. A command that works locally and not remotely is
 * precisely the half-function the rule forbids.
 *
 * What is asserted is the **verb, the path and the body** — not the printed output. Those three
 * are the contract with `/api/v1`, and they are what silently rots when a route's shape moves:
 * the far end answers 400 and the CLI reports it as somebody else's fault. The printing is the
 * local command's printing, copied deliberately, and it has no contract to break.
 *
 * `request` is stubbed rather than `fetch`, because `request` is the single seam every verb on
 * `ApiClient` funnels through, so one recorder sees `get`, `post` and the query string alike.
 */

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

/** An `ApiClient` that records instead of sending, and answers with `reply`. */
function recorder(reply: unknown): { api: ApiClient; sent: Sent[] } {
  const api = new ApiClient({ url: "http://far.test", token: "mm_test" });
  const sent: Sent[] = [];
  api.request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    sent.push({ method, path, ...(body === undefined ? {} : { body }) });
    return await Promise.resolve(reply as T);
  };
  return { api, sent };
}

function args(positional: string[], flags: Record<string, string | boolean> = {}): RemoteArgs {
  return { positional, flags: { json: true, ...flags } };
}

const MISSING_REPLY = {
  releaseMbid: "6c6974d0-f7b2-4ee1-acfc-37d2723f00d3",
  trackCount: 20,
  presentCount: 16,
  mediumCount: 1,
  unavailable: null,
  missing: [{ mediumPosition: 1, trackPosition: 2, title: "Route 66", artist: "Chuck Berry" }],
};

const ADOPT_REPLY = {
  trackTitle: "Route 66",
  mediumPosition: 1,
  trackPosition: 2,
  path: ".mm-work/imp_x/itr_y.opus",
  bytes: 1024,
  codec: "opus",
  originalName: "route-66.opus",
  materialised: true,
  nextStep: "fingerprint",
  queued: true,
  counters: { presentCount: 16, trackCount: 20 },
};

describe("mm --url … library missing", () => {
  it("reads the album's holes from the route the local command's service backs", async () => {
    const { api, sent } = recorder(MISSING_REPLY);
    expect(await runRemote(api, args(["library", "missing", "alb_1"]))).toBe(0);
    expect(sent).toEqual([{ method: "GET", path: "/library/albums/alb_1/missing" }]);
  });

  it("refuses without an album id rather than listing somebody else's album", async () => {
    const { api, sent } = recorder(MISSING_REPLY);
    await expect(runRemote(api, args(["library", "missing"]))).rejects.toThrow(/usage/);
    expect(sent).toEqual([]);
  });
});

describe("mm --url … library adopt", () => {
  it("puts the couple in the path, in order, disc first", async () => {
    // The whole point of the two numbers: every medium restarts at 1, so `2/7` and `1/27` are
    // different tracks and a flat index addresses the wrong one.
    const { api, sent } = recorder(ADOPT_REPLY);
    await runRemote(
      api,
      args(["library", "adopt", "alb_1", "2", "7"], { "from-url": "https://a.test/x" }),
    );
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.path).toBe("/library/albums/alb_1/missing/2/7/file");
  });

  it("sends an address as `source: url`", async () => {
    const { api, sent } = recorder(ADOPT_REPLY);
    await runRemote(
      api,
      args(["library", "adopt", "alb_1", "1", "2"], { "from-url": "https://a.test/x" }),
    );
    expect(sent[0]?.body).toEqual({ source: "url", url: "https://a.test/x" });
  });

  it("sends a far-end path as `source: path`, with no bytes at all", async () => {
    const { api, sent } = recorder(ADOPT_REPLY);
    await runRemote(
      api,
      args(["library", "adopt", "alb_1", "1", "2"], { "server-path": "/music/02.flac" }),
    );
    expect(sent[0]?.body).toEqual({ source: "path", path: "/music/02.flac" });
  });

  it("reads a local file and uploads it, base64, under its own basename", async () => {
    /*
     * The default is the opposite of the local command's, deliberately: remote mode is the case
     * where the file and the library really are on two machines, so `--file` means *here*.
     */
    const dir = mkdtempSync(join(tmpdir(), "mm-remote-"));
    const file = join(dir, "02 Route 66.opus");
    writeFileSync(file, "hello");

    const { api, sent } = recorder(ADOPT_REPLY);
    await runRemote(api, args(["library", "adopt", "alb_1", "1", "2"], { file }));
    expect(sent[0]?.body).toEqual({
      source: "upload",
      filename: "02 Route 66.opus",
      // "hello" — the bytes, not a plausible-looking string.
      content: "aGVsbG8=",
    });
  });

  it("refuses two sources rather than quietly preferring one", async () => {
    // Silently ignoring one of two supplied sources is how somebody uploads a file and
    // believes they adopted a different one.
    const { api, sent } = recorder(ADOPT_REPLY);
    await expect(
      runRemote(
        api,
        args(["library", "adopt", "alb_1", "1", "2"], {
          "from-url": "https://a.test/x",
          "server-path": "/music/02.flac",
        }),
      ),
    ).rejects.toThrow(/usage/);
    expect(sent).toEqual([]);
  });

  it("refuses no source at all", async () => {
    const { api, sent } = recorder(ADOPT_REPLY);
    await expect(runRemote(api, args(["library", "adopt", "alb_1", "1", "2"]))).rejects.toThrow(
      /usage/,
    );
    expect(sent).toEqual([]);
  });

  it("refuses a position that is not a number, rather than posting `NaN` in the path", async () => {
    const { api, sent } = recorder(ADOPT_REPLY);
    await expect(
      runRemote(
        api,
        args(["library", "adopt", "alb_1", "1", "side-b"], { "from-url": "https://a.test" }),
      ),
    ).rejects.toThrow(/usage/);
    expect(sent).toEqual([]);
  });
});

describe("mm --url … adopt", () => {
  it("gained the address form too, so the three doors offer the same three ways", async () => {
    const { api, sent } = recorder({ path: "p", bytes: 1, codec: null, originalName: "n" });
    await runRemote(api, args(["adopt", "imp_1", "itr_1"], { "from-url": "https://a.test/x" }));
    expect(sent[0]?.path).toBe("/imports/imp_1/tracks/itr_1/file");
    expect(sent[0]?.body).toEqual({ source: "url", url: "https://a.test/x" });
  });
});

/**
 * The printed forms, exercised at least once each.
 *
 * Every test above passes `--json`, which is the agent's path and the one with a contract. A
 * person gets the columns, and a column built with `padEnd` over a value that turned out to be
 * `null` throws — so the human path gets a run too, asserting only that it completes.
 */
describe("the printed forms", () => {
  it("prints the missing tracks as columns", async () => {
    const { api } = recorder(MISSING_REPLY);
    expect(await runRemote(api, { positional: ["library", "missing", "alb_1"], flags: {} })).toBe(
      0,
    );
  });

  it("prints a two-disc album with its disc column", async () => {
    const { api } = recorder({
      ...MISSING_REPLY,
      mediumCount: 2,
      missing: [{ mediumPosition: 2, trackPosition: 1, title: "B1", artist: null }],
    });
    expect(await runRemote(api, { positional: ["library", "missing", "alb_1"], flags: {} })).toBe(
      0,
    );
  });

  it("says why it cannot answer, instead of printing an empty list", async () => {
    // "nothing printed" and "nothing is missing" look identical on a terminal, and only one of
    // them is good news.
    for (const unavailable of ["no-release", "not-cached"]) {
      const { api } = recorder({ ...MISSING_REPLY, unavailable, missing: [] });
      expect(await runRemote(api, { positional: ["library", "missing", "alb_1"], flags: {} })).toBe(
        0,
      );
    }
  });

  it("prints what an adoption did", async () => {
    const { api } = recorder(ADOPT_REPLY);
    expect(
      await runRemote(api, {
        positional: ["library", "adopt", "alb_1", "1", "2"],
        flags: { "from-url": "https://a.test/x" },
      }),
    ).toBe(0);
  });
});

/**
 * The flag is `--from-url`, and that is not a style choice.
 *
 * `--url` is how this CLI is pointed at the installation it is talking to, and it is read
 * *before* the command name. `mm --url https://mine library adopt … --url https://youtu.be/…`
 * names two installations and never reaches the command at all — so a `--url` here would be a
 * flag that cannot work, in the one mode it exists for.
 */
describe("--from-url, never --url", () => {
  it("does not read `--url` as an address", async () => {
    const { api, sent } = recorder(ADOPT_REPLY);
    await expect(
      runRemote(api, args(["library", "adopt", "alb_1", "1", "2"], { url: "https://a.test/x" })),
    ).rejects.toThrow(/usage/);
    expect(sent).toEqual([]);
  });

  it("says so in the usage, so the reader is not left guessing", async () => {
    const { api } = recorder(ADOPT_REPLY);
    await expect(runRemote(api, args(["library", "adopt", "alb_1", "1", "2"]))).rejects.toThrow(
      /`--from-url`, never `--url`/,
    );
  });
});
