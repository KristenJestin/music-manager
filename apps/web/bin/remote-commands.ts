/**
 * The remote half of `mm`: the same verbs, spoken over `/api/v1`.
 *
 * Like `bin/remote.ts`, this imports **nothing** from `#/server/**` — see the note there. It is
 * a separate file from the client for the ordinary reason: one module knows how to talk HTTP,
 * the other knows what the words mean.
 *
 * Where the local CLI and this one print the same thing, they print it the same way, because
 * the shapes are the same shapes: `GET /imports` returns the rows `listImports` returns, so the
 * column layout is copied deliberately rather than reinvented. `--json` prints the server's
 * payload verbatim — an agent should get what the API said, not this file's opinion of it.
 */
import { readFileSync } from "node:fs";
import type { ApiClient } from "./remote.ts";

export interface RemoteArgs {
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

const line = (...parts: unknown[]): void => {
  console.log(parts.join(" "));
};

const flagString = (args: RemoteArgs, name: string): string | undefined =>
  typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined;

const flagBool = (args: RemoteArgs, name: string): boolean =>
  args.flags[name] === true || args.flags[name] === "true";

const asJson = (args: RemoteArgs): boolean => flagBool(args, "json");

function dump(value: unknown): number {
  console.log(JSON.stringify(value, null, 2));
  return 0;
}

const STATUS_MARK: Record<string, string> = {
  done: "ok  ",
  skipped: "skip",
  running: "..  ",
  blocked: "wait",
  failed: "FAIL",
  pending: "    ",
};

/* ------------------------------------------------------------------ */
/* shapes, as the API returns them                                     */
/* ------------------------------------------------------------------ */

interface ImportRow {
  id: string;
  url: string;
  kind: string;
  status: string;
  step: string;
  title: string | null;
  releaseMbid: string | null;
  error: { code: string; message: string } | null;
}

interface ImportDetail extends ImportRow {
  steps: { step: string; status: string; message: string | null }[];
  tracks: { position: number; title: string; status: string }[];
  inbox: { id: string; type: string; title: string; status: string }[];
}

/* ------------------------------------------------------------------ */
/* follow                                                              */
/* ------------------------------------------------------------------ */

const TERMINAL = new Set(["import.done", "import.failed", "import.cancelled"]);

/**
 * Tail one import's journal over SSE until it stops.
 *
 * "Stops" includes reaching a state that waits for a human: a job parked on
 * `awaiting_review` is not going to move until somebody answers, and printing a spinner at it
 * for ever would look like a hang rather than like a question.
 */
async function followImport(api: ApiClient, importId: string): Promise<number> {
  let exitCode = 0;
  await api.stream({ import: importId }, (event) => {
    const type = String(event["type"] ?? "");
    const level = String(event["level"] ?? "info");
    const mark = level === "error" ? "!" : level === "warn" ? "~" : " ";
    const step = event["step"] === null ? "-" : String(event["step"]);
    line(`${mark} [${step}] ${String(event["message"] ?? "")}`);
    if (type === "import.failed") exitCode = 1;
    if (
      TERMINAL.has(type) ||
      (type === "import.status" &&
        /awaiting_confirm|awaiting_review|paused/.test(String(event["message"] ?? "")))
    ) {
      return true;
    }
    return false;
  });
  return exitCode;
}

async function printJob(api: ApiClient, id: string): Promise<void> {
  const job = await api.get<ImportDetail>(`/imports/${id}`);
  line("");
  line(`import ${job.id}`);
  line(`  url      ${job.url}`);
  line(`  status   ${job.status}  (step ${job.step})`);
  line(`  release  ${job.releaseMbid ?? "-"}`);
  if (job.error !== null) line(`  error    ${job.error.code}: ${job.error.message}`);
  line("");
  for (const step of job.steps) {
    line(
      ` ${STATUS_MARK[step.status] ?? step.status} ${step.step.padEnd(12)} ${step.message ?? ""}`,
    );
  }
  const open = job.inbox.filter((item) => item.status === "open");
  if (open.length > 0) {
    line("");
    line(` inbox (${String(open.length)} open):`);
    for (const item of open) line(`   ${item.id}  ${item.type}  ${item.title}`);
  }
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/**
 * One URL per line, `#` comments and blank lines dropped.
 *
 * The file is the interface a bulk import actually has: three hundred and seventy-five
 * playlists arrive as a list somebody already has in a text file, not as three hundred and
 * seventy-five arguments a shell would refuse to expand anyway.
 */
function urlsFromFile(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== "" && !row.startsWith("#"));
}

async function cmdImport(api: ApiClient, args: RemoteArgs): Promise<number> {
  const fromFile = flagString(args, "from-file");
  if (fromFile !== undefined) return await importBatch(api, args, urlsFromFile(fromFile));

  const url = args.positional[1];
  if (url === undefined) {
    throw new Error("usage: mm import <url|fixture://…> | mm import --from-file <path>");
  }

  // Flat since the breaking change of `feat-api-bulk`: the import's own fields are at the top
  // level of the answer, next to `duplicates`. `created.import.id` is what this used to read.
  const created = await api.post<ImportRow & { duplicates: string[] }>("/imports", {
    url,
    ...(flagString(args, "release") === undefined
      ? {}
      : { releaseMbid: flagString(args, "release") }),
    options: {
      autoConfirm: flagBool(args, "yes"),
      force: flagBool(args, "force"),
      fingerprint: !flagBool(args, "no-fingerprint"),
    },
    priority: flagBool(args, "next") ? "next" : "normal",
  });

  if (asJson(args) && !flagBool(args, "follow")) return dump(created);

  line(`import ${created.id}`);
  line(`  url    ${created.url}`);
  line(`  kind   ${created.kind}`);
  line(`  title  ${created.title ?? "-"}`);
  if (created.duplicates.length > 0) {
    line(`  note   ${String(created.duplicates.length)} earlier import(s) of the same URL`);
  }
  line(`  queued on the server's worker`);

  if (!flagBool(args, "follow")) return 0;
  line("");
  const code = await followImport(api, created.id);
  if (asJson(args)) return dump(await api.get(`/imports/${created.id}`));
  await printJob(api, created.id);
  return code;
}

interface BatchLine {
  index: number;
  url: string;
  ok: boolean;
  id: string | null;
  error: { code: string; message: string } | null;
}

/**
 * `mm import --from-file <path>` — one HTTP call per hundred URLs instead of one per URL.
 *
 * The server refuses more than a hundred in a batch, so the list is chunked here rather than
 * handed over whole and bounced back: a person with four hundred URLs in a file wants them
 * imported, not a lecture about a limit they did not choose.
 */
async function importBatch(api: ApiClient, args: RemoteArgs, urls: string[]): Promise<number> {
  if (urls.length === 0) throw new Error("that file holds no URLs");
  const chunkSize = 100;
  const results: BatchLine[] = [];
  let created = 0;

  for (let start = 0; start < urls.length; start += chunkSize) {
    const payload = await api.post<{ created: number; results: BatchLine[] }>("/imports/batch", {
      urls: urls.slice(start, start + chunkSize),
      options: {
        autoConfirm: flagBool(args, "yes"),
        force: flagBool(args, "force"),
        fingerprint: !flagBool(args, "no-fingerprint"),
      },
      priority: flagBool(args, "next") ? "next" : "normal",
    });
    created += payload.created;
    // The server numbers each line inside its own chunk; renumber against the whole file so
    // "line 214 was refused" points at line 214 of what the user typed.
    for (const row of payload.results) results.push({ ...row, index: row.index + start });
  }

  if (asJson(args)) return dump({ requested: urls.length, created, results });

  line(`${String(created)} of ${String(urls.length)} import(s) created and queued`);
  for (const row of results) {
    if (row.ok) continue;
    line(`  ! ${String(row.index + 1).padStart(4)}  ${row.url}`);
    line(`         ${row.error?.code ?? "UNKNOWN"}: ${row.error?.message ?? ""}`);
  }
  // A batch that lost nothing still exits 0; one that lost a URL says so in its exit code, so
  // a script looping over files can tell.
  return created === urls.length ? 0 : 1;
}

/** `mm confirm-best <id>` — the automatic confirmation, as the API does it. */
async function cmdConfirmBest(api: ApiClient, args: RemoteArgs): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) {
    throw new Error(
      "usage: mm confirm-best <id> [--min-coverage 0.8] [--min-margin 0.04] [--prefer album|any]",
    );
  }
  const coverage = flagString(args, "min-coverage");
  const margin = flagString(args, "min-margin");
  const prefer = flagString(args, "prefer");
  const payload = await api.post<
    ImportRow & {
      kind: "album" | "single";
      chosenTitle: string;
      chosenArtist: string;
      chosenType: string | null;
      recordingMbid: string | null;
      coverage: number | null;
      margin: number | null;
      minMargin: number | null;
      durationDelta: number | null;
      mapped: number | null;
      extras: number | null;
      uncovered: number;
    }
  >(`/imports/${id}/confirm-best`, {
    ...(coverage === undefined ? {} : { minCoverage: Number(coverage) }),
    ...(margin === undefined ? {} : { minMargin: Number(margin) }),
    ...(prefer === undefined ? {} : { preferType: prefer }),
    confirmedBy: "cli confirm-best",
  });

  if (asJson(args)) return dump(payload);
  line(`confirmed ${payload.id} (${payload.kind})`);
  if (payload.kind === "single") {
    line(
      `  recording ${payload.chosenArtist} — ${payload.chosenTitle}  ${payload.recordingMbid ?? "-"}`,
    );
    line(`  filed as  ${payload.chosenType ?? "release"}  ${payload.releaseMbid ?? "-"}`);
    line(
      `  margin   ${payload.margin === null ? "no runner-up" : String(payload.margin)}` +
        ` over ${String(payload.minMargin ?? 0)}` +
        `, duration ${payload.durationDelta === null ? "?" : `${String(payload.durationDelta)} s`}`,
    );
  } else {
    line(
      `  release  ${payload.chosenArtist} — ${payload.chosenTitle}` +
        ` (${payload.chosenType ?? "?"})  ${payload.releaseMbid ?? "-"}`,
    );
    line(`  coverage ${String(Math.round((payload.coverage ?? 0) * 100))} %`);
  }
  line(
    `  mapped   ${String(payload.mapped ?? 0)} track(s), ` +
      `${String(payload.extras ?? 0)} extra, ${String(payload.uncovered)} uncovered`,
  );
  return 0;
}

