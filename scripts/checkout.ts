/**
 * Who am I? — checkout identity, and the isolated names that follow from it.
 *
 * The repository is worked on from several checkouts at once: `v2/` itself, which the owner
 * keeps for testing, and one `git worktree` per task (`../v2-wt-<slug>`). Everything that could
 * collide between them is derived here, once, from a single question — *which directory am I
 * running in?* — so that no script has to be told twice:
 *
 * | thing            | `v2/` (primary)          | a worktree                        |
 * | ---------------- | ------------------------ | --------------------------------- |
 * | compose project  | `mm-dev`                 | `mm-<slug>`                       |
 * | toolbox port     | 8100                     | 8200–8899, stable per slug        |
 * | navidrome port   | 4533                     | 4600–4899, stable per slug        |
 * | database         | the one in `.env`        | `mm_<slug>` on the same server    |
 * | library          | `v2/.local/library`      | `<worktree>/.local/library`       |
 * | portless app     | `music-manager`          | `music-manager-<slug>`            |
 *
 * **Why the compose project matters more than it looks.** `docker-compose.dev.yml` declares
 * `name: mm-dev` and bind-mounts `./.local/library`, a path relative to the compose file. A
 * plain `docker compose up` from a worktree therefore addresses the *shared* containers by
 * name and **recreates** them pointing at the worktree's library — silently moving the library
 * out from under whoever was using it. That happened during P07-verify-1 (`orchestration/
 * reports/P07-verify-1.md` §9, `orchestration/STATUS.md` § Dette technique). The parade is to
 * never call compose without `-p`, and to let this module decide what `-p` is.
 *
 * Nothing here touches the filesystem beyond reading `.env` and asking `git` where it lives.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { repoRoot, withDatabaseName } from "./lib.ts";

/* ------------------------------------------------------------------ */
/* dotenv                                                              */
/* ------------------------------------------------------------------ */

/**
 * `KEY=value` pairs from a `.env` file, minus comments, blanks and surrounding quotes.
 *
 * Deliberately small: this is the same subset `.env.example` documents, and a script that grew
 * a full dotenv parser would be a script that disagreed with Bun's own about something.
 */
export function readDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key === undefined) continue;
    const trimmed = (match[2] ?? "").trim();
    values[key] = /^(".*"|'.*')$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  }
  return values;
}

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

function git(...args: string[]): string | null {
  const exe = Bun.which("git");
  if (!exe) return null;
  const result = Bun.spawnSync([exe, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.exitCode !== 0) return null;
  const out = result.stdout.toString().trim();
  return out.length > 0 ? out : null;
}

/**
 * The directory of the *primary* worktree — the one holding the real `.git` directory, i.e.
 * `v2/`. `git rev-parse --git-common-dir` answers `…/v2/.git` from every linked worktree,
 * which is exactly the pointer we need to find the owner's `.env`.
 */
function mainCheckoutRoot(): string {
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common === null) return repoRoot;
  return dirname(resolve(common.replace(/\\/g, "/")));
}

function currentBranch(): string {
  return git("rev-parse", "--abbrev-ref", "HEAD") ?? "";
}

/* ------------------------------------------------------------------ */
/* slug                                                                */
/* ------------------------------------------------------------------ */

/** Lowercase, alphanumerics and single dashes, at most 24 characters. Never empty. */
function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return cleaned.length > 0 ? cleaned : "wt";
}

/**
 * A stable small integer derived from a string (FNV-1a), used to give each checkout published
 * ports of its own. Stable matters: the same worktree must publish the same port across
 * restarts, or its container is recreated — and its `MM_TOOLBOX_URL` changes — every time.
 */
function stablePort(base: number, span: number, key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return base + (Math.abs(hash) % span);
}

/* ------------------------------------------------------------------ */
/* the checkout                                                        */
/* ------------------------------------------------------------------ */

export interface Checkout {
  /** Absolute root of the checkout this process runs in. */
  readonly root: string;
  /** Absolute root of `v2/` — where the owner's `.env` lives, whichever checkout we are. */
  readonly mainRoot: string;
  /** True for `v2/` itself: the shared stack, the one nobody else may repoint. */
  readonly isPrimary: boolean;
  /** `""` for `v2/`, otherwise the identity every derived name is built from. */
  readonly slug: string;
  /** Current branch, informational. */
  readonly branch: string;
  /** `-p` for every `docker compose` call made from this checkout. */
  readonly composeProject: string;
  /** Published port of this checkout's toolbox. */
  readonly toolboxPort: number;
  /** Published port of this checkout's navidrome. */
  readonly navidromePort: number;
  /** Published port of this checkout's postgres, if it ever runs one of its own. */
  readonly postgresPort: number;
  /** Absolute path of this checkout's library bind mount. */
  readonly libraryRoot: string;
  /** portless app name → `https://<appName>.localhost`. */
  readonly appName: string;
}

