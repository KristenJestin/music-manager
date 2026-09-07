/**
 * A handful of REST-only schema regressions — no database, no server.
 *
 * The MCP tool table has its own schema tests (`mcp/server.test.ts`); these exist because
 * `/api/v1` restates a few of the same shapes in `schemas.ts` rather than sharing the MCP
 * tool's `inputSchema` object, so a fix on one side does not automatically reach the other.
 * The fifth test report's §1 was exactly that: the MCP `verify` tool and the REST `/verify`
 * route both hard-coded `rescan` to default to `false`, which beat the
 * `navidromeRescanOnVerify` setting the service itself already deferred to.
 */
import { describe, expect, it } from "vitest";
import { verifySchema } from "./schemas.ts";

describe("verifySchema — REST's half of the fifth report's §1", () => {
  it("omitting `rescan` parses to `undefined`, not `false`", () => {
    const parsed = verifySchema.parse({ albumId: "alb_1" });
    expect(parsed.rescan).toBeUndefined();
  });

  it("an explicit `rescan` still overrides", () => {
    const parsed = verifySchema.parse({ rescan: true });
    expect(parsed.rescan).toBe(true);
  });

  it("the generated OpenAPI document says `rescan` defaults to the `navidromeRescanOnVerify` setting", async () => {
    // `.openapi({description})` metadata lives in `@asteasolutions/zod-to-openapi`'s registry,
    // not on the schema instance, so the generated document is what a caller — human or
    // agent — actually reads. `openApiDocument()` is the exact function `/api/openapi.json`
    // calls.
    const { openApiDocument } = await import("./app.ts");
    const doc = openApiDocument() as {
      components: { schemas: { Verify: { properties: { rescan: { description?: string } } } } };
    };
    expect(doc.components.schemas.Verify.properties.rescan.description).toContain(
      "navidromeRescanOnVerify",
    );
  });
});
