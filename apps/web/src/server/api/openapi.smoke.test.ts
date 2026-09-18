/**
 * The OpenAPI document builds, and the album-holes routes are in it.
 *
 * `tsc` proves a route *compiles*; it does not prove the generator can describe it. A schema
 * the document generator cannot render — a coerced path parameter, a `.openapi()` name used
 * twice — throws at request time, on `GET /api/openapi.json` and `/api/docs`, and nothing in
 * the gate would have said so: no unit test builds the document and the browser suite never
 * opens it. One assertion is cheap insurance against shipping a 500 on the page whose whole
 * job is to tell an agent what this installation can do.
 */
import { describe, expect, it } from "vitest";
import { openApiDocument } from "./app.ts";

describe("the OpenAPI document", () => {
  const document = openApiDocument() as {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };

  it("builds at all", () => {
    expect(Object.keys(document.paths).length).toBeGreaterThan(20);
  });

  it("describes both halves of the album-holes feature", () => {
    // Listing them and filling one are two different verbs on two different paths, and a
    // feature that documented only the read half would be a feature an agent cannot finish.
    expect(document.paths["/api/v1/library/albums/{id}/missing"]?.["get"]).toBeDefined();
    expect(
      document.paths["/api/v1/library/albums/{id}/missing/{medium}/{position}/file"]?.["post"],
    ).toBeDefined();
  });

  it("names the shapes those routes answer with", () => {
    for (const name of ["MissingTrack", "AlbumMissing", "AdoptMissingResult", "AdoptFileFromUrl"]) {
      expect(document.components.schemas[name], name).toBeDefined();
    }
  });
});
