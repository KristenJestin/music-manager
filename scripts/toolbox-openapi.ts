/**
 * `bun run toolbox:openapi` — regenerate the typed contract for the Python toolbox.
 *
 * The FastAPI app is imported (not served) and asked for its OpenAPI document, which is
 * written with sorted keys so that two consecutive runs produce byte-identical files.
 * `openapi-typescript` then turns it into the client types used by `apps/web` on the
 * server side only — the browser never talks to Python.
 *
 * Never edit packages/contracts/toolbox/ by hand.
 */
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { bunx, capture, repoRoot, runSequence, toolboxDir, resolveUv } from "./lib.ts";

const outDir = join(repoRoot, "packages", "contracts", "toolbox");
const openapiPath = join(outDir, "openapi.json");
const clientPath = join(outDir, "client.d.ts");

const DUMP = [
  "import json",
  "from toolbox.app import app",
  "print(json.dumps(app.openapi(), indent=2, sort_keys=True))",
].join("; ");

await mkdir(outDir, { recursive: true });

console.log("=== dumping the toolbox OpenAPI document ===");
const dumped = await capture({
  label: "openapi dump",
  cmd: [resolveUv(), "run", "python", "-c", DUMP],
  cwd: toolboxDir,
});
if (dumped.code !== 0) {
  console.error(dumped.stderr);
  process.exit(dumped.code);
}

const document: unknown = JSON.parse(dumped.stdout);
await Bun.write(openapiPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${relative(repoRoot, openapiPath)}`);

await runSequence([
  {
    label: "openapi-typescript",
    cmd: bunx("openapi-typescript", openapiPath, "-o", clientPath),
  },
]);
console.log(`wrote ${relative(repoRoot, clientPath)}`);
