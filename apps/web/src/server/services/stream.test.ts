/**
 * `/api/stream`, minus the session and the database.
 *
 * The three properties worth a test are the three that are easy to get subtly wrong and
 * impossible to notice by clicking: a seek is a `Range` request and must come back as a 206
 * with a `Content-Range`, a path out of the library must be refused whatever it is spelled
 * like, and an id nobody knows must be a 404 rather than a 500.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pathMap } from "#/server/paths.ts";
import {
  audioContentType,
  parseRange,
  resolveInLibrary,
  streamResponse,
  type StreamFile,
} from "#/server/services/stream.ts";

let root: string;
let file: string;
/** Sixteen kilobytes of nothing in particular: enough to ask for a slice out of the middle. */
const SIZE = 16_384;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mm-stream-"));
  file = join(root, "track.opus");
  writeFileSync(file, Buffer.alloc(SIZE, 7));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function target(): StreamFile {
  return { file, contentType: "audio/ogg" };
}

function request(headers: Record<string, string> = {}, id = "trk_1"): Request {
  return new Request(`http://localhost/api/stream?track=${id}`, { headers });
}

describe("content types", () => {
  it("calls an Opus file audio/ogg, because that is the container", () => {
    expect(audioContentType("Daft Punk/Discovery/01 One More Time.opus")).toBe("audio/ogg");
  });

  it("knows the other three formats the library holds", () => {
    expect(audioContentType("a.flac")).toBe("audio/flac");
    expect(audioContentType("a.mp3")).toBe("audio/mpeg");
    expect(audioContentType("a.m4a")).toBe("audio/mp4");
  });

  it("does not guess about something it has never seen", () => {
    expect(audioContentType("a.xyz")).toBe("application/octet-stream");
    expect(audioContentType("no-extension")).toBe("application/octet-stream");
  });
});

describe("parseRange", () => {
  it("reads a closed interval, an open one, and a suffix", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end past the file rather than refusing it", () => {
    expect(parseRange("bytes=900-99999", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("says undefined for no range and for anything it will not parse", () => {
    expect(parseRange(null, 1000)).toBeUndefined();
    expect(parseRange("", 1000)).toBeUndefined();
    // A multi-range request: answered as a whole file rather than as a wrong multipart body.
    expect(parseRange("bytes=0-99,200-299", 1000)).toBeUndefined();
  });

  it("says null for a range the file cannot satisfy", () => {
    expect(parseRange("bytes=2000-", 1000)).toBeNull();
    expect(parseRange("bytes=500-100", 1000)).toBeNull();
  });
});

describe("resolveInLibrary", () => {
  const map = pathMap({ host: resolve("/library-root"), container: "/library" });

  it("resolves an ordinary library-relative path", () => {
    expect(resolveInLibrary(map, "Daft Punk/Discovery/01.opus")).not.toBeNull();
  });

  it("refuses every way out of the library", () => {
    expect(resolveInLibrary(map, "../../etc/passwd")).toBeNull();
    expect(resolveInLibrary(map, "Daft Punk/../../../etc/passwd")).toBeNull();
    expect(resolveInLibrary(map, "..\\..\\Windows\\win.ini")).toBeNull();
    expect(resolveInLibrary(map, "/etc/passwd")).toBeNull();
    expect(resolveInLibrary(map, "C:/Windows/win.ini")).toBeNull();
    expect(resolveInLibrary(map, "//server/share/file.mp3")).toBeNull();
    expect(resolveInLibrary(map, "")).toBeNull();
  });

  it("refuses the library root itself, which is a directory and not a track", () => {
    expect(resolveInLibrary(map, ".")).toBeNull();
  });
});

describe("streamResponse", () => {
  const found = (): Promise<StreamFile | null> => Promise.resolve(target());
  const missing = (): Promise<StreamFile | null> => Promise.resolve(null);

  it("answers a range request with 206 and the right headers", async () => {
    const response = await streamResponse(
      request({ range: "bytes=1024-2047" }),
      async () => await found(),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 1024-2047/${String(SIZE)}`);
    expect(response.headers.get("content-length")).toBe("1024");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("audio/ogg");
    expect((await response.arrayBuffer()).byteLength).toBe(1024);
  });

  it("answers the whole file with 200 when nothing was asked for", async () => {
    const response = await streamResponse(request(), async () => await found());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("answers 416 for a range past the end of the file", async () => {
    const response = await streamResponse(
      request({ range: `bytes=${String(SIZE + 10)}-` }),
      async () => await found(),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${String(SIZE)}`);
  });

  it("answers 404 for an id nothing resolves", async () => {
    const response = await streamResponse(request({}, "trk_nope"), async () => await missing());
    expect(response.status).toBe(404);
  });

  it("answers 400 when no track was named", async () => {
    const bare = new Request("http://localhost/api/stream");
    const response = await streamResponse(bare, async () => await found());
    expect(response.status).toBe(400);
  });
});