async function cmdJobs(api: ApiClient, args: RemoteArgs): Promise<number> {
  const limit = Number(flagString(args, "limit") ?? "50");
  const offset = Number(flagString(args, "offset") ?? "0");
  const payload = await api.get<{
    imports: ImportRow[];
    total: number;
    hasMore: boolean;
  }>("/imports", {
    limit,
    offset,
    ...(flagString(args, "status") === undefined ? {} : { status: flagString(args, "status") }),
  });
  if (asJson(args)) return dump(payload);
  if (payload.imports.length === 0) {
    line("no imports yet — `mm import fixture://discovery --yes --follow`");
    return 0;
  }
  line("ID                              STATUS            STEP         KIND      TITLE");
  for (const row of payload.imports) {
    line(
      row.id.padEnd(31),
      row.status.padEnd(17),
      row.step.padEnd(12),
      row.kind.padEnd(9),
      row.title ?? row.url,
    );
  }
  // The number the list used not to carry, and the reason a bulk session read the same fifty
  // rows three times.
  line("");
  line(
    `${String(payload.imports.length)} of ${String(payload.total)} shown` +
      (payload.hasMore ? ` — next page: --offset ${String(offset + limit)}` : ""),
  );
  return 0;
}

async function cmdJob(api: ApiClient, args: RemoteArgs): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) throw new Error("usage: mm job <id> [--follow]");
  if (flagBool(args, "follow")) {
    const code = await followImport(api, id);
    await printJob(api, id);
    return code;
  }
  if (asJson(args)) return dump(await api.get(`/imports/${id}`));
  await printJob(api, id);
  return 0;
}

