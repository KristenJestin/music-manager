import { describe, expect, it } from "vitest";
import { ID_PREFIXES, isId, newId, ulid } from "./ids.ts";

describe("ulid", () => {
  it("is 26 Crockford characters", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts chronologically as a plain string", () => {
    const early = ulid(1_600_000_000_000);
    const late = ulid(1_700_000_000_000);
    expect(early < late).toBe(true);
  });

  it("does not collide over a burst at the same millisecond", () => {
    const now = 1_700_000_000_000;
    const seen = new Set(Array.from({ length: 2000 }, () => ulid(now)));
    expect(seen.size).toBe(2000);
  });
});

describe("newId", () => {
  it("prefixes by kind", () => {
    expect(newId("import")).toMatch(/^imp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId("inboxItem").startsWith(`${ID_PREFIXES.inboxItem}_`)).toBe(true);
  });

  it("recognises its own ids and rejects a foreign one", () => {
    expect(isId("import", newId("import"))).toBe(true);
    expect(isId("import", newId("importTrack"))).toBe(false);
    expect(isId("import", "imp_short")).toBe(false);
  });
});
