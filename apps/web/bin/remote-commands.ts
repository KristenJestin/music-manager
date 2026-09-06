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
    line(` ${STATUS_MARK[step.status] ?? step.status} ${step.step.padEnd(12)} ${step.message ?? ""}`);
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

async function cmdImport(api: ApiClient, args: RemoteArgs): Promise<number> {
  const url = args.positional[1];
  if (url === undefined) throw new Error("usage: mm import <url|fixture://…>");

  const created = await api.post<{ import: ImportRow; duplicates: string[] }>("/imports", {
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

  line(`import ${created.import.id}`);
  line(`  url    ${created.import.url}`);
  line(`  kind   ${created.import.kind}`);
  line(`  title  ${created.import.title ?? "-"}`);
  if (created.duplicates.length > 0) {
    line(`  note   ${String(created.duplicates.length)} earlier import(s) of the same URL`);
  }
  line(`  queued on the server's worker`);

  if (!flagBool(args, "follow")) return 0;
  line("");
  const code = await followImport(api, created.import.id);
  if (asJson(args)) return dump(await api.get(`/imports/${created.import.id}`));
  await printJob(api, created.import.id);
  return code;
}

async function cmdJobs(api: ApiClient, args: RemoteArgs): Promise<number> {
  const payload = await api.get<{ imports: ImportRow[] }>("/imports", {
    limit: Number(flagString(args, "limit") ?? "50"),
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

async function cmdControl(
  api: ApiClient,
  args: RemoteArgs,
  verb: "cancel" | "pause" | "bump",
): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) throw new Error(`usage: mm ${verb} <id>`);
  const payload = await api.post<{ import: ImportRow }>(`/imports/${id}/${verb}`);
  if (asJson(args)) return dump(payload);
  line(`${verb}: ${payload.import.id} is now ${payload.import.status}`);
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
      ...(flagString(args, "profile") === undefined ? {} : { profile: flagString(args, "profile") }),
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
    if (key === undefined || raw === undefined) throw new Error("usage: mm settings set <key> <value>");
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
  mm jobs [--status <s>] [--limit n]
  mm job <id> [--follow]
  mm retry <id> --step <step>
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
    case "jobs":
      return await cmdJobs(api, args);
    case "job":
      return await cmdJob(api, args);
    case "retry":
      return await cmdRetry(api, args);
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