async function cmdRetry(api: ApiClient, args: RemoteArgs): Promise<number> {
  const id = args.positional[1];
  const step = flagString(args, "step");
  if (id === undefined || step === undefined) throw new Error("usage: mm retry <id> --step <step>");
  const outcome = await api.post<{ status: string }>(`/imports/${id}/retry`, { step });
  line(`retried ${step}: ${outcome.status}`);
  await printJob(api, id);
  return 0;
}

/**
 * `mm adopt <id> <track id> --file <path> | --server-path <path> | --from-url <address>`
 * against another installation.
 *
 * Remote mode is the case where the file and the library are genuinely on two machines, so
 * the default here is the opposite of the local command's: `--file` is read *from this
 * machine* and uploaded. `--server-path` is the escape hatch for the file that is already on
 * the far end, and it still has to pass that installation's `adoptSourceRoots`.
 *
 * `--from-url` is neither: the far end downloads it, so nothing crosses this wire but the
 * address. The flag is spelled exactly as the local command spells it, and for the same
 * reason — `--url` is how this CLI was pointed at that installation in the first place.
 */
async function cmdAdopt(api: ApiClient, args: RemoteArgs): Promise<number> {
  const id = args.positional[1];
  const trackId = args.positional[2];
  const file = flagString(args, "file");
  const serverPath = flagString(args, "server-path");
  const from = flagString(args, "from-url");
  const given = [file, serverPath, from].filter((value) => value !== undefined);
  if (id === undefined || trackId === undefined || given.length !== 1) {
    throw new Error(
      "usage: mm adopt <id> <track id> --file <path here>\n" +
        "       mm adopt <id> <track id> --server-path <path there>\n" +
        "       mm adopt <id> <track id> --from-url <address the server downloads from>\n" +
        "\n" +
        "`--from-url`, never `--url`: you are already using `--url` to name the installation " +
        "this command is talking to, and it is read before the command name.",
    );
  }

  const body =
    from !== undefined
      ? { source: "url" as const, url: from }
      : serverPath !== undefined
        ? { source: "path" as const, path: serverPath }
        : {
            source: "upload" as const,
            filename: (file ?? "").split(/[/\\]/).pop() ?? "adopted",
            // `node:fs`, not `Bun.file`: `bin/` is the one place in this app that really does
            // run under Bun, and it is still not worth a second way of reading a file.
            content: readFileSync(file ?? "").toString("base64"),
          };

  const result = await api.post<{
    path: string;
    bytes: number;
    codec: string | null;
    originalName: string;
    downloadedFrom: string | null;
    nextStep: string | null;
    queued: boolean;
  }>(`/imports/${id}/tracks/${trackId}/file`, body);

  if (asJson(args)) return dump(result);
  line(
    result.downloadedFrom === null
      ? `adopted ${result.originalName}`
      : `downloaded ${result.originalName} from ${result.downloadedFrom}`,
  );
  line(
    `  file     ${result.path} (${String(Math.round(result.bytes / 1024))} KiB, ${result.codec ?? "?"})`,
  );
  line(`  next     ${result.nextStep ?? "nothing left"}${result.queued ? " (queued)" : ""}`);
  return 0;
}