/**
 * A checkout is *primary* when it is the directory named `v2` that owns the `.git` directory.
 * A linked worktree is not, and neither is a separate clone parked elsewhere — both would
 * otherwise inherit `mm-dev` and its bind mounts, which is the whole failure mode.
 */
export function checkout(): Checkout {
  const root = repoRoot;
  const mainRoot = mainCheckoutRoot();
  const branch = currentBranch();
  const isPrimary = root === mainRoot && basename(root).toLowerCase() === "v2";

  // `../v2-wt-portless-check` → `portless-check`; anything else keeps its directory name.
  const raw = basename(root).replace(/^v2[-_]?(wt[-_]?)?/i, "");
  const identity = raw.length > 0 ? raw : branch.length > 0 ? branch : basename(root);
  const slug = isPrimary ? "" : slugify(identity);

  return {
    root,
    mainRoot,
    isPrimary,
    slug,
    branch,
    composeProject: isPrimary ? "mm-dev" : `mm-${slug}`,
    toolboxPort: isPrimary ? 8100 : stablePort(8200, 700, slug),
    navidromePort: isPrimary ? 4533 : stablePort(4600, 300, slug),
    postgresPort: isPrimary ? 5432 : stablePort(5500, 300, slug),
    libraryRoot: join(root, ".local", "library"),
    appName: isPrimary ? "music-manager" : `music-manager-${slug}`,
  };
}

/* ------------------------------------------------------------------ */
/* the environment a child process needs                               */
/* ------------------------------------------------------------------ */

/**
 * The URL portless serves this checkout on. `portless get` is asked rather than guessed,
 * because it knows about `PORTLESS_TLD` and `PORTLESS_HTTPS=0`; the guess is the fallback for
 * a machine where portless is not installed.
 */
