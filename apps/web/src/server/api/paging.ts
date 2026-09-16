/**
 * The arithmetic of a paged answer, on its own.
 *
 * It lived in `api/schemas.ts`, which is the right home for the zod shapes and the wrong one
 * for a pure function: the Console's job list wants the same `{total, hasMore}` and importing
 * it from there would drag `@hono/zod-openapi` into every server function that pages anything.
 * `schemas.ts` re-exports this, so `/api/v1` and the MCP tools keep the name they had and
 * there is still exactly one definition of what `hasMore` means.
 */

/** `{total, hasMore}` for a page that has already been cut to `limit`. */
export function pageInfo(
  total: number,
  offset: number,
  limit: number,
): { total: number; hasMore: boolean } {
  return { total, hasMore: offset + limit < total };
}