async function cmdControl(
  api: ApiClient,
  args: RemoteArgs,
  verb: "cancel" | "pause" | "bump",
): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) throw new Error(`usage: mm ${verb} <id>`);
  const payload = await api.post<{
    import: ImportRow;
    /** `bump` only: what happened to the message on the queue, not just to the row. */
    bump?: { action: string; queue: string | null; priority: number; messages: number };
  }>(`/imports/${id}/${verb}`);
  if (asJson(args)) return dump(payload);
  line(`${verb}: ${payload.import.id} is now ${payload.import.status}`);
  // Printed because "priority 10" on its own is exactly what the broken bump used to say.
  if (payload.bump !== undefined) {
    line(
      `  priority ${String(payload.bump.priority)} · queue ${payload.bump.action}` +
        `${payload.bump.queue === null ? "" : ` on ${payload.bump.queue}`}` +
        ` · ${String(payload.bump.messages)} message(s)`,
    );
  }
  return 0;
}

async function cmdInbox(api: ApiClient, args: RemoteArgs): Promise<number> {
  const sub = args.positional[1] ?? "list";

  if (sub === "list") {
    const payload = await api.get<{
      items: { id: string; type: string; status: string; title: string; importId: string | null }[];
    }>("/inbox", { status: flagBool(args, "all") ? "all" : "open" });
    if (asJson(args)) return dump(payload);
    if (payload.items.length === 0) {
      line("inbox empty");
      return 0;
    }
    line("ID                              TYPE                  STATUS     TITLE");
    for (const item of payload.items) {
      line(item.id.padEnd(31), item.type.padEnd(21), item.status.padEnd(10), item.title);
    }
    return 0;
  }

  if (sub === "resolve") {
    const accept = flagBool(args, "accept");
    const id = args.positional[2];
    const importFilter = flagString(args, "import");

    // `--all` answers every open item the same way. Fourteen identical fingerprint questions
    // are not fourteen decisions, they are typing.
    const targets =
      id !== undefined
        ? [id]
        : flagBool(args, "all")
          ? (
              await api.get<{ items: { id: string }[] }>("/inbox", {
                status: "open",
                ...(importFilter === undefined ? {} : { importId: importFilter }),
              })
            ).items.map((item) => item.id)
          : [];

    if (targets.length === 0) {
      throw new Error(
        "usage: mm inbox resolve <id> --accept | mm inbox resolve --all --accept [--import <id>]",
      );
    }

    const resumed = new Set<string>();
    for (const target of targets) {
      const outcome = await api.post<{
        item: { id: string; type: string; title: string; status: string };
        resumed: string | null;
      }>(`/inbox/${target}/resolve`, { accept });
      line(`${accept ? "accepted" : "dismissed"} ${outcome.item.type} — ${outcome.item.title}`);
      if (outcome.resumed !== null) resumed.add(outcome.resumed);
    }
    for (const importId of resumed) line(`resumed ${importId}`);

    const first = [...resumed][0];
    if (flagBool(args, "follow") && resumed.size === 1 && first !== undefined) {
      const code = await followImport(api, first);
      await printJob(api, first);
      return code;
    }
    return 0;
  }

  throw new Error("usage: mm inbox list | mm inbox resolve <id> --accept");
}