export function portlessUrl(app: string): string {
  const exe = Bun.which("portless");
  if (exe) {
    const result = Bun.spawnSync([exe, "get", app], { stdio: ["ignore", "pipe", "ignore"] });
    const out = result.stdout.toString().trim();
    if (result.exitCode === 0 && /^https?:\/\//.test(out)) return out;
  }
  return `https://${app}.localhost`;
}

export interface DevEnvOptions {
  /** Port the web app will listen on; omitted for processes that do not serve HTTP. */
  readonly port?: string;
  /** Prefer the portless URL for `MM_WEB_URL` even when no `PORTLESS_URL` was inherited. */
  readonly preferPortless?: boolean;
}

export interface DevEnv {
  readonly checkout: Checkout;
  /** Everything a child needs, `.env` included, resolved for this checkout. */
  readonly env: Record<string, string>;
  /** Where `.env` was read from, for the banner. */
  readonly envFiles: readonly string[];
  /** The database this checkout uses. */
  readonly databaseUrl: string;
  /**
   * The same server, on a database that certainly exists — used only to issue
   * `create database mm_<slug>`. Never written to.
   */
  readonly adminDatabaseUrl: string;
  /** The origin Better Auth will accept. */
  readonly webUrl: string;
}

/**
 * Build the environment for a dev process in this checkout.
 *
 * **`.env` is the owner's, wherever we run.** Secrets live in `v2/.env`, which is gitignored
 * and therefore absent from every worktree. A worktree reads it from `mainRoot`, then lets its
 * own `.env` — if it has one — override any key.
 *
 * **The isolated values win over the inherited ones.** `DATABASE_URL`, `MM_LIBRARY_ROOT`,
 * `MM_TOOLBOX_URL` and `MM_TOOLBOX_LIBRARY_ROOT` are rewritten for a worktree, because
 * inheriting them verbatim is precisely how two checkouts end up writing to one database and
 * one library. An explicit value still wins: a key present in the worktree's own `.env`, or
 * exported in the shell, is left alone — that is the escape hatch for "no, really, I want the
 * shared one".
 */
export function devEnv(options: DevEnvOptions = {}): DevEnv {
  const info = checkout();

  const mainEnvFile = join(info.mainRoot, ".env");
  const localEnvFile = join(info.root, ".env");
  const envFiles: string[] = [];

  const inherited: Record<string, string> = {};
  if (!info.isPrimary && existsSync(mainEnvFile)) {
    Object.assign(inherited, readDotEnv(mainEnvFile));
    envFiles.push(mainEnvFile);
  }
  const localEnv = readDotEnv(localEnvFile);
  if (existsSync(localEnvFile)) {
    Object.assign(inherited, localEnv);
    envFiles.push(localEnvFile);
  }

  // The real environment always wins over a file: `MM_FIXTURES=0 bun run dev` means what it says.
  const env: Record<string, string> = { ...inherited, ...(process.env as Record<string, string>) };

  /** True when the caller said something about this key, as opposed to inheriting it. */
  const pinned = (key: string): boolean =>
    Object.hasOwn(localEnv, key) || Object.hasOwn(process.env, key);

  const adminDatabaseUrl = env["DATABASE_URL"] ?? "";

  if (!info.isPrimary) {
    const database = `mm_${info.slug.replace(/-/g, "_")}`;
    if (!pinned("DATABASE_URL") && env["DATABASE_URL"] !== undefined) {
      env["DATABASE_URL"] = withDatabaseName(env["DATABASE_URL"], database);
    }
    if (!pinned("MM_TOOLBOX_URL")) {
      env["MM_TOOLBOX_URL"] = `http://localhost:${String(info.toolboxPort)}`;
    }
    if (!pinned("MM_LIBRARY_ROOT")) env["MM_LIBRARY_ROOT"] = info.libraryRoot;
    if (!pinned("MM_TOOLBOX_LIBRARY_ROOT")) env["MM_TOOLBOX_LIBRARY_ROOT"] = "/library";
  } else if (!pinned("MM_LIBRARY_ROOT")) {
    // Absolute rather than `./.local/library`, whose meaning depends on the child's cwd.
    env["MM_LIBRARY_ROOT"] = info.libraryRoot;
  }

  if (options.port !== undefined) env["PORT"] = options.port;

  /*
   * `MM_WEB_URL` follows the URL the browser will actually use.
   *
   * Better Auth checks the browser's origin against it (`server/auth/auth.ts`,
   * `trustedOrigins`) and it defaults to `http://localhost:3000`, so an app moved anywhere else
   * without moving this too serves a login form that renders perfectly and answers **"Invalid
   * origin"** on submit. Under portless the origin is `https://<app>.localhost`, not a port at
   * all, and portless hands the child `PORTLESS_URL` saying so.
   */
  const explicit = process.env["MM_WEB_URL"] ?? localEnv["MM_WEB_URL"] ?? inherited["MM_WEB_URL"];
  const webUrl =
    explicit ??
    process.env["PORTLESS_URL"] ??
    (options.preferPortless === true
      ? portlessUrl(info.appName)
      : `http://localhost:${options.port ?? process.env["PORT"] ?? "3000"}`);
  env["MM_WEB_URL"] = webUrl;

  return {
    checkout: info,
    env,
    envFiles,
    databaseUrl: env["DATABASE_URL"] ?? "",
    adminDatabaseUrl,
    webUrl,
  };
}

/** The `-p …` and `-f …` a `docker compose` call from this checkout must always carry. */
export function composeArgs(info: Checkout): string[] {
  return ["compose", "-p", info.composeProject, "-f", "docker-compose.dev.yml"];
}

/** The published-port variables `docker-compose.dev.yml` interpolates. */
export function composeEnv(info: Checkout): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: info.composeProject,
    MM_TOOLBOX_PORT: String(info.toolboxPort),
    MM_NAVIDROME_PORT: String(info.navidromePort),
    MM_POSTGRES_PORT: String(info.postgresPort),
  };
}

/** One line per fact, printed by `bun run dev` and `bun run stack:info`. */
export function describeCheckout(resolved: DevEnv): string {
  const info = resolved.checkout;
  const rows: [string, string][] = [
    ["checkout", `${info.root}${info.isPrimary ? "  (primary — the shared stack)" : ""}`],
    ["branch", info.branch],
    ["compose project", info.composeProject],
    ["toolbox", resolved.env["MM_TOOLBOX_URL"] ?? `http://localhost:${String(info.toolboxPort)}`],
    ["library", resolved.env["MM_LIBRARY_ROOT"] ?? info.libraryRoot],
    ["database", resolved.databaseUrl.replace(/:[^:@/]*@/, ":***@")],
    ["web url", resolved.webUrl],
    ["portless app", info.appName],
    [".env", resolved.envFiles.join(", ") || "(none found)"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n");
}
