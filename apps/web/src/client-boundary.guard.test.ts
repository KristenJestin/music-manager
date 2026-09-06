import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing that runs in the browser may pull `server/**` in with it.
 *
 * The rule TanStack Start actually enforces is narrow: it rewrites `createServerFn(…).handler(…)`
 * into an RPC stub, so a *server function* import costs the client nothing. Everything else
 * under `server/` — Drizzle, `postgres`, Better Auth, `node:fs`, the toolbox client — is server
 * code that has no business being fetched by a browser, and importing it is how you get errors
 * three layers from their cause. `functions/base.ts` tells that story; this test is what stops
 * it happening again.
 *
 * So: for every file that ends up in the client graph, every **value** import of `#/server/**`
 * must be one of
 *
 *  1. a `createServerFn` export from `server/functions/**` — the supported escape hatch; or
 *  2. a module this test can *prove* is pure.
 *
 * Purity is computed, not declared, which is the point. A module is pure when it imports
 * nothing at all, or imports only other pure in-app modules — so `enums.vocab.ts` qualifies
 * while `enums.ts`, one `pgEnum` away, does not. Nobody can widen the allowlist by editing a
 * list; they have to actually make the module pure.
 *
 * Type-only imports are ignored throughout: `import type` is erased before the bundler ever
 * sees it, so a type from a server module is free. That is the split this suite wants people
 * to reach for.
 *
 * Note what this test deliberately does *not* claim to catch. The bug it was written alongside
 * (`server/auth/auth.test.ts`) was not a bundle leak at all — it was server code calling a Bun
 * global while SSR ran under Node. The two failures look identical in the browser and have
 * nothing in common, so they get one guard each.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * These are whole-tree static scans, not unit tests, and they are bound by the disk rather
 * than by the processor: every `.ts` and `.tsx` of the app is read and matched. Five seconds,
 * vitest's default, is a budget for a function call; on this machine the sweep took twelve
 * whenever the suite ran beside a dev server and Docker, and the gate went red for a reason
 * that had nothing to do with the boundary. The scans get a budget that fits what they
 * actually do. A real regression still fails on its assertion, in milliseconds, not on time.
 */
const SCAN_TIMEOUT_MS = 60_000;

/** Directories whose modules are fetched by, or rendered into, the browser. */
const CLIENT_DIRS = ["routes", "components", "hooks", "lib"] as const;

const slash = (path: string): string => path.split("\\").join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(slash(path));
  }
  return out;
}

const sources = new Map<string, string>();
function source(file: string): string {
  let text = sources.get(file);
  if (text === undefined) {
    try {
      text = readFileSync(file, "utf8");
    } catch {
      text = "";
    }
    sources.set(file, text);
  }
  return text;
}

/**
 * An API endpoint: a `.ts` route declaring `server.handlers`.
 *
 * Every route with a component is a `.tsx` in this app, so the extension is the whole
 * distinction. These files never reach the browser — the plugin keeps them server-side — and
 * they are the legitimate place to import `getAuth`, the Hono app or the MCP server.
 */
