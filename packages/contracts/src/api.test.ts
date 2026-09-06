import { describe, expect, it } from "vitest";
import {
  API_RESOURCES,
  API_SCOPES,
  grants,
  isApiScope,
  parseScope,
  permissionsOf,
  SCOPE_DESCRIPTIONS,
  SCOPE_ORDER,
  scopesOf,
} from "./api.ts";

/**
 * The scope algebra.
 *
 * This is the whole of the API's authorisation model, and it is eleven strings and two
 * implications — so it is worth pinning every one of them rather than trusting that a `403`
 * somewhere in an E2E covers it. The implications are the interesting part: `*` grants
 * everything, `x:write` grants `x:read`, and **nothing else is implied**.
 */

describe("scopes", () => {
  it("names every resource × action pair, plus the wildcard", () => {
    expect(API_SCOPES).toHaveLength(API_RESOURCES.length * 2 + 1);
    expect(API_SCOPES).toContain("*");
    expect(API_SCOPES).toContain("imports:write");
    expect(API_SCOPES).toContain("library:read");
    // The five the phase spec names by hand must all exist.
    for (const named of [
      "imports:write",
      "library:read",
      "library:write",
      "review:write",
      "settings:write",
      "tools:write",
      "*",
    ]) {
      expect(isApiScope(named), named).toBe(true);
    }
  });

  it("documents every scope, and orders them all", () => {
    for (const scope of API_SCOPES) {
      expect(SCOPE_DESCRIPTIONS[scope]?.length ?? 0, scope).toBeGreaterThan(10);
    }
    expect([...SCOPE_ORDER].sort()).toEqual([...API_SCOPES].sort());
  });

  it("splits a scope, and refuses nonsense", () => {
    expect(parseScope("library:read")).toEqual({ resource: "library", action: "read" });
    expect(parseScope("*")).toBeNull();
    expect(parseScope("library")).toBeNull();
    expect(parseScope("library:destroy")).toBeNull();
    expect(parseScope("wardrobe:read")).toBeNull();
  });
});

describe("grants", () => {
  it("gives the wildcard everything", () => {
    for (const scope of API_SCOPES) {
      expect(grants(["*"], scope), scope).toBe(true);
    }
  });

  it("lets write imply read, but never the other way round", () => {
    expect(grants(["library:write"], "library:read")).toBe(true);
    expect(grants(["library:read"], "library:write")).toBe(false);
  });

  it("does not leak across resources", () => {
    expect(grants(["library:write"], "settings:read")).toBe(false);
    expect(grants(["imports:write"], "library:read")).toBe(false);
    // The case the acceptance criteria names: a key without `imports:write` may not import.
    expect(grants(["library:read"], "imports:write")).toBe(false);
  });

  it("refuses everything to a key with no scopes", () => {
    for (const scope of API_SCOPES) {
      expect(grants([], scope), scope).toBe(false);
    }
  });

  it("only grants `*` to a holder of `*`", () => {
    expect(grants(["settings:write", "library:write"], "*")).toBe(false);
    expect(grants(["*"], "*")).toBe(true);
  });
});

describe("the Better Auth permission shape", () => {
  it("expands the wildcard, because the plugin does not understand it", () => {
    const permissions = permissionsOf(["*"]);
    expect(Object.keys(permissions).sort()).toEqual([...API_RESOURCES].sort());
    for (const resource of API_RESOURCES) {
      expect(permissions[resource]?.sort()).toEqual(["read", "write"]);
    }
  });

  it("round-trips a partial grant", () => {
    const scopes = ["imports:write", "library:read"];
    expect(permissionsOf(scopes)).toEqual({ imports: ["write"], library: ["read"] });
    expect(scopesOf(permissionsOf(scopes)).sort()).toEqual(scopes.sort());
  });

  it("folds a complete grant back into the `*` the user ticked", () => {
    expect(scopesOf(permissionsOf(["*"]))).toEqual(["*"]);
  });

  it("treats a missing or unparseable permission set as no scopes at all", () => {
    expect(scopesOf(null)).toEqual([]);
    expect(scopesOf(undefined)).toEqual([]);
    expect(scopesOf({})).toEqual([]);
  });

  it("drops a scope it does not recognise rather than storing it", () => {
    expect(permissionsOf(["library:read", "wardrobe:burn"])).toEqual({ library: ["read"] });
  });
});
