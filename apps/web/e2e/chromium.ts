/**
 * Which Chromium Playwright drives.
 *
 * `CLAUDE.md`: browser tests reuse **the Chromium already on the machine**, never a separate
 * Playwright browser install. `npx playwright install` is not run here and must not be.
 *
 * Two details of this machine are baked in, and both are documented rather than worked around
 * silently:
 *
 *  - **The full browser, not the headless shell.** Playwright prefers
 *    `chromium_headless_shell-<rev>`, which on this host fails to complete its CDP handshake
 *    and hangs until the launch timeout. `chrome-win64/chrome.exe` from the same revision
 *    starts immediately, so it is named explicitly.
 *  - **`--no-sandbox`.** The cached binary lives under `%LOCALAPPDATA%`, where Chromium's
 *    sandbox cannot open its own executable (`Sandbox cannot access executable … Access is
 *    denied`); the network service then crashes and restarts in a loop. The pages under test
 *    are our own dev server, so dropping the sandbox costs nothing here.
 *
 * `MM_E2E_CHROMIUM` overrides everything, for a machine whose browser is somewhere else — for
 * example the Chromium the `agent-browser` CLI installed.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

/** Where Playwright keeps its browsers, per platform. */
function cacheRoot(): string {
  const override = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (override !== undefined && override !== "") return override;
  switch (platform()) {
    case "win32":
      return join(
        process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
        "ms-playwright",
      );
    case "darwin":
      return join(homedir(), "Library", "Caches", "ms-playwright");
    default:
      return join(homedir(), ".cache", "ms-playwright");
  }
}

/** The full-browser executable inside one `chromium-<rev>` directory, if it is there. */
function executableIn(directory: string): string | null {
  const candidates = [
    join(directory, "chrome-win64", "chrome.exe"),
    join(directory, "chrome-win", "chrome.exe"),
    join(directory, "chrome-linux", "chrome"),
    join(directory, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * The newest cached Chromium, or `undefined` to let Playwright decide.
 *
 * Newest rather than "the revision this Playwright shipped with": the point is to use what is
 * already installed. A mismatch shows up as a protocol error at launch, loudly, which is a
 * better failure than downloading 150 MB in the middle of a test run.
 */
export function chromiumExecutable(): string | undefined {
  const override = process.env["MM_E2E_CHROMIUM"];
  if (override !== undefined && override !== "") return override;

  const root = cacheRoot();
  if (!existsSync(root)) return undefined;

  const revisions = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .map((name) => ({ name, revision: Number.parseInt(name.slice("chromium-".length), 10) }))
    .sort((a, b) => b.revision - a.revision);

  for (const { name } of revisions) {
    const executable = executableIn(join(root, name));
    if (executable !== null) return executable;
  }
  return undefined;
}

/** The flags this host needs. See the note above about the sandbox. */
export const CHROMIUM_ARGS = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"];