async function cmdLibrary(api: ApiClient, args: RemoteArgs): Promise<number> {
  const sub = args.positional[1] ?? "albums";

  if (sub === "albums" || sub === "quality") {
    const payload = await api.get<{
      albums: {
        id: string;
        title: string;
        albumArtist: string;
        trackCount: number;
        presentCount: number;
        score: number | null;
      }[];
      total: number;
      stats: Record<string, unknown>;
    }>("/library/albums", {
      limit: Number(flagString(args, "limit") ?? "100"),
      ...(flagString(args, "filter") === undefined ? {} : { filter: flagString(args, "filter") }),
      ...(flagString(args, "profile") === undefined
        ? {}
        : { profile: flagString(args, "profile") }),
    });
    if (asJson(args)) return dump(payload);
    const average = payload.stats["averageScore"];
    line(
      `${String(payload.total)} album(s) · metadata ${
        typeof average === "number" ? `${(average * 100).toFixed(0)}%` : "—"
      } on average`,
    );
    line("");
    line("SCORE  TRACKS  ALBUM");
    for (const album of payload.albums) {
      line(
        `${(album.score === null ? "  —" : `${(album.score * 100).toFixed(0).padStart(3)}%`).padEnd(6)} ` +
          `${`${String(album.presentCount)}/${String(album.trackCount)}`.padStart(6)}  ` +
          `${album.albumArtist} — ${album.title}  ${album.id}`,
      );
    }
    return 0;
  }

  if (sub === "tracks") {
    const payload = await api.get<{
      tracks: { path: string; score: number | null; behind: boolean }[];
      total: number;
    }>("/library/tracks", {
      limit: Number(flagString(args, "limit") ?? "50"),
      ...(flagString(args, "search") === undefined ? {} : { search: flagString(args, "search") }),
      ...(flagString(args, "filter") === undefined ? {} : { filter: flagString(args, "filter") }),
    });
    if (asJson(args)) return dump(payload);
    line(`${String(payload.total)} track(s) match`);
    for (const track of payload.tracks) {
      line(
        `${track.behind ? "!" : " "} ${
          track.score === null ? "  —" : `${(track.score * 100).toFixed(0).padStart(3)}%`
        }  ${track.path}`,
      );
    }
    return 0;
  }

  if (sub === "artists") {
    const payload = await api.get<{
      artists: { name: string; albums: number; tracks: number; mbid: string | null }[];
    }>("/library/artists");
    if (asJson(args)) return dump(payload);
    for (const artist of payload.artists) {
      line(
        `${artist.name.padEnd(36)} ${String(artist.albums).padStart(3)} album(s)  ` +
          `${String(artist.tracks).padStart(4)} track(s)  ${artist.mbid ?? ""}`,
      );
    }
    return 0;
  }

  if (sub === "show") {
    const id = args.positional[2];
    if (id === undefined) throw new Error("usage: mm library show <album id>");
    return dump(await api.get(`/library/albums/${id}`));
  }

  if (sub === "search") {
    const query = args.positional[2];
    if (query === undefined) throw new Error("usage: mm library search <text>");
    return dump(await api.get("/library/search", { q: query }));
  }

  if (sub === "retag") {
    const payload = await api.post("/library/retag", {
      ...(flagString(args, "album") === undefined ? {} : { albumId: flagString(args, "album") }),
      ...(flagString(args, "track") === undefined ? {} : { trackId: flagString(args, "track") }),
      dryRun: flagBool(args, "dry-run"),
      onlyBehind: !flagBool(args, "all"),
      queue: !flagBool(args, "now"),
    });
    return dump(payload);
  }

  if (sub === "verify") {
    const payload = await api.post("/library/verify", {
      ...(flagString(args, "album") === undefined ? {} : { albumId: flagString(args, "album") }),
      rescan: flagBool(args, "rescan"),
    });
    return dump(payload);
  }

  throw new Error("usage: mm library albums|tracks|artists|show <id>|search <q>|retag|verify");
}

