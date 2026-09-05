/**
 * Shared helpers for the root scripts. Everything here must work identically under
 * Windows (PowerShell or Git Bash) and Linux: no shell, no bash-isms, no `make`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (the directory holding package.json). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Bun binary currently running. Used instead of the string "bun" for portability. */
export const bun = process.execPath;

export const toolboxDir = join(repoRoot, "services", "toolbox");
export const webDir = join(repoRoot, "apps", "web");

export interface Step {
  label: string;
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Run one command, streaming its output. Returns the exit code. */
export async function run(step: Step): Promise<number> {
  const [command, ...args] = step.cmd;
  if (!command) throw new Error(`empty command for step "${step.label}"`);
  const proc = Bun.spawn([command, ...args], {
    cwd: step.cwd ?? repoRoot,
    env: { ...process.env, ...step.env },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await proc.exited;
}

/** Run a command and capture stdout instead of streaming it. */
export async function capture(
  step: Step,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const [command, ...args] = step.cmd;
  if (!command) throw new Error(`empty command for step "${step.label}"`);
  const proc = Bun.spawn([command, ...args], {
    cwd: step.cwd ?? repoRoot,
    env: { ...process.env, ...step.env },
    stdio: ["inherit", "pipe", "pipe"],
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Run steps in order, stopping at the first failure. Exits the process on failure. */
export async function runSequence(steps: Step[]): Promise<void> {
  const started = Date.now();
  for (const step of steps) {
    console.log(`\n=== ${step.label} ===`);
    const code = await run(step);
    if (code !== 0) {
      console.error(`\nFAILED: ${step.label} (exit ${code})`);
      process.exit(code);
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nOK: ${steps.length} steps passed in ${seconds}s`);
}

/**
 * Locate `uv`. It is frequently installed to ~/.local/bin without being added to PATH
 * (notably in Git Bash on Windows), so fall back to the well-known install location.
 */
export function resolveUv(): string {
  const onPath = Bun.which("uv");
  if (onPath) return onPath;
  const home = process.env.USERPROFILE ?? homedir();
  for (const candidate of [
    join(home, ".local", "bin", "uv.exe"),
    join(home, ".local", "bin", "uv"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "uv not found. Install it from https://docs.astral.sh/uv/ or make sure it is on PATH " +
      "(it is normally at %USERPROFILE%\\.local\\bin\\uv.exe).",
  );
}

/** Locate `docker`, or return null when Docker Desktop is not installed. */
export function resolveDocker(): string | null {
  return Bun.which("docker");
}

/** True when the Docker daemon answers, not merely when the CLI exists. */
export async function dockerIsRunning(): Promise<boolean> {
  const docker = resolveDocker();
  if (!docker) return false;
  const proc = Bun.spawn([docker, "info"], { stdio: ["ignore", "ignore", "ignore"] });
  return (await proc.exited) === 0;
}

/** A `bun x <tool>` invocation, which resolves workspace binaries on every platform. */
export function bunx(tool: string, ...args: string[]): string[] {
  return [bun, "x", tool, ...args];
}

/** A `bun run --cwd <dir> <script>` invocation. */
export function bunRun(cwd: string, script: string, ...args: string[]): string[] {
  return [bun, "run", "--cwd", cwd, script, ...args];
}
