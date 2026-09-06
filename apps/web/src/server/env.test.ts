import { beforeEach, describe, expect, it } from "vitest";
import { resetServerEnv, serverEnv } from "./env.ts";

const valid = { DATABASE_URL: "postgres://mm:mm@localhost:5432/mm" };

describe("serverEnv", () => {
  beforeEach(resetServerEnv);

  it("applies defaults for everything but the database URL", () => {
    expect(serverEnv(valid)).toEqual({
      DATABASE_URL: valid.DATABASE_URL,
      MM_TOOLBOX_URL: "http://localhost:8100",
      MM_TOOLBOX_TOKEN: "",
      MM_FIXTURES: false,
      MM_LIBRARY_ROOT: "./.local/library",
      MM_TOOLBOX_LIBRARY_ROOT: "/library",
      MM_WORK_DIR: ".mm-work",
      MM_WEB_URL: "http://localhost:3000",
      MM_AUTH_SECRET: "",
      MM_ADMIN_EMAIL: "",
      MM_ADMIN_PASSWORD: "",
      MM_BEHIND_PROXY: false,
      NODE_ENV: "development",
    });
  });

  it("turns MM_BEHIND_PROXY into a boolean", () => {
    expect(serverEnv({ ...valid, MM_BEHIND_PROXY: "1" }).MM_BEHIND_PROXY).toBe(true);
  });

  it("turns MM_FIXTURES into a boolean", () => {
    expect(serverEnv({ ...valid, MM_FIXTURES: "1" }).MM_FIXTURES).toBe(true);
  });

  it("rejects a missing database URL", () => {
    expect(() => serverEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres database URL", () => {
    expect(() => serverEnv({ DATABASE_URL: "mysql://localhost/mm" })).toThrow(/DATABASE_URL/);
  });
});
