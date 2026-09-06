import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No server function is reachable without a session.
 *
 * `docs/phases/P06-web-coeur.md`: *toutes les routes et server functions sont protégées ;
 * `/health` reste public*. `session.test.ts` proves the gate refuses; this proves every
 * function is actually behind it, which is the half that rots. Adding a server function is a
 * two-line habit, and the day somebody forgets `.middleware([sessionMiddleware])` no runtime
 * test will notice — the function will simply work, for everyone.
 *
 * So the source is read and checked. It is a crude tool and exactly the right one: the
 * property is syntactic (the plugin requires `createServerFn` to be called literally, see
 * `base.ts`), so a syntactic check cannot be fooled by indirection that the plugin would
 * reject anyway.
 *
 * The three functions that must stay public are named here, one by one, with the reason. A
 * fourth appearing in that list is a decision somebody has to make on purpose.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The only server functions that may answer without a session, and why. */
const PUBLIC: Readonly<Record<string, string>> = {
  setupState: "the login page has to know whether an account exists before you can have one",
  currentSession: "answering “am I signed in?” cannot itself require being signed in",
  completeSetup: "it creates the first account, and refuses once one exists",
};

interface Declaration {
  readonly file: string;
  readonly name: string;
  readonly guarded: boolean;
}

/** Every `export const <name> = createServerFn(…)` in the directory, and whether it is guarded. */
function declarations(): Declaration[] {
  const files = readdirSync(HERE)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();

  const found: Declaration[] = [];
  for (const file of files) {
    const source = readFileSync(join(HERE, file), "utf8");
    const pattern = /export const (\w+)\s*=\s*createServerFn\(/g;
    for (const match of source.matchAll(pattern)) {
      const name = match[1] ?? "";
      // Everything from the declaration up to its `.handler(` is the builder chain.
      const from = match.index;
      const handlerAt = source.indexOf(".handler(", from);
      const chain = source.slice(from, handlerAt === -1 ? from : handlerAt);
      found.push({ file, name, guarded: chain.includes(".middleware([sessionMiddleware])") });
    }
  }
  return found;
}

describe("server functions", () => {
  const all = declarations();

  it("finds the whole surface (a directory that stopped being scanned would pass vacuously)", () => {
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(new Set(all.map((entry) => entry.file)).size).toBeGreaterThanOrEqual(5);
  });

  it("guards every function that is not deliberately public", () => {
    const unguarded = all.filter((entry) => !entry.guarded).map((entry) => entry.name);
    expect(unguarded.toSorted()).toEqual(Object.keys(PUBLIC).toSorted());
  });

  it("keeps the public list to the three documented cases", () => {
    for (const name of Object.keys(PUBLIC)) {
      expect(all.some((entry) => entry.name === name)).toBe(true);
    }
    expect(Object.keys(PUBLIC)).toHaveLength(3);
  });

  it("declares them literally, so the client bundle really is split", () => {
    // A wrapper the Vite plugin cannot see bundles Drizzle and `postgres` into the browser.
    for (const file of new Set(all.map((entry) => entry.file))) {
      const source = readFileSync(join(HERE, file), "utf8");
      expect(source).not.toMatch(/export const \w+\s*=\s*(authedFn|publicFn)\(/);
    }
  });
});
