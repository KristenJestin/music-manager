/**
 * The MCP tool table, checked as *data* — no database, no toolbox, no server.
 *
 * Every assertion here corresponds to a numbered finding of
 * `orchestration/feedback/2026-09-06-mcp-test-report.md`. They are input-schema and
 * description tests on purpose: an agent never sees the implementation, it sees the schema and
 * the sentence, and three of the report's findings (§1 `releaseMbid`, §6 `status`, §18
 * `fixture://`) were failures of exactly those two things.
 *
 * The behaviour behind the schemas is covered by `mcp.integration.test.ts`, which needs a real
 * stack and skips itself without one.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolTable } from "./server.ts";

const tools = toolTable();
const byName = new Map(tools.map((tool) => [tool.name, tool]));

function schemaOf(name: string): Record<string, z.ZodType> {
  const tool = byName.get(name);
  if (tool === undefined) throw new Error(`no MCP tool named ${name}`);
  return tool.inputSchema;
}

function parse(name: string, value: Record<string, unknown>): z.ZodSafeParseResult<unknown> {
  return z.object(schemaOf(name)).safeParse(value);
}

describe("the tool table", () => {
  it("registers every tool once, with a scope and a description", () => {
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.scope, tool.name).toMatch(/^(?:\*|imports|library|review|settings|tools):/);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });

  it("carries the tools the two reports asked for (§9, §10, §11 and E)", () => {
    for (const name of ["get_status", "discover_sync", "scan", "relocate", "get_scan_report"]) {
      expect(byName.has(name), name).toBe(true);
    }
  });

  it("agrees with the count docs/06-stack.md publishes", () => {
    // Bump both together, or an agent reads a number that is not true.
    expect(tools.length).toBe(20);
  });
});

/* ------------------------------------------------------------------ */

describe("§1 — confirm_mapping validates its input", () => {
  const valid = {
    importId: "imp_1",
    releaseMbid: "8f5d1c4a-0f4c-4b03-9d5f-2a2e4d2a3f11",
    bindings: [{ position: 0, trackPosition: 1, recordingMbid: null }],
  };

  it("accepts a real MBID and `null`", () => {
    expect(parse("confirm_mapping", valid).success).toBe(true);
    expect(parse("confirm_mapping", { ...valid, releaseMbid: null }).success).toBe(true);
  });

  it("refuses a releaseMbid that is not a UUID", () => {
    // The exact value from the report, which was persisted verbatim into `imports.release_mbid`.
    expect(parse("confirm_mapping", { ...valid, releaseMbid: "null-pas-un-mbid" }).success).toBe(
      false,
    );
  });

  it("refuses a recordingMbid that is not a UUID", () => {
    const bad = { ...valid, bindings: [{ position: 0, trackPosition: 1, recordingMbid: "nope" }] };
    expect(parse("confirm_mapping", bad).success).toBe(false);
  });

  it("has a `force` flag, and it defaults to false", () => {
    const parsed = z.object(schemaOf("confirm_mapping")).parse(valid) as { force: boolean };
    expect(parsed.force).toBe(false);
  });

  it("says in its description that it is destructive on a finished import", () => {
    const text = byName.get("confirm_mapping")?.description ?? "";
    expect(text).toContain("force: true");
    expect(text.toLowerCase()).toContain("destructive");
    // §2: the provenance claim must be the one the code actually writes.
    expect(text).toContain("decidedBy: mcp");
  });
});

/* ------------------------------------------------------------------ */

describe("§6 — list_imports has a closed status vocabulary", () => {
  it("accepts a real status", () => {
    expect(parse("list_imports", { status: "awaiting_review", limit: 5 }).success).toBe(true);
  });

  it("refuses an unknown one before any SQL exists to leak", () => {
    const result = parse("list_imports", { status: "totalement_bidon", limit: 5 });
    expect(result.success).toBe(false);
    // Whatever it says, it must not be able to say it by quoting a query.
    expect(JSON.stringify(result.error?.issues ?? [])).not.toContain("select");
  });
});

/* ------------------------------------------------------------------ */

describe("§8 — get_candidates can be asked for less", () => {
  it("defaults to summary", () => {
    const parsed = z.object(schemaOf("get_candidates")).parse({ importId: "imp_1" }) as {
      detail: string;
      limit: number;
    };
    expect(parsed.detail).toBe("summary");
    expect(parsed.limit).toBe(12);
  });

  it("accepts full, and nothing else", () => {
    expect(parse("get_candidates", { importId: "i", detail: "full" }).success).toBe(true);
    expect(parse("get_candidates", { importId: "i", detail: "verbose" }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("§18 — create_import is honest about fixture:// URLs", () => {
  it("says the fixtures scheme needs fixtures mode, and where to check", () => {
    const text = byName.get("create_import")?.description ?? "";
    expect(text).toContain("fixtures mode");
    expect(text).toContain("get_status");
  });

  it("validates releaseMbid as a UUID here too", () => {
    expect(parse("create_import", { url: "fixture://discovery", releaseMbid: "x" }).success).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("§10 / §11 — the new tools declare and document their scope", () => {
  it("discover_sync writes library data, so library:write", () => {
    expect(byName.get("discover_sync")?.scope).toBe("library:write");
    expect(byName.get("discover_sync")?.description).toContain("library:write");
  });

  it("scan is an operation on the installation, so tools:write", () => {
    expect(byName.get("scan")?.scope).toBe("tools:write");
    expect(byName.get("scan")?.description).toContain("tools:write");
  });

  it("relocate warns about Navidrome's play counts and defaults to a dry run", () => {
    const tool = byName.get("relocate");
    expect(tool?.scope).toBe("library:write");
    expect(tool?.description).toContain("play count");
    const parsed = z.object(schemaOf("relocate")).parse({}) as { dryRun: boolean };
    expect(parsed.dryRun).toBe(true);
  });

  it("get_status is readable with a read-only key", () => {
    expect(byName.get("get_status")?.scope).toBe("tools:read");
  });
});
