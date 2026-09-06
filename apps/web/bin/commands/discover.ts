/**
 * `mm discover` — the recommendation set from the command line.
 *
 * Two verbs and nothing else: `sync` recomputes, `list` prints. They are the same two calls the
 * Console makes, which is what the acceptance criterion of `docs/phases/P09-discover.md` leans
 * on — `MM_FIXTURES=1 mm discover sync && mm discover list --json` has to answer without a
 * browser, without a Navidrome and without a network.
 *
 * `--json` prints the whole payload; the human form prints the three blocks as three short
 * tables, because a recommendation you cannot read at a glance is one you will not act on.
 */
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import {
  discoverList,
  forgetDismissals,
  syncDiscover,
  type DiscoverItemView,
} from "#/server/services/discover.ts";

export interface CliArgs {
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

const out = (...parts: unknown[]): void => {
  console.log(parts.join(" "));
};

const flagBoolean = (args: CliArgs, name: string): boolean =>
  args.flags[name] === true || args.flags[name] === "true";

const flagNumber = (args: CliArgs, name: string): number | undefined => {
  const raw = args.flags[name];
  if (typeof raw !== "string") return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
};

/** `Daft Punk — Homework` padded so three columns line up without a table library. */
function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

function printItems(title: string, items: readonly DiscoverItemView[], limit: number): void {
  out("");
  out(`${title} (${String(items.length)})`);
  if (items.length === 0) {
    out("  nothing");
    return;
  }
  for (const item of items.slice(0, limit)) {
    const score = `${String(Math.round(item.score * 100))}%`.padStart(4, " ");
    out(
      ` ${score}  ${pad(`${item.artist} — ${item.title}`, 46)}  ${item.inLibrary ? "in library" : "          "}  ${item.reason}`,
    );
  }
  if (items.length > limit) out(`  … and ${String(items.length - limit)} more (--limit)`);
}

export async function cmdDiscover(args: CliArgs): Promise<number> {
  const action = args.positional[1] ?? "list";
  const asJson = flagBoolean(args, "json");

  if (action === "sync") {
    const report = await syncDiscover({ db: db(), trigger: "cli" });
    if (asJson) {
      out(JSON.stringify(report, null, 2));
      return report.status === "failed" ? 1 : 0;
    }
    if (report.status === "skipped") {
      out(`Skipped: ${report.error ?? "Discover is off."}`);
      return 0;
    }
    if (report.status === "failed") {
      out(`Failed after ${String(report.durationMs)} ms: ${report.error ?? "unknown error"}`);
      return 1;
    }
    out(
      `Synced in ${String(report.durationMs)} ms: ${String(report.discography)} discography gap(s), ` +
        `${String(report.recommendations)} recommendation(s), ${String(report.similarArtists)} similar artist(s).`,
    );
    if (report.incompleteAlbums > 0) {
      out(
        `${String(report.incompleteAlbums)} album(s) on disk are incomplete — see \`mm inbox list\`.`,
      );
    }
    if (report.playlist !== null) {
      out(
        report.playlist.error === null
          ? `Navidrome playlist: ${String(report.playlist.pushed)} track(s) pushed, ${String(report.playlist.skipped)} not found there.`
          : `Navidrome playlist failed: ${report.playlist.error}`,
      );
    }
    // A sync that could not read Navidrome still succeeded — it says so rather than exiting 1.
    if (report.error !== null) out(`Note: ${report.error}`);
    return 0;
  }

  if (action === "forget") {
    const forgotten = await forgetDismissals(db());
    out(`${String(forgotten)} hidden suggestion(s) may come back on the next sync.`);
    return 0;
  }

  if (action === "list") {
    const payload = await discoverList({ db: db() });
    if (asJson) {
      out(JSON.stringify(payload, null, 2));
      return 0;
    }
    const limit = flagNumber(args, "limit") ?? 10;
    out(
      payload.lastSync === null
        ? "Never synced. Run `mm discover sync`."
        : `Last sync ${payload.lastSync.at} (${payload.lastSync.status}) · window ${String(payload.signals.windowDays)} days`,
    );
    if (payload.signals.topArtists.length > 0) {
      out(
        `Most played: ${payload.signals.topArtists
          .slice(0, 6)
          .map((artist) => `${artist.name} ${String(artist.plays)}×`)
          .join(", ")}`,
      );
    }
    if (payload.signals.topGenres.length > 0) {
      out(
        `Top genres: ${payload.signals.topGenres
          .slice(0, 6)
          .map((genre) => genre.name)
          .join(", ")}`,
      );
    }
    printItems("Complete your discography", payload.discography, limit);
    printItems("Recommended for you", payload.recommendations, limit);
    printItems("Similar artists", payload.similarArtists, limit);
    return 0;
  }

  throw new MMError(
    "INVALID_INPUT",
    "usage: mm discover sync | list [--json] [--limit n] | forget",
  );
}