function isApiRoute(file: string): boolean {
  return (
    file.includes("/routes/") &&
    file.endsWith(".ts") &&
    /server:\s*\{[\s\S]*handlers/.test(source(file))
  );
}

interface ValueImport {
  readonly file: string;
  readonly specifier: string;
  readonly names: readonly string[];
}

const IMPORT = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

/** A capture group, as a string. `noUncheckedIndexedAccess` is on and every group here is one. */
const group = (match: RegExpMatchArray, index: number): string => match[index] ?? "";

/** Every imported binding of a statement, minus the inline `type` specifiers. */
function valueNames(clause: string): string[] {
  const names: string[] = [];
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (braced) {
    for (const raw of group(braced, 1).split(",")) {
      const name = raw.trim();
      if (name === "" || /^type\s/.test(name)) continue;
      names.push((name.split(/\s+as\s+/)[0] ?? name).trim());
    }
  }
  const bare = clause
    .replace(/\{[\s\S]*\}/, "")
    .split(",")
    .join("")
    .trim();
  if (bare !== "") names.push(bare);
  return names;
}

function valueImports(file: string, predicate: (specifier: string) => boolean): ValueImport[] {
  const found: ValueImport[] = [];
  for (const match of source(file).matchAll(IMPORT)) {
    if (match[1] !== undefined) continue; // `import type { … }` — erased.
    const specifier = group(match, 3);
    if (!predicate(specifier)) continue;
    const names = valueNames(group(match, 2));
    if (names.length > 0) found.push({ file, specifier, names });
  }
  return found;
}

/**
 * Code with the prose taken out.
 *
 * Block comments go entirely; line comments only when the line is nothing else, so a `//`
 * inside a `postgres://…` literal cannot swallow real code after it. Needed because the files
 * that explain a banned pattern have to be allowed to name it — `auth.ts` documents at length
 * why it no longer calls `Bun.CryptoHasher`, and a scanner that reads comments would flag the
 * explanation as the offence.
 */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/** `#/server/db/schema/enums.vocab.ts` → its absolute path. */
const moduleFile = (specifier: string): string =>
  slash(resolve(HERE, specifier.replace(/^#\//, "")));

const isInternal = (specifier: string): boolean => specifier.startsWith("#/");

/** Imports nothing, or only pure in-app modules. Cycles count as pure; they cannot add weight. */
const purity = new Map<string, boolean>();
function isPure(file: string, seen: Set<string> = new Set()): boolean {
  const cached = purity.get(file);
  if (cached !== undefined) return cached;
  if (seen.has(file)) return true;
  seen.add(file);

  const text = source(file);
  if (text === "") return false;

  let pure = true;
  for (const match of text.matchAll(IMPORT)) {
    if (match[1] !== undefined) continue;
    const specifier = group(match, 3);
    if (valueNames(group(match, 2)).length === 0) continue;
    if (!isInternal(specifier) || !isPure(moduleFile(specifier), seen)) {
      pure = false;
      break;
    }
  }
  purity.set(file, pure);
  return pure;
}

/** Is `name` exported from `file` as a literal `createServerFn(…)` call? */
function isServerFn(file: string, name: string): boolean {
  const text = source(file);
  const declaration = text.match(
    new RegExp(
      `export\\s+(?:async\\s+)?(?:const|let|var|function|class)\\s+${name}\\b([\\s\\S]{0,500})`,
    ),
  );
  return declaration !== null && /createServerFn\s*\(/.test(group(declaration, 1));
}

const clientFiles = CLIENT_DIRS.flatMap((dir) => walk(join(HERE, dir)))
  .filter((file) => !/\.test\.tsx?$/.test(file))
  .filter((file) => !isApiRoute(file));

describe("the client/server boundary", () => {
  it(
    "scans a plausible amount of the app (a broken walk would pass vacuously)",
    () => {
      expect(clientFiles.length).toBeGreaterThanOrEqual(40);
      expect(clientFiles.some((file) => file.endsWith("/routes/_app.tsx"))).toBe(true);
      expect(clientFiles.some((file) => file.includes("/components/"))).toBe(true);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "still recognises the API routes it excludes",
    () => {
      const api = CLIENT_DIRS.flatMap((dir) => walk(join(HERE, dir))).filter(isApiRoute);
      expect(api.map((file) => file.split("/").at(-1)).toSorted()).toContain("api.auth.$.ts");
      expect(api.length).toBeGreaterThanOrEqual(5);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "imports server code only as a server function or a provably pure module",
    () => {
      const violations: string[] = [];

      for (const file of clientFiles) {
        for (const { specifier, names } of valueImports(file, (s) => s.startsWith("#/server/"))) {
          const target = moduleFile(specifier);
          const inFunctions = target.includes("/server/functions/");
          for (const name of names) {
            if (inFunctions && isServerFn(target, name)) continue;
            if (isPure(target)) continue;
            violations.push(
              `${file.replace(slash(HERE), "src")} imports { ${name} } from "${specifier}"`,
            );
          }
        }
      }

      expect(violations.toSorted()).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "keeps the vocabulary module pure, since the Console imports it for real",
    () => {
      const vocab = join(HERE, "server", "db", "schema", "enums.vocab.ts");
      expect(isPure(slash(vocab))).toBe(true);
      // The module it was split out of must stay impure, or the split has been undone.
      expect(isPure(slash(join(HERE, "server", "db", "schema", "enums.ts")))).toBe(false);
    },
    SCAN_TIMEOUT_MS,
  );
});

describe("runtime portability", () => {
  /**
   * `vite dev` runs under Node, so the app's server half cannot assume the Bun runtime.
   * `server/auth/auth.test.ts` has the full story; this is the cheap net that catches the
   * next `Bun.` before it reaches an SSR render.
   */
  it(
    "uses no Bun global anywhere in the web app",
    () => {
      const all = ["routes", "components", "hooks", "lib", "server", "worker"]
        .map((dir) => join(HERE, dir))
        .flatMap((dir) => walk(dir));

      const offenders = all
        .filter((file) => !/\.test\.tsx?$/.test(file))
        .filter((file) => /(^|[^.\w])Bun\s*\./.test(code(file)))
        .map((file) => file.replace(slash(HERE), "src"));

      expect(all.length).toBeGreaterThanOrEqual(80);
      expect(offenders.toSorted()).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "would actually catch one (the scanner reads code, and only code)",
    () => {
      const detects = (text: string): boolean => /(^|[^.\w])Bun\s*\./.test(text);
      expect(detects('const hash = new Bun.CryptoHasher("sha256");')).toBe(true);
      expect(detects("await Bun.sleep(1000);")).toBe(true);
      // Not a Bun global: a property called `Bun`, and the word in prose.
      expect(detects("config.Bun.enabled")).toBe(false);
      expect(code(join(HERE, "server", "auth", "auth.ts"))).not.toMatch(/Bun/);
    },
    SCAN_TIMEOUT_MS,
  );
});
