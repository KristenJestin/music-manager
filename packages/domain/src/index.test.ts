import { describe, expect, it } from "vitest";
import { DOMAIN_SCHEMA_VERSION, domainInfo } from "./index.ts";

describe("@mm/domain", () => {
  it("reports its name and schema version", () => {
    expect(domainInfo()).toEqual({ name: "@mm/domain", schemaVersion: DOMAIN_SCHEMA_VERSION });
  });

  it("starts at schema version 1", () => {
    expect(DOMAIN_SCHEMA_VERSION).toBe(1);
  });
});
