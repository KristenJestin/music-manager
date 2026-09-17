/**
 * Every Console page draws itself while it loads.
 *
 * The rule this keeps is the one that is easy to *almost* hold: `pendingComponent` is per
 * route in TanStack Router, exactly like `errorComponent` (see `router.tsx`), so a page added
 * next month inherits `defaultPendingComponent` — the generic net — rather than a skeleton of
 * its own shape, and nobody notices until the owner clicks it.
 *
 * Reading the source rather than the route tree on purpose: `routeTree.gen.ts` is gitignored
 * and importing a route module here would drag `server/**` into a unit test, which
 * `client-boundary.guard.test.ts` exists to forbid. A regex over the file is enough for the
 * property being checked, which is "did somebody write it down".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = import.meta.dirname;
const ROUTES = join(SRC, "routes");

/** The `_app` route files that have a component at all — API routes have none. */
function pages(): readonly { readonly file: string; readonly source: string }[] {
  return readdirSync(ROUTES)
    .filter((file) => file.startsWith("_app") && file.endsWith(".tsx"))
    .map((file) => ({ file, source: readFileSync(join(ROUTES, file), "utf8") }))
    .filter((entry) => /^\s*component:/m.test(entry.source));
}

describe("every /_app route paints itself while it loads", () => {
  it("finds the pages", () => {
    // A guard whose subject has moved is a guard that passes by accident. The count is a
    // floor, not an equality: adding a page must not have to come here to be allowed.
    expect(pages().length).toBeGreaterThanOrEqual(24);
  });

  it.each(pages().map((entry) => entry.file))("%s declares a pendingComponent", (file) => {
    const source = readFileSync(join(ROUTES, file), "utf8");
    expect(source, `${file} would fall back to the router's generic skeleton`).toMatch(
      /^\s*pendingComponent:/m,
    );
  });

  it("builds each one out of the shared vocabulary", () => {
    // `components/skeleton.tsx` is what sets `role="status"`, `aria-busy`, `data-testid` and
    // the reduced-motion variant, so a pending component that hand-rolls its own markup would
    // silently lose all four. Checked as "names something from that module", which is as far
    // as reading one file can go; the E2E spec checks the contract itself.
    //
    // The wizard is the one exception, and it says why in its own comment: it reports
    // MusicBrainz's request-by-request progress rather than the shape of a page.
    for (const { file, source } of pages()) {
      if (file === "_app.import.new.tsx") continue;
      expect(
        source,
        `${file}'s pending component should come from components/skeleton.tsx`,
      ).toMatch(/Skeleton\w*/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* and it draws itself with identifiers of its own                     */
/* ------------------------------------------------------------------ */

/**
 * Source with its comments taken out.
 *
 * `components/skeleton.tsx` explains itself by quoting `data-testid="page-skeleton"` in prose,
 * and a guard that read prose as code would fail on the sentence describing the rule it is
 * enforcing.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * A module's top-level declarations, by name, each with everything up to the next one.
 *
 * Brace counting would be more precise and is not needed: a declaration's text ends where the
 * next one begins, and nothing below reads anything a stray closing brace could move.
 */
function declarations(source: string): ReadonlyMap<string, string> {
  const text = code(source);
  const starts = [...text.matchAll(/^(?:export )?(?:function|const) ([A-Za-z_]\w*)/gm)];
  const out = new Map<string, string>();
  starts.forEach((start, index) => {
    const from = start.index;
    const to = starts[index + 1]?.index ?? text.length;
    out.set(start[1] ?? "", text.slice(from, to));
  });
  return out;
}

/** `import { A, B } from "…"` and `import A from "…"`, flattened to one name per entry. */
function importedFrom(source: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const match of code(source).matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
  )) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = (part.split(" as ").pop() ?? "").trim();
      if (name !== "") out.set(name, match[2] ?? "");
    }
  }
  return out;
}

/** A `#/…` or relative specifier as a file on disk, or `null` for a package. */
function resolve(from: string, specifier: string): string | null {
  const path = specifier.startsWith("#/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  return path !== null && existsSync(path) ? path : null;
}

/**
 * Every `data-testid="…"` **literal** a component tree writes, following it across modules.
 *
 * A literal is the whole point: `data-testid={testId("library-sort")}` is an identifier that
 * knows which of the two trees it is in and is therefore safe in both, while a bare string is
 * the same attribute in the pending tree and in the settled one. So this collects the bare
 * strings, and the property below is that the two trees' sets do not meet.
 *
 * `components/ui/**` is skipped: it is shadcn's, it must stay re-addable with the CLI, and it
 * writes no identifiers of its own — it only passes on the one it is handed.
 */
function literalTestIds(file: string, roots: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  const seen = new Set<string>();

  const visit = (path: string, name: string): void => {
    const key = `${path}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!existsSync(path)) return;

    const source = readFileSync(path, "utf8");
    const local = declarations(source);
    const body = local.get(name);
    if (body === undefined) return;

    for (const match of body.matchAll(/data-testid="([^"]+)"/g)) found.add(match[1] ?? "");

    const imports = importedFrom(source);
    for (const match of body.matchAll(/<([A-Z]\w*)/g)) {
      const tag = match[1] ?? "";
      if (local.has(tag)) {
        visit(path, tag);
        continue;
      }
      const specifier = imports.get(tag);
      if (specifier === undefined || specifier.includes("/components/ui/")) continue;
      const target = resolve(path, specifier);
      if (target !== null) visit(target, tag);
    }
  };

  for (const root of roots) visit(file, root);
  return found;
}

/** The component names a route declares, as `component:` / `pendingComponent:` name them. */
function root(source: string, key: "component" | "pendingComponent"): string | null {
  return new RegExp(String.raw`^\s*${key}: (\w+),`, "m").exec(code(source))?.[1] ?? null;
}

/**
 * The rule that broke, written down.
 *
 * A route's `pendingComponent` and its `component` render the same real toolbar — that is the
 * point of the split — and TanStack hands the first to React as a `Suspense` fallback, so a
 * re-suspend (any navigation that changes a loader's deps: a preset click, a sort, a page)
 * keeps *both* trees mounted. Every identifier the two share therefore names two elements at
 * once, half of them stale, and `quality.spec.ts`, `library-filters.spec.ts` and
 * `missing-files.spec.ts` all failed on it under load before this existed.
 *
 * `components/pending-tree.tsx` is the fix and `components/pending-tree.test.tsx` renders the
 * two trees together to prove the shared components hold it. This is the other half: the
 * identifiers a *page* writes itself, which no fixture can reach.
 */
describe("a page's pending tree and its settled tree share no identifier", () => {
  it.each(pages().map((entry) => entry.file))("%s", (file) => {
    const path = join(ROUTES, file);
    const source = readFileSync(path, "utf8");
    const settled = root(source, "component");
    const waiting = root(source, "pendingComponent");

    // Named rather than skipped: a guard that quietly finds nothing to check is a guard that
    // reports green on the day the thing it checks is renamed.
    expect([settled, waiting], `${file} should name both of its components`).not.toContain(null);
    if (settled === null || waiting === null) return;

    const pending = literalTestIds(path, [waiting]);
    const both = [...literalTestIds(path, [settled])].filter((id) => pending.has(id));
    expect(
      both,
      `${file} writes these as plain strings in both trees; they belong behind useTestId()`,
    ).toEqual([]);
  });
});
