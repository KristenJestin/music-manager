import { describe, expect, it } from "vitest";
import { webHealthSchema } from "@mm/contracts";
import { handleHealth, healthPayload } from "./health.ts";
import { APP_VERSION } from "./version.ts";

describe("GET /health", () => {
  it("builds a payload matching the shared contract", () => {
    expect(webHealthSchema.safeParse(healthPayload()).success).toBe(true);
  });

  it("reports ok and the package version", () => {
    expect(healthPayload()).toEqual({ ok: true, version: APP_VERSION });
  });

  it("responds with 200 and JSON", async () => {
    const response = handleHealth();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true, version: APP_VERSION });
  });

  it("does not let the response be cached", () => {
    expect(handleHealth().headers.get("cache-control")).toBe("no-store");
  });
});
