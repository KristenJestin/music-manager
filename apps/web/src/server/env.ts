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
