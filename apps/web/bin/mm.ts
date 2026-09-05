#!/usr/bin/env bun
/**
 * `mm` — the command line. `bun run mm -- <command>` from the repository root.
 *
 * In P03 it calls the services **in the same process** (P08 moves it onto `/api/v1`), with
 * one exception: it does not execute the pipeline itself. `mm import` creates the job, runs
 * `resolve` in-process so the answer is immediate, and then drops it on the queue — because
 * the download slot is global and one worker owns it. A CLI that ran steps of its own would
 * be a second worker, and two workers downloading at once is exactly what `docs/06-stack.md`
 * forbids.
 *
 * `--follow` tails `job_events` over LISTEN/NOTIFY, which is the same stream the Console's
 * SSE endpoint serves, so the two can never disagree about what happened.
 */
import { readFileSync } from "node:fs";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import type { StepName } from "#/server/db/schema/index.ts";
import { STEP_ORDER } from "#/server/services/jobs/machine.ts";
import { readEvents, subscribe } from "#/server/services/events.ts";
import { getInboxItem, listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import {
  bumpImport,
  cancelImport,
  listImports,
  pauseImport,
  retryStep,
  stepsOf,
} from "#/server/services/jobs/index.ts";
import {
  isSettingKey,
  loadSettings,
  parseCliValue,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  setSetting,
  type SettingKey,
} from "#/server/services/settings.ts";
import { createBoss, enqueueDownload, enqueueImportStep, stopBoss } from "#/worker/queues.ts";

/* ------------------------------------------------------------------ */
/* argument parsing                                                    */
/* ------------------------------------------------------------------ */

interface Args {
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagBoolean(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

const STATUS_MARK: Record<string, string> = {
  done: "ok  ",
  skipped: "skip",
  running: "..  ",
  blocked: "wait",
  failed: "FAIL",
  pending: "    ",
};

function line(...parts: unknown[]): void {
  console.log(parts.join(" "));
}

function fail(error: unknown): never {
  const failure = MMError.from(error);
  console.error(`\n${failure.code}: ${failure.message}`);
  if (failure.hint !== undefined) console.error(`hint: ${failure.hint}`);
  if (failure.action !== undefined) console.error(`try : ${failure.action}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* follow                                                             */
/* ------------------------------------------------------------------ */

const TERMINAL_EVENTS = new Set(["import.done", "import.failed", "import.cancelled"]);

/**
 * Tail an import's journal until it stops.
 *
 * A blocked job is a stopping point too: waiting for a confirmation that has to be given in
 * another terminal would just look like a hang.
 */
async function followImport(importId: string): Promise<number> {
  return await new Promise<number>((finish) => {
    let exitCode = 0;
    void subscribe({
      importId,
      onEvent: (event) => {
        const mark = event.level === "error" ? "!" : event.level === "warn" ? "~" : " ";
        line(`${mark} [${event.step ?? "-"}] ${event.message}`);
        if (event.type === "import.failed") exitCode = 1;
        if (
          TERMINAL_EVENTS.has(event.type) ||
          (event.type === "import.status" &&
            /awaiting_confirm|awaiting_review|paused/.test(event.message))
        ) {
          finish(exitCode);
        }
      },
    }).then((subscription) => {
      const close = (): void => void subscription.unsubscribe();
      process.on("exit", close);
    });
  });
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdImport(args: Args): Promise<number> {
  const url = args.positional[1];
  if (url === undefined) throw new MMError("INVALID_INPUT", "usage: mm import <url|fixture://…>");

  const mappingFile = flagString(args, "mapping");
  const mapping =
    mappingFile === undefined
      ? undefined
      : (JSON.parse(readFileSync(mappingFile, "utf8")) as never);

  const created = await createFromUrl(url, {
    ...(flagString(args, "release") === undefined
      ? {}
      : { releaseMbid: flagString(args, "release") }),
    ...(mapping === undefined ? {} : { mapping }),
    autoConfirm: flagBoolean(args, "yes"),
    force: flagBoolean(args, "force"),
    ...(flagBoolean(args, "no-fingerprint") ? { fingerprint: false } : {}),
  });

  line(`import ${created.job.id}`);
  line(`  url    ${created.job.url}`);
  line(`  kind   ${created.job.kind}`);
  line(`  title  ${created.job.title ?? "-"}`);
  if (created.duplicates.length > 0) {
    line(`  note   ${String(created.duplicates.length)} earlier import(s) of the same URL`);
  }

  const boss = createBoss({ producer: true });
  await boss.start();
  await enqueueImportStep(boss, { importId: created.job.id, reason: "cli" });
  await stopBoss(boss);
  line(`  queued on import.step — run \`bun run worker\` if nothing moves`);

  if (!flagBoolean(args, "follow")) return 0;
  line("");
  const code = await followImport(created.job.id);
  await printJob(created.job.id);
  return code;
}

async function cmdJobs(): Promise<number> {
  const rows = await listImports({ limit: 50 });
  if (rows.length === 0) {
    line("no imports yet — `mm import fixture://discovery --yes --follow`");
    return 0;
  }
  line("ID                              STATUS            STEP         KIND      TITLE");
  for (const row of rows) {
    line(
      row.id.padEnd(31),
      row.status.padEnd(17),
      row.step.padEnd(12),
      row.kind.padEnd(9),
      row.title ?? row.url,
    );
  }
  return 0;
}

async function printJob(id: string): Promise<void> {
  const job = await getImport(id);
  if (job === null) throw new MMError("NOT_FOUND", `No import with id ${id}.`);
  line("");
  line(`import ${job.id}`);
  line(`  url      ${job.url}`);
  line(`  status   ${job.status}  (step ${job.step})`);
  line(`  release  ${job.releaseMbid ?? "-"}`);
  if (job.error !== null) line(`  error    ${job.error.code}: ${job.error.message}`);
  line("");
  for (const { step, row } of await stepsOf(id)) {
    const status = row?.status ?? "pending";
    line(` ${STATUS_MARK[status] ?? status} ${step.padEnd(12)} ${row?.message ?? ""}`);
  }
  const open = await listInbox({ importId: id, status: "open" });
  if (open.length > 0) {
    line("");
    line(` inbox (${String(open.length)} open):`);
    for (const item of open) line(`   ${item.id}  ${item.type}  ${item.title}`);
  }
}

async function cmdJob(args: Args): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) throw new MMError("INVALID_INPUT", "usage: mm job <id> [--follow]");
  if (flagBoolean(args, "follow")) {
    const recent = await readEvents({ importId: id, limit: 20 });
    for (const event of recent) line(`  [${event.step ?? "-"}] ${event.message}`);
    const code = await followImport(id);
    await printJob(id);
    return code;
  }
  await printJob(id);
  return 0;
}

async function cmdRetry(args: Args): Promise<number> {
  const id = args.positional[1];
  const step = flagString(args, "step");
  if (id === undefined || step === undefined) {
    throw new MMError("INVALID_INPUT", `usage: mm retry <id> --step <${STEP_ORDER.join("|")}>`);
  }
  if (!(STEP_ORDER as readonly string[]).includes(step)) {
    throw new MMError("INVALID_INPUT", `Unknown step "${step}". One of: ${STEP_ORDER.join(", ")}.`);
  }
  const outcome = await retryStep(id, step as StepName, { db: db(), only: true });
  line(`retried ${step}: ${outcome.ran[0]?.result.status ?? "?"}`);

  const boss = createBoss({ producer: true });
  await boss.start();
  if (outcome.step === "download") await enqueueDownload(boss, { importId: id });
  else await enqueueImportStep(boss, { importId: id, reason: "retry" });
  await stopBoss(boss);

  await printJob(id);
  return 0;
}

async function cmdInbox(args: Args): Promise<number> {
  const sub = args.positional[1] ?? "list";
  if (sub === "list") {
    const items = await listInbox({
      ...(flagBoolean(args, "all") ? {} : { status: "open" as const }),
    });
    if (items.length === 0) {
      line("inbox empty");
      return 0;
    }
    line("ID                              TYPE                  STATUS     TITLE");
    for (const item of items) {
      line(item.id.padEnd(31), item.type.padEnd(21), item.status.padEnd(10), item.title);
    }
    return 0;
  }

  if (sub === "resolve") {
    const id = args.positional[2];
    if (id === undefined) {
      throw new MMError("INVALID_INPUT", "usage: mm inbox resolve <id> --accept");
    }
    const item = await getInboxItem(id);
    if (item === null) throw new MMError("NOT_FOUND", `No Inbox item with id ${id}.`);

    const accept = flagBoolean(args, "accept");
    const resolution = accept
      ? { accepted: true, ...(item.preselected ?? {}) }
      : { accepted: false, action: "dismiss" };
    await resolveInboxItem(id, {
      resolution,
      decidedBy: "cli",
      status: accept ? "resolved" : "dismissed",
    });
    line(`${accept ? "accepted" : "dismissed"} ${item.type} — ${item.title}`);

    // The job was parked waiting for exactly this. Put it back on the queue.
    if (item.importId !== null) {
      const boss = createBoss({ producer: true });
      await boss.start();
      await enqueueImportStep(boss, { importId: item.importId, reason: "inbox resolved" });
      await stopBoss(boss);
      line(`resumed ${item.importId}`);
      if (flagBoolean(args, "follow")) {
        const code = await followImport(item.importId);
        await printJob(item.importId);
        return code;
      }
    }
    return 0;
  }

  throw new MMError("INVALID_INPUT", "usage: mm inbox list | mm inbox resolve <id> --accept");
}

async function cmdSettings(args: Args): Promise<number> {
  const sub = args.positional[1] ?? "get";
  if (sub === "get") {
    const key = args.positional[2];
    const all = await loadSettings();
    if (key === undefined) {
      for (const name of SETTING_KEYS) {
        line(name.padEnd(30), JSON.stringify(all[name]));
      }
      return 0;
    }
    if (!isSettingKey(key)) throw new MMError("INVALID_INPUT", `Unknown setting "${key}".`);
    line(JSON.stringify(all[key]));
    return 0;
  }

  if (sub === "set") {
    const key = args.positional[2];
    const raw = args.positional[3];
    if (key === undefined || raw === undefined) {
      throw new MMError("INVALID_INPUT", "usage: mm settings set <key> <value>");
    }
    if (!isSettingKey(key)) throw new MMError("INVALID_INPUT", `Unknown setting "${key}".`);
    const value = await setSetting(key as SettingKey, parseCliValue(key as SettingKey, raw), {
      setBy: "cli",
    });
    line(`${key} = ${JSON.stringify(value)}`);
    return 0;
  }

  if (sub === "list") {
    for (const name of SETTING_KEYS) {
      line(name.padEnd(30), SETTING_DEFINITIONS[name].doc);
    }
    return 0;
  }

  throw new MMError("INVALID_INPUT", "usage: mm settings get|set|list");
}

async function cmdControl(args: Args, action: "cancel" | "pause" | "bump"): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) throw new MMError("INVALID_INPUT", `usage: mm ${action} <id>`);
  if (action === "cancel") await cancelImport(id);
  if (action === "pause") await pauseImport(id, "paused from the CLI");
  if (action === "bump") {
    const priority = await bumpImport(id);
    line(`priority ${String(priority)}`);
  }
  await printJob(id);
  return 0;
}

const USAGE = `mm — Music Manager

  mm import <url|fixture://…> [--release <mbid>] [--mapping <file.json>] [--yes] [--force] [--follow]
  mm jobs
  mm job <id> [--follow]
  mm retry <id> --step <${STEP_ORDER.join("|")}>
  mm inbox list [--all]
  mm inbox resolve <id> --accept [--follow]
  mm settings get [key] | set <key> <value> | list
  mm pause <id> | mm cancel <id> | mm bump <id>

Environment: DATABASE_URL, MM_TOOLBOX_URL, MM_FIXTURES, MM_LIBRARY_ROOT, MM_TOOLBOX_LIBRARY_ROOT.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];

  switch (command) {
    case "import":
      return await cmdImport(args);
    case "jobs":
      return await cmdJobs();
    case "job":
      return await cmdJob(args);
    case "retry":
      return await cmdRetry(args);
    case "inbox":
      return await cmdInbox(args);
    case "settings":
      return await cmdSettings(args);
    case "cancel":
    case "pause":
    case "bump":
      return await cmdControl(args, command);
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command "${command}"\n`);
      console.log(USAGE);
      return 2;
  }
}

try {
  process.exit(await main());
} catch (error) {
  fail(error);
}