async function cmdSettings(api: ApiClient, args: RemoteArgs): Promise<number> {
  const sub = args.positional[1] ?? "list";

  if (sub === "get" || sub === "list") {
    const settings = await api.get<Record<string, unknown>>("/settings");
    const key = args.positional[2];
    if (key !== undefined) {
      if (!(key in settings)) throw new Error(`Unknown setting "${key}".`);
      if (asJson(args)) return dump({ [key]: settings[key] });
      line(String(settings[key]));
      return 0;
    }
    if (asJson(args)) return dump(settings);
    for (const [name, value] of Object.entries(settings)) {
      line(`${name.padEnd(34)} ${JSON.stringify(value)}`);
    }
    return 0;
  }

  if (sub === "set") {
    const key = args.positional[2];
    const raw = args.positional[3];
    if (key === undefined || raw === undefined)
      throw new Error("usage: mm settings set <key> <value>");
    // The server parses with the key's own schema, so the CLI only has to decide whether the
    // text was meant as JSON. `true`, `12` and `["a"]` are; `some/path` is not.
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    const payload = await api.patch<{ saved: string[] }>("/settings", { [key]: value });
    line(`saved ${payload.saved.join(", ")}`);
    return 0;
  }

  if (sub === "schema") return dump(await api.get("/settings/schema"));

  throw new Error("usage: mm settings get [key] | set <key> <value> | list | schema");
}

async function cmdTools(api: ApiClient, args: RemoteArgs): Promise<number> {
  const sub = args.positional[1] ?? "status";

  if (sub === "status" || sub === "health") {
    const health = await api.get<{
      ok: boolean;
      version: string;
      fixtures: boolean;
      toolbox: Record<string, unknown>;
    }>("/tools/health");
    if (asJson(args)) return dump(health);
    line(`server    ${health.ok ? "ok" : "DEGRADED"}  v${health.version}`);
    line(`fixtures  ${health.fixtures ? "on" : "off"}`);
    line(`toolbox   ${JSON.stringify(health.toolbox["versions"] ?? health.toolbox)}`);
    return 0;
  }

  if (sub === "update") return dump(await api.post("/tools/ytdlp/update"));
  if (sub === "selftest") return dump(await api.post("/tools/ytdlp/selftest"));
  if (sub === "scan") return dump(await api.post("/tools/scan"));
  if (sub === "errors") return dump(await api.get("/tools/errors"));
  if (sub === "cookies") return dump(await api.get("/tools/cookies"));
  if (sub === "url") {
    const url = args.positional[2];
    if (url === undefined) throw new Error("usage: mm tools url <url>");
    return dump(await api.get("/tools/url", { url }));
  }

  throw new Error("usage: mm tools status|update|selftest|scan|errors|cookies|url <url>");
}

