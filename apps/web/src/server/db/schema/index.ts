/**
 * Drizzle is the single owner of the database schema (`docs/06-stack.md`). Python never
 * touches it.
 *
 * The tables of `docs/04-pipeline-et-matching.md` § Modèle and `docs/03-metadonnees.md` §1,
 * grouped by the layer they belong to:
 *
 *  - `enums`     the closed vocabularies (steps, statuses, Inbox types);
 *  - `imports`   the jobs and their videos;
 *  - `jobs`      step history and the append-only journal;
 *  - `library`   what is on disk;
 *  - `metadata`  raw cache, documents, artists;
 *  - `inbox`     pending questions and the decisions taken;
 *  - `settings`  the typed KV store;
 *  - `auth`      Better Auth's four tables (P06).
 */
export * from "./meta.ts";
export * from "./enums.ts";
export * from "./imports.ts";
export * from "./jobs.ts";
export * from "./library.ts";
export * from "./metadata.ts";
export * from "./inbox.ts";
export * from "./settings.ts";
export * from "./auth.ts";
