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
