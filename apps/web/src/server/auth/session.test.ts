import { beforeEach, describe, expect, it, vi } from "vitest";
import { MMError } from "@mm/contracts";

/**
 * The gate itself.
 *
 * `docs/phases/P06-web-coeur.md` asks for a test proving no server function answers without a
 * session. This is half of that proof — that `requireSession`, which the middleware every
 * server function carries is nothing but a call to, refuses when Better Auth has no session
 * for the request. The other half is `functions.guard.test.ts`, which proves every function
 * actually carries the middleware, and the Playwright suite, which proves it over real HTTP.
 *
 * Better Auth is mocked rather than run: what is under test is our behaviour on `null`, not
 * the library's cookie parsing, and a unit test must not need Postgres (`CLAUDE.md`).
 */
const getSessionMock = vi.fn();

vi.mock("#/server/auth/auth.ts", () => ({
  getAuth: async () => await Promise.resolve({ api: { getSession: getSessionMock } }),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers(),
}));

const { getSession, isUnauthorized, requireSession } = await import("#/server/auth/session.ts");

describe("requireSession", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it("refuses when there is no session", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(requireSession(new Headers())).rejects.toThrow(MMError);
    await expect(requireSession(new Headers())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("refuses when the cookie is present but Better Auth does not recognise it", async () => {
    getSessionMock.mockResolvedValue(null);
    const headers = new Headers({ cookie: "mm.session_token=forged" });
    await expect(requireSession(headers)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns only the fields the app uses, never the token", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "usr_1", email: "admin@example.com", name: "Administrator" },
      session: { expiresAt: new Date("2026-10-06T00:00:00Z"), token: "secret-token" },
    });
    const session = await requireSession(new Headers());
    expect(session).toEqual({
      userId: "usr_1",
      email: "admin@example.com",
      name: "Administrator",
      expiresAt: "2026-10-06T00:00:00.000Z",
    });
    expect(JSON.stringify(session)).not.toContain("secret-token");
  });
});

describe("getSession", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it("answers null rather than throwing, so /login can ask without catching", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(getSession(new Headers())).resolves.toBeNull();
  });
});

describe("isUnauthorized", () => {
  it("recognises the failure the client turns into a redirect", () => {
    expect(isUnauthorized(new MMError("UNAUTHORIZED", "no"))).toBe(true);
    expect(isUnauthorized(new Error("UNAUTHORIZED: You are not signed in."))).toBe(true);
    expect(isUnauthorized(new MMError("NOT_FOUND", "no"))).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });
});