async function cmdWhoami(api: ApiClient, args: RemoteArgs): Promise<number> {
  const me = await api.get<{ kind: string; label: string; scopes: string[] }>("/me");
  if (asJson(args)) return dump(me);
  line(`${me.kind}  ${me.label}`);
  line(`scopes  ${me.scopes.join(", ")}`);
  line(`server  ${api.base}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

export const REMOTE_USAGE = `mm — Music Manager (remote)

  --url <base> --token <mm_…>        or MM_URL / MM_TOKEN, or ~/.config/mm/config.toml
  --json                             print the server's payload verbatim

  mm whoami                          which key this is, and what it may do
  mm import <url> [--release <mbid>] [--yes] [--force] [--follow] [--next]
  mm import --from-file <path>       one URL per line, '#' comments; 100 per HTTP call
  mm confirm-best <id> [--min-coverage 0.8] [--min-margin 0.04] [--prefer album|any]
  mm jobs [--status <s>] [--limit n] [--offset n]
  mm job <id> [--follow]
  mm retry <id> --step <step>
  mm adopt <id> <track id> --file <path here>          upload a file as that track's source
  mm adopt <id> <track id> --server-path <path there>  …or one already on the server
  mm adopt <id> <track id> --from-url <address>        …or let the server download it from
                                                       another upload of the same song
  mm cancel|pause|bump <id>
  mm inbox list [--all] | mm inbox resolve <id> --accept [--follow]
  mm inbox resolve --all --accept [--import <id>]
  mm library albums|tracks|artists [--filter f] [--search s] [--limit n]
  mm library show <album id> | search <text>
  mm library retag [--album <id>] [--dry-run] [--now] | verify [--album <id>]
  mm settings list|get [key]|set <key> <value>|schema
  mm tools status|update|selftest|scan|errors|cookies|url <url>
`;

/** Run one remote command. Throws `RemoteError`; `mm.ts` prints it. */
export async function runRemote(api: ApiClient, args: RemoteArgs): Promise<number> {
  switch (args.positional[0]) {
    case "whoami":
      return await cmdWhoami(api, args);
    case "import":
      return await cmdImport(api, args);
    case "confirm-best":
      return await cmdConfirmBest(api, args);
    case "jobs":
      return await cmdJobs(api, args);
    case "job":
      return await cmdJob(api, args);
    case "retry":
      return await cmdRetry(api, args);
    case "adopt":
      return await cmdAdopt(api, args);
    case "inbox":
      return await cmdInbox(api, args);
    case "library":
      return await cmdLibrary(api, args);
    case "settings":
      return await cmdSettings(api, args);
    case "tools":
      return await cmdTools(api, args);
    case "cancel":
    case "pause":
    case "bump":
      return await cmdControl(api, args, args.positional[0]);
    case undefined:
    case "help":
    case "--help":
      console.log(REMOTE_USAGE);
      return 0;
    default:
      /*
       * `match`, `doc`, `sources`, `scan identify`, `retag show` are in-process only.
       *
       * Not an oversight: they read the raw source cache and the metadata documents, which are
       * a debugging surface rather than an API, and exposing them over HTTP would mean
       * publishing shapes we would then have to keep. Saying so is better than a bare
       * "unknown command" that suggests a typo.
       */
      console.error(
        `"${args.positional[0]}" is not available in remote mode.\n` +
          `Run it on the server itself, or see the list below.\n`,
      );
      console.log(REMOTE_USAGE);
      return 2;
  }
}
