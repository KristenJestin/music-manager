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
    for (const name of [
      "get_status",
      "discover_sync",
      "scan",
      "relocate",
      "get_scan_report",
      // `cron.refresh-sources` had no trigger at all before: no tool, no route, no command.
      "refresh_sources",
      "set_field",
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
  });

  it("carries the watched-source tools", () => {
    for (const name of ["list_watched_sources", "add_watched_source", "scan_watched_source"]) {
      expect(byName.has(name), name).toBe(true);
    }
  });

  it("agrees with the count docs/06-stack.md publishes", () => {
    // Bump both together, or an agent reads a number that is not true.
    // 26 + `create_imports` and `confirm_best`, the two bulk-import doors, + `adopt_track_file`.
    expect(tools.length).toBe(29);
  });
});

/* ------------------------------------------------------------------ */

/**
 * The two tools the bulk-import session asked for, checked as schemas and sentences like the
 * rest of this file: an agent never sees `imports.bulk.ts`, it sees these.
 */
describe("confirm_best and create_imports — the bulk-import doors", () => {
  it("confirm_best defaults to 0.8 coverage and prefers an Album", () => {
    const parsed = z.object(schemaOf("confirm_best")).parse({ importId: "imp_1" }) as {
      minCoverage: number;
      preferType: string;
    };
    expect(parsed.minCoverage).toBe(0.8);
    expect(parsed.preferType).toBe("album");
  });

  it("confirm_best refuses a coverage outside [0, 1]", () => {
    expect(parse("confirm_best", { importId: "i", minCoverage: 1.5 }).success).toBe(false);
    expect(parse("confirm_best", { importId: "i", minCoverage: -0.1 }).success).toBe(false);
  });

  it("confirm_best says what happens under the bar, and who signs the decision", () => {
    const text = byName.get("confirm_best")?.description ?? "";
    // The whole reason it is safe to loop over three hundred imports.
    expect(text).toContain("minCoverage");
    expect(text.toLowerCase()).toContain("nothing is confirmed");
    expect(text).toContain("decidedBy: mcp");
  });

  it("create_imports caps the list and says a bad URL loses only itself", () => {
    const many = Array.from({ length: 101 }, () => "fixture://discovery");
    expect(parse("create_imports", { urls: many }).success).toBe(false);
    expect(parse("create_imports", { urls: ["fixture://discovery"] }).success).toBe(true);
    expect(parse("create_imports", { urls: [] }).success).toBe(false);
    const text = byName.get("create_imports")?.description ?? "";
    expect(text).toContain("100");
    expect(text).toContain("results");
  });
});

/* ------------------------------------------------------------------ */

/**
 * Pagination, which existed and said so nowhere.
 *
 * `limit` was on three tools with no description and no total beside it, so an agent read the
 * first page and had no way of knowing there was a second. These assertions are on the text and
 * the schema because those are the two things the agent gets.
 */
describe("the list tools are discoverable as pages", () => {
  it("list_imports takes an offset and describes both parameters", () => {
    const parsed = z.object(schemaOf("list_imports")).parse({}) as {
      limit: number;
      offset: number;
    };
    expect(parsed.limit).toBe(20);
    expect(parsed.offset).toBe(0);
    expect(schemaOf("list_imports")["limit"]?.description ?? "").toContain("1–100");
    expect(schemaOf("list_imports")["offset"]?.description ?? "").toContain("total");
  });

  it("every list tool's description names its limit, its default and how to tell there is more", () => {
    for (const name of ["list_imports", "list_discover", "search_library"]) {
      const text = byName.get(name)?.description ?? "";
      expect(text, `${name} should document \`limit\``).toContain("`limit`");
      expect(text, `${name} should say what the default is`).toMatch(/default/i);
    }
    // Only `list_imports` is a page over an unbounded table, so only it owes a total.
    expect(byName.get("list_imports")?.description ?? "").toContain("hasMore");
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

/* ------------------------------------------------------------------ */

/**
 * The fifth test report, §1: `rescan` defaulted to `false` and beat the
 * `navidromeRescanOnVerify` setting, which the service itself already deferred to
 * (`options.rescan ?? settings.navidromeRescanOnVerify`) — the schema was the one place that
 * still hard-coded a default. Left `.optional()`, omitting `rescan` reaches the service as
 * `undefined`, and the setting decides.
 */
describe("verify's fifth-report point — `rescan` defers to the setting, not to `false`", () => {
  it("MCP: omitting `rescan` parses to `undefined`, not `false`", () => {
    const parsed = z.object(schemaOf("verify")).parse({ albumId: "alb_1" }) as {
      rescan?: boolean;
    };
    expect(parsed.rescan).toBeUndefined();
  });

  it("MCP: an explicit `rescan` still overrides", () => {
    const parsed = z.object(schemaOf("verify")).parse({ rescan: true }) as { rescan?: boolean };
    expect(parsed.rescan).toBe(true);
  });

  it("MCP: the description says `rescan` defaults to the `navidromeRescanOnVerify` setting", () => {
    const description = schemaOf("verify")["rescan"]?.description ?? "";
    expect(description).toContain("navidromeRescanOnVerify");
  });
});
