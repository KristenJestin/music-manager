import { describe, expect, it } from "vitest";
import { toolboxHealthSchema, webHealthSchema } from "./index.ts";

describe("@mm/contracts", () => {
  it("accepts a web health payload", () => {
    expect(webHealthSchema.parse({ ok: true, version: "0.0.0" })).toEqual({
      ok: true,
      version: "0.0.0",
    });
  });

  it("rejects a web health payload with a missing version", () => {
    expect(webHealthSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("accepts null tool versions in the toolbox health payload", () => {
    const parsed = toolboxHealthSchema.parse({
      ok: true,
      fixtures: false,
      versions: { "yt-dlp": "2026.08.30", ffmpeg: "8.1", fpcalc: null, rsgain: null },
    });
    expect(parsed.versions.fpcalc).toBeNull();
  });
});
