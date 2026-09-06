/**
 * `bun run dev` — bring this checkout's stack up, then run the web app.
 *
 * Postgres, Navidrome and the toolbox run in Docker; only the web app runs on the host so
 * that HMR works. Ctrl-C stops the web app and leaves the containers running.
 *
 * Three things it decides for you, each because getting them wrong fails far from its cause:
 *
 * **The port.** `PORT`, default 3000. It stopped being a constant because `:3000` on this
 * machine belongs to an unrelated project as often as not, and because several agents share the
 * host (`CLAUDE.md`'s process-safety note): `PORT=3100 bun run dev` is the normal way to get a
 * server of your own. Under portless (`bun run dev:portless`) the port is handed to us and is
 * nobody's business.
 *
 * **`MM_WEB_URL`.** Better Auth checks the browser's origin against it, so an app served on any
 * other origin than the default `http://localhost:3000` gives you a login form that renders
 * perfectly and answers *"Invalid origin"* on submit. `scripts/checkout.ts` derives it from
 * `PORTLESS_URL` when portless launched us, and from `PORT` otherwise. An explicit value always
 * wins — that is the reverse-proxy case.
 *
 * **Which containers and which database.** From `v2/` that is the shared `mm-dev` stack, as it
 * always was. From a `git worktree` it is a toolbox, a database and a library of that
 * worktree's own; see `scripts/checkout.ts` and `scripts/stack.ts`.
 *
 * `.env` is read by those modules and handed to the child explicitly. Bun loads `.env` from the
 * *current directory*, so it happens to be loaded for this script — and is silently **not**
 * loaded by `bun run --cwd apps/web dev`, whose cwd is `apps/web`. That asymmetry is the reason
 * the app behaves differently depending on how you start it, so this script stops relying on it.
 */
import { bunRun, run, webDir } from "./lib.ts";
import { stackUp } from "./stack.ts";

const resolved = await stackUp({ navidrome: process.argv.includes("--navidrome") });

const port = resolved.env["PORT"] ?? process.env["PORT"] ?? "3000";
const childEnv = { ...resolved.env, PORT: port };

console.log(`\n=== apps/web dev server ===`);
console.log(`  listening on  http://localhost:${port}`);
console.log(`  open          ${resolved.webUrl}`);

process.exit(await run({ label: "web dev", cmd: bunRun(webDir, "dev"), env: childEnv }));
