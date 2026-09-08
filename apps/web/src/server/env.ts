import { z } from "zod";

/**
 * Server-side environment. Nothing here may ever reach the browser.
 *
 * Validation is lazy (`serverEnv()`), not module-level, so that unit tests and
 * `tsc` never require a database URL to be present.
 */
const envSchema = z.object({
  /** postgres-js connection string, e.g. postgres://mm:mm@localhost:5432/mm */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Base URL of the Python toolbox service. */
  MM_TOOLBOX_URL: z.url().default("http://localhost:8100"),
  /** Bearer token for the toolbox. Empty means the toolbox check is disabled. */
  MM_TOOLBOX_TOKEN: z.string().default(""),
  /** "1" runs the whole stack offline against recorded fixtures. */
  MM_FIXTURES: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),

  /**
   * The music library, **as this process sees it**. On the developer's machine that is a
   * Windows path; in production it is the shared volume.
   */
  MM_LIBRARY_ROOT: z.string().default("./.local/library"),

  /**
   * Where `mm migrate v1` writes the exported M3U playlists. Empty means
   * `<library>/_archive/v1-playlists`, the only directory production is sure to own.
   */
  MM_PLAYLIST_EXPORT_DIR: z.string().default(""),

  /**
   * The same directory, **as the toolbox container sees it** — the other end of the bind
   * mount of `docker-compose.dev.yml`. Every path handed to or returned by the toolbox is
   * translated between the two (see `src/server/paths.ts`); nothing else would work when the
   * orchestrator runs on Windows and the toolbox in Linux.
   */
  MM_TOOLBOX_LIBRARY_ROOT: z.string().default("/library"),

  /**
   * Where downloads land before `place` moves them. Relative to the library root so that it
   * is inside the same bind mount, and dot-prefixed so Navidrome's scanner ignores it —
   * which also makes `place` a rename on the same filesystem, hence genuinely atomic.
   */
  MM_WORK_DIR: z.string().default(".mm-work"),

  /** Base URL of the web app, for the CLI's `--follow` and the E2E's SSE check. */
  MM_WEB_URL: z.url().default("http://localhost:3000"),

  /* ---- authentication (P06) ------------------------------------------- */

  /**
   * The signing secret for sessions. Better Auth also reads `BETTER_AUTH_SECRET`; this is the
   * `MM_`-prefixed name so that one `.env` describes the whole app.
   *
   * Empty is tolerated for local development — the auth module then derives a stable secret
   * from the database URL and says so — and refused in production, where a guessable session
   * signature is the whole of the security model.
   */
  MM_AUTH_SECRET: z.string().default(""),

  /**
   * The single administrator, created on first boot (`docs/phases/P06-web-coeur.md`).
   * When either is missing the app serves `/setup` once instead, and nothing else.
   */
  MM_ADMIN_EMAIL: z.string().default(""),
  MM_ADMIN_PASSWORD: z.string().default(""),

  /**
   * "1" when a reverse proxy terminates TLS in front of this process.
   *
   * It does two things: it makes the session cookie `Secure` even though this process only
   * speaks HTTP, and it lets `x-forwarded-proto`/`-host` be believed. Both are wrong to do
   * when nothing trustworthy sets those headers, which is why it is opt-in.
   */
  MM_BEHIND_PROXY: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),

  /** `production` hardens the cookie and refuses an empty `MM_AUTH_SECRET`. */
  NODE_ENV: z.string().default("development"),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

/** Parse and cache the environment. Throws a readable error on a bad or missing value. */
export function serverEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment. Copy .env.example to .env and fix:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached environment. */
export function resetServerEnv(): void {
  cached = undefined;
}

export { envSchema };
