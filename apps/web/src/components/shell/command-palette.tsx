/**
 * ⌘K — one box, several answers.
 *
 * The Console's front door used to be a text field in the top bar that took a YouTube URL and
 * nothing else. Everything else somebody has in the clipboard — a musicbrainz.org link, a
 * release id, an album name, an artist — hit a box that answered "no results" or, worse, went
 * to the wizard and failed there. This is the door now, and it decides what the string is
 * before it decides what to offer.
 *
 * Four kinds of query, four costs, and the cost is why they are not one lookup:
 *
 *  | typed                 | offered                                  | when it fires          |
 *  | --------------------- | ---------------------------------------- | ---------------------- |
 *  | a YouTube/fixture URL | "Import this"                            | instantly, no network  |
 *  | an MBID or MB link    | what its entity affords                  | 400 ms after the last keystroke, one lookup |
 *  | anything              | your library: albums, artists, tracks    | 150 ms, local SQL      |
 *  | anything              | MusicBrainz in words                     | **only when pressed**  |
 *
 * MusicBrainz is gated at one request per second, installation-wide and shared with the worker
 * (`server/integrations/rate-gate.ts`). A search per keystroke would not merely be slow, it
 * would queue behind and in front of the import running in the background. So the free-text
 * MusicBrainz search is an offer you select, and the row says so.
 *
 * The identifier lookup is the one exception, and it is the bet `mb-resolve.ts` was written to
 * make: looking an id up *before* refusing is what turns "no recording with id X" — about a
 * perfectly good release — into "that is a release; start an import pinned to it". One request,
 * once the typing has stopped, cancelled the moment another key is pressed.
 *
 * `shouldFilter={false}`: cmdk's own fuzzy filter is for a static list, and most of this list
 * comes from the server already filtered. The order on screen is the order built here, and
 * every row carries what pressing it will do.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Disc3,
  Download,
  Globe,
  Home,
  Inbox,
  Library,
  LoaderCircle,
  LogOut,
  Music,
  Plus,
  RotateCcw,
  Rss,
  Scan,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
  MonitorPlay,
} from "lucide-react";
import { parseMbRef } from "@mm/domain";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "#/components/ui/command.tsx";
import { Kbd } from "#/components/kbd.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";
import { signOut } from "#/lib/auth-client.ts";
import { retryLastFailed } from "#/server/functions/jobs.ts";
import {
  paletteFollow,
  paletteIdentify,
  paletteLibrary,
  paletteMusicBrainz,
} from "#/server/functions/palette.ts";
import { runYtdlpUpdate, startScan } from "#/server/functions/tools.ts";
import { verifyAll } from "#/server/functions/verify.ts";
import { scanWatchedSourceNow } from "#/server/functions/watched-sources.ts";
import { useTestId } from "#/components/pending-tree.tsx";
import type { LibraryHits, MbHits, PaletteRef } from "#/server/services/palette.ts";

/** What `imports.service` will accept as a source. Anything else is not an import. */
const URL_SHAPE = /^(?:https?:\/\/|fixture:\/\/)/i;

/** Local SQL. Short enough that the list keeps up with the keyboard. */
const LIBRARY_DEBOUNCE_MS = 150;
/**
 * One MusicBrainz lookup. Longer, because it leaves the machine.
 *
 * An id is pasted rather than typed, so in practice this fires once — the debounce is here for
 * the person who edits a URL by hand rather than for the one who hits ⌘V.
 */
const REF_DEBOUNCE_MS = 400;

interface Destination {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof Home;
  readonly shortcut?: string;
}

const GO: readonly Destination[] = [
  { to: "/", label: "Dashboard", icon: Home },
  { to: "/import/new", label: "New import", icon: Plus, shortcut: "N" },
  { to: "/imports", label: "Jobs", icon: Activity },
  { to: "/sources", label: "Watched sources", icon: Rss },
  { to: "/review", label: "Review queue", icon: Inbox, shortcut: "R" },
  { to: "/library", label: "Albums", icon: Disc3 },
  { to: "/library/tracks", label: "Tracks", icon: Music },
  { to: "/library/artists", label: "Artists", icon: Users },
  { to: "/library/quality", label: "Library quality", icon: Shield },
  { to: "/discover", label: "Discover", icon: Sparkles },
  { to: "/tools", label: "Tools & diagnostics", icon: Wrench },
  { to: "/settings", label: "Settings", icon: Settings },
];

/**
 * The **action** half of the palette (`prototypes/A-console`, the ⌘K overlay).
 *
 * The palette shipped as navigation only, which is half of what a command palette is for: the
 * prototype's entries are things you *do* — update yt-dlp, scan the library, verify it against
 * Navidrome, retry the import that just failed — and each of them otherwise costs a page load
 * and a hunt for a button (DRIVE-1 §4, "Palette ⌘K").
 *
 * Each one reports what happened in a toast, because a command palette that closes silently
 * has not told you whether it worked. They are deliberately the *idempotent* ones: nothing
 * here deletes, downloads or overwrites, so a mistyped ⌘K costs nothing.
 */
interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly icon: typeof Home;
  readonly run: () => Promise<string>;
}

/**
 * What the query is, decided without asking anyone.
 *
 * The order matters: a musicbrainz.org address is *also* an `https://` URL, so the reference
 * test comes first. `parseMbRef` is the same parser the wizard's paste field uses, so the two
 * boxes cannot disagree about what counts as an id.
 */
type Intent = "empty" | "import" | "reference" | "text";

function intentOf(query: string): Intent {
  const trimmed = query.trim();
  if (trimmed === "") return "empty";
  if (parseMbRef(trimmed) !== null) return "reference";
  if (URL_SHAPE.test(trimmed)) return "import";
  return "text";
}

/**
 * An answer, and the question it answers.
 *
 * Three asynchronous reads feed this list and all three are keyed this way, because a result
 * is only ever shown against the exact string it was fetched for.
 */
interface Answer<T> {
  readonly for: string;
  /** `null` when the request failed, which is a sentence rather than a permanent spinner. */
  readonly value: T | null;
}

/** One row: what it says, what it will do, and the sentence under the highlight. */
interface Row {
  readonly key: string;
  readonly icon: typeof Home;
  readonly label: ReactNode;
  /** The dimmer second half of the line. */
  readonly detail?: string | null;
  /** What Enter does, shown in the footer while this row is highlighted. */
  readonly enterHint: string;
  readonly shortcut?: string;
  readonly testId?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

interface Group {
  readonly heading: string;
  readonly rows: readonly Row[];
}

export function CommandPalette() {
  const navigate = useNavigate();
  const testId = useTestId();
  const { paletteOpen, setPaletteOpen, paletteSeed, toast } = useShell();
  /**
   * What has been typed **since this palette was opened**, or `null` for "nothing yet".
   *
   * The box's value is that, or the seed the palette was opened with — `⌘V` puts the clipboard
   * in the shell's state before the palette exists on screen, and reading it as a *fallback*
   * rather than copying it in with an effect is what keeps the open instantaneous. An effect
   * would render the empty box first and the pasted one a frame later, and React's own lint
   * rule says so: a `setState` in an effect body is a cascading render.
   *
   * `??`, not `||`: clearing a pre-filled box types the empty string, which must win over the
   * seed, or the text would spring back.
   */
  const [typed, setTyped] = useState<string | null>(null);
  const query = typed ?? paletteSeed ?? "";
  const [active, setActive] = useState("");
  const [busy, setBusy] = useState(false);

  /*
   * Every answer carries the question it answers, and "is it current?" is decided at render.
   *
   * The alternative — clearing the results when the query changes — is a `setState` in an
   * effect, which is a cascading render and which the lint rule rightly refuses. It is also
   * wrong in a way that shows: between the keystroke and the effect there is one frame in
   * which the *previous* query's rows are on screen under a box that reads something else, and
   * the row under the highlight is not the row Enter would take. Keying the answer makes a
   * stale result unrenderable rather than briefly renderable.
   *
   * `value: null` means the request failed. It is kept, rather than dropped, so that a failure
   * is a sentence and not an eternal spinner.
   */
  const [library, setLibrary] = useState<Answer<LibraryHits> | null>(null);
  const [reference, setReference] = useState<Answer<PaletteRef | null> | null>(null);
  const [mb, setMb] = useState<Answer<MbHits> | null>(null);
  /** The query MusicBrainz is being asked about right now — there is no automatic ask. */
  const [mbAsking, setMbAsking] = useState<string | null>(null);
  /** Why the last MusicBrainz search failed, shown in the group it failed for. */
  const [mbFailure, setMbFailure] = useState<string | null>(null);

  const trimmed = query.trim();
  const intent = intentOf(query);

  const wantsLibrary = trimmed !== "" && intent !== "import";
  const libraryAnswer = library?.for === trimmed ? library : null;
  const librarySearching = wantsLibrary && libraryAnswer === null;
  const referenceAnswer = reference?.for === trimmed ? reference : null;
  const referenceSearching = intent === "reference" && referenceAnswer === null;
  const mbAnswer = mb?.for === trimmed ? mb : null;
  const mbSearching = mbAsking === trimmed && trimmed !== "";

  const close = useCallback((): void => {
    setPaletteOpen(false);
    setTyped(null);
  }, [setPaletteOpen]);

  /* ---- the library, on every settled keystroke ------------------------------ */

  useEffect(() => {
    if (!paletteOpen || !wantsLibrary) return;
    const controller = new AbortController();
    const asked = trimmed;
    const timer = setTimeout(() => {
      paletteLibrary({ data: { query: asked }, signal: controller.signal }).then(
        (hits) => {
          if (!controller.signal.aborted) setLibrary({ for: asked, value: hits });
        },
        () => {
          if (!controller.signal.aborted) setLibrary({ for: asked, value: null });
        },
      );
    }, LIBRARY_DEBOUNCE_MS);
    /*
     * Both halves of "cancel": the timer, so a keystroke inside the debounce never starts a
     * request, and the controller, so one that did start is aborted rather than merely
     * ignored. Without the second, a slow answer to `dis` could land after `discovery` and
     * repaint the list with the wrong rows under the highlight.
     */
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [paletteOpen, trimmed, wantsLibrary]);

  /* ---- what is this id? ---------------------------------------------------- */

  useEffect(() => {
    if (!paletteOpen || intent !== "reference") return;
    const controller = new AbortController();
    const asked = trimmed;
    const timer = setTimeout(() => {
      paletteIdentify({ data: { input: asked }, signal: controller.signal }).then(
        (found) => {
          if (!controller.signal.aborted) setReference({ for: asked, value: found });
        },
        () => {
          if (!controller.signal.aborted) setReference({ for: asked, value: null });
        },
      );
    }, REF_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [paletteOpen, trimmed, intent]);

  /* ---- MusicBrainz in words: never automatic ------------------------------- */

  const askMusicBrainz = useCallback((): void => {
    const asked = trimmed;
    if (asked === "") return;
    setMbAsking(asked);
    paletteMusicBrainz({ data: { query: asked } }).then(
      (hits) => {
        setMbAsking(null);
        setMb({ for: asked, value: hits });
      },
      (error: unknown) => {
        setMbAsking(null);
        // Both: a toast, because the message names the source and the query it refused
        // (`OFFLINE_CACHE_MISS` prints the whole Lucene key), and a row, because a toast is
        // gone in three seconds and the list has to stop claiming the search is still to come.
        setMb({ for: asked, value: null });
        setMbFailure(error instanceof Error ? error.message : "MusicBrainz could not be reached.");
        toast(
          error instanceof Error ? error.message : "MusicBrainz could not be reached.",
          "danger",
        );
      },
    );
  }, [trimmed, toast]);

  /* ---- doing things -------------------------------------------------------- */

  const ACTIONS: readonly PaletteAction[] = useMemo(
    () => [
      {
        id: "scan",
        label: "Scan library",
        icon: Scan,
        run: async () => {
          await startScan({ data: {} });
          return "Scan queued. Tools reports it when the worker lands.";
        },
      },
      {
        id: "watched-scan",
        label: "Scan watched sources",
        icon: Rss,
        run: async () => {
          await scanWatchedSourceNow({ data: {} });
          return "Queued. Each enabled source is listed and its new videos become imports.";
        },
      },
      {
        id: "ytdlp",
        label: "Update yt-dlp now",
        icon: Download,
        run: async () => {
          const result = await runYtdlpUpdate();
          return result.updated
            ? `yt-dlp updated to ${result.to ?? "the latest build"}.`
            : `yt-dlp is at ${result.from ?? "its current build"}; nothing to update.`;
        },
      },
      {
        id: "verify",
        label: "Verify library in Navidrome",
        icon: ShieldCheck,
        run: async () => {
          // Queued, not awaited: the read-back is minutes of Subsonic calls and lives in the
          // worker now. The counts arrive as the `verify.done` line in the journal.
          const queued = await verifyAll({ data: {} });
          return queued.queued
            ? `Reading ${String(queued.total)} album(s) back from Navidrome. Tools has the log.`
            : "The read-back could not be queued.";
        },
      },
      {
        id: "retry",
        label: "Retry last failed import",
        icon: RotateCcw,
        run: async () => {
          const retried = await retryLastFailed();
          if (retried === null) return "Nothing has failed. There is no import to retry.";
          void navigate({ to: "/imports/$id", params: { id: retried.importId } });
          return `Retrying from ${retried.step}.`;
        },
      },
    ],
    [navigate],
  );

  const act = useCallback(
    (action: PaletteAction): void => {
      close();
      setBusy(true);
      void action.run().then(
        (message) => {
          setBusy(false);
          toast(message, "ok");
        },
        (error: unknown) => {
          setBusy(false);
          toast(error instanceof Error ? error.message : "That did not work.", "danger");
        },
      );
    },
    [close, toast],
  );

  /**
   * Go somewhere, closing the palette first so the page is not drawn under an overlay.
   *
   * The cast is the price of building the rows as data. TanStack's `navigate` is typed on the
   * *literal* route path, which lets it check `params` and `search` against that route — and
   * these destinations are computed at runtime from what the server returned, so there is no
   * literal to check them against. The paths are the ones the sidebar and the loaders already
   * use, and `route-skeletons.spec.ts` plus this file's own browser spec walk them; a wrong one
   * is a 404 in a test rather than a silent no-op.
   */
  const go = useCallback(
    (
      to: string,
      options: { search?: Record<string, unknown>; params?: Record<string, string> },
    ) => {
      close();
      void navigate({ to, ...options } as Parameters<typeof navigate>[0]);
    },
    [close, navigate],
  );

  /**
   * Follow a MusicBrainz hit to a real page — the one step that cannot be decided in advance.
   *
   * A release group has to be resolved to one of its editions before an import can be pinned
   * to it, and a recording has to be looked for in the library before we know whether "the
   * tracks that match it" is one track's page or a filtered list. Both are a request, so both
   * happen here, on the press, and never while somebody is typing.
   */
  const follow = useCallback(
    (kind: "release-group" | "recording", mbid: string, title: string | null): void => {
      setBusy(true);
      paletteFollow({ data: { kind, mbid, title } }).then(
        (answer) => {
          setBusy(false);
          if (kind === "release-group") {
            if (answer.releaseMbid === null) {
              toast("MusicBrainz lists no release under that record, so there is nothing to pin.");
              return;
            }
            go("/import/new", { search: { pin: answer.releaseMbid, step: 1 } });
            return;
          }
          const tracks = answer.tracks;
          const only = tracks?.exact.length === 1 ? tracks.exact[0] : undefined;
          if (only !== undefined) {
            go("/library/tracks/$id", { params: { id: only.id } });
            return;
          }
          // The library's own track search matches `recording_mbid` as well as the title, so
          // the id is the better needle whenever the library has been tagged with it.
          const needle = (tracks?.exact.length ?? 0) > 0 ? mbid : (title ?? mbid);
          go("/library/tracks", { search: { q: needle } });
        },
        (error: unknown) => {
          setBusy(false);
          toast(error instanceof Error ? error.message : "That did not work.", "danger");
        },
      );
    },
    [go, toast],
  );

  /* ---- the list ------------------------------------------------------------ */

  const groups = useMemo<readonly Group[]>(() => {
    const built: Group[] = [];

    /* the URL you pasted */
    if (intent === "import") {
      built.push({
        heading: "Import",
        rows: [
          {
            key: "import-url",
            icon: MonitorPlay,
            label: "Import this",
            detail: trimmed,
            enterHint: "Resolve this URL on YouTube and open the import wizard",
            testId: "palette-import",
            run: () => {
              go("/import/new", { search: { url: trimmed, step: 1 } });
            },
          },
        ],
      });
    }

    /* the id you pasted */
    if (intent === "reference") {
      built.push({ heading: "MusicBrainz reference", rows: referenceRows() });
    }

    /* your library */
    if (intent !== "import" && trimmed !== "") {
      built.push(...libraryGroups());
    }

    /*
     * MusicBrainz in words, if you ask — and only for words.
     *
     * An id is already being looked up above, exactly, so offering to *search* for the id as a
     * phrase would be a second row for a worse version of the same question.
     */
    if (intent === "text") {
      built.push(musicBrainzGroup());
    }

    /* the pages */
    const destinations = GO.filter((entry) => matches(entry.label, trimmed));
    if (destinations.length > 0) {
      built.push({
        heading: "Go to",
        rows: destinations.map((destination) => ({
          key: `go-${destination.to}`,
          icon: destination.icon,
          label: destination.label,
          enterHint: `Open ${destination.label}`,
          ...(destination.shortcut === undefined ? {} : { shortcut: destination.shortcut }),
          run: () => {
            go(destination.to, {});
          },
        })),
      });
    }

    /* the things you can do */
    const doable = ACTIONS.filter((action) => matches(action.label, trimmed));
    if (doable.length > 0) {
      built.push({
        heading: "Do",
        rows: doable.map((action) => ({
          key: `do-${action.id}`,
          icon: action.icon,
          label: action.label,
          enterHint: `${action.label} — the result arrives as a toast`,
          testId: `palette-action-${action.id}`,
          disabled: busy,
          run: () => {
            act(action);
          },
        })),
      });
    }

    if (matches("Sign out", trimmed)) {
      built.push({
        heading: "Session",
        rows: [
          {
            key: "sign-out",
            icon: LogOut,
            label: "Sign out",
            enterHint: "End this session and return to the login page",
            run: () => {
              close();
              void signOut().then(() => {
                toast("Signed out.");
                void navigate({ to: "/login", search: { redirect: "/" } });
              });
            },
          },
        ],
      });
    }

    return built;

    /* -- the three builders, kept here so they close over the state above -- */

    function referenceRows(): readonly Row[] {
      if (referenceSearching) {
        return [
          {
            key: "reference-pending",
            icon: LoaderCircle,
            label: "Asking MusicBrainz what this id is…",
            detail: parseMbRef(trimmed)?.mbid ?? trimmed,
            enterHint: "Waiting for MusicBrainz — one request, then this row becomes an offer",
            testId: "palette-reference-pending",
            disabled: true,
            run: () => undefined,
          },
        ];
      }
      const found = referenceAnswer?.value ?? null;
      if (found === null) {
        return [
          {
            key: "reference-unknown",
            icon: Globe,
            label: "MusicBrainz could not be asked about this id.",
            detail: parseMbRef(trimmed)?.mbid ?? trimmed,
            enterHint: "The lookup failed — your library was searched for it all the same",
            testId: "palette-reference-failed",
            disabled: true,
            run: () => undefined,
          },
        ];
      }
      const reference = found;
      const named = [reference.title, reference.artist, reference.disambiguation]
        .filter((part): part is string => part !== null && part !== "")
        .join(" · ");
      if (reference.action === "none") {
        return [
          {
            key: "reference-none",
            icon: Globe,
            label: reference.actionLabel,
            detail: reference.explanation,
            enterHint: reference.explanation,
            testId: "palette-reference-none",
            disabled: true,
            run: () => undefined,
          },
        ];
      }
      return [
        {
          key: "reference-act",
          icon:
            reference.action === "pin-release" || reference.action === "pin-group"
              ? MonitorPlay
              : Library,
          label: reference.actionLabel,
          detail: `${reference.noun ?? "entity"} · ${named}`,
          enterHint: reference.explanation,
          testId: "palette-reference",
          disabled: busy,
          run: () => {
            if (reference.action === "pin-release" && reference.targetMbid !== null) {
              go("/import/new", { search: { pin: reference.targetMbid, step: 1 } });
              return;
            }
            if (reference.action === "pin-group") {
              follow("release-group", reference.mbid, reference.title);
              return;
            }
            if (reference.action === "match-recording") {
              follow("recording", reference.mbid, reference.title);
              return;
            }
            go("/library/artists", { search: { q: reference.searchText ?? reference.mbid } });
          },
        },
      ];
    }

    function libraryGroups(): readonly Group[] {
      if (librarySearching) {
        return [
          {
            heading: "In your library",
            rows: [
              {
                key: "library-pending",
                icon: LoaderCircle,
                label: `Searching your library for “${trimmed}”…`,
                enterHint: "Reading your own albums, artists and tracks — no network",
                testId: "palette-library-pending",
                disabled: true,
                run: () => undefined,
              },
            ],
          },
        ];
      }
      const library = libraryAnswer?.value ?? null;
      if (library === null) {
        return [
          {
            heading: "In your library",
            rows: [
              {
                key: "library-failed",
                icon: Library,
                label: "Your library could not be searched.",
                detail: "The server refused the read; the other groups are unaffected.",
                enterHint: "Nothing to open — the library search failed",
                testId: "palette-library-failed",
                disabled: true,
                run: () => undefined,
              },
            ],
          },
        ];
      }
      const made: Group[] = [];
      if (library.albums.length > 0) {
        made.push({
          heading: "Albums in your library",
          rows: library.albums.map((hit) => ({
            key: `album-${hit.id}`,
            icon: Disc3,
            label: hit.title,
            detail: hit.subtitle,
            enterHint: `Open ${hit.title} in your library`,
            testId: "palette-album",
            run: () => {
              go("/library/albums/$id", { params: { id: hit.id } });
            },
          })),
        });
      }
      if (library.artists.length > 0) {
        made.push({
          heading: "Artists in your library",
          rows: library.artists.map((hit) => ({
            key: `artist-${hit.id}`,
            icon: Users,
            label: hit.title,
            detail: hit.subtitle,
            enterHint: `Open ${hit.title}'s page in your library`,
            testId: "palette-artist",
            run: () => {
              go("/library/artists/$id", { params: { id: hit.id } });
            },
          })),
        });
      }
      if (library.tracks.length > 0) {
        made.push({
          heading: "Tracks in your library",
          rows: library.tracks.map((hit) => ({
            key: `track-${hit.id}`,
            icon: Music,
            label: hit.title,
            detail: hit.subtitle,
            enterHint: `Open ${hit.title} in your library`,
            testId: "palette-track",
            run: () => {
              go("/library/tracks/$id", { params: { id: hit.id } });
            },
          })),
        });
      }
      if (made.length === 0) {
        made.push({
          heading: "In your library",
          rows: [
            {
              key: "library-empty",
              icon: Library,
              label: `Nothing in your library matches “${library.query}”.`,
              detail: "Albums, artists and tracks were all searched.",
              enterHint: "Nothing here — try MusicBrainz below",
              testId: "palette-library-empty",
              disabled: true,
              run: () => undefined,
            },
          ],
        });
      }
      return made;
    }

    function musicBrainzGroup(): Group {
      if (mbSearching) {
        return {
          heading: "MusicBrainz",
          rows: [
            {
              key: "mb-pending",
              icon: LoaderCircle,
              label: `Asking MusicBrainz for “${trimmed}”…`,
              detail: "Two searches, one request per second — the gate is shared with the worker.",
              enterHint: "Waiting for MusicBrainz",
              testId: "palette-mb-pending",
              disabled: true,
              run: () => undefined,
            },
          ],
        };
      }
      const mb = mbAnswer?.value ?? null;
      if (mb === null && mbAnswer !== null) {
        return {
          heading: `MusicBrainz · “${trimmed}”`,
          rows: [
            {
              key: "mb-failed",
              icon: Globe,
              label: "MusicBrainz could not be asked.",
              detail: mbFailure,
              enterHint: "Ask again",
              testId: "palette-mb-failed",
              run: askMusicBrainz,
            },
          ],
        };
      }
      if (mb === null) {
        return {
          heading: "MusicBrainz",
          rows: [
            {
              key: "mb-ask",
              icon: Globe,
              label: `Search MusicBrainz for “${trimmed}”`,
              detail: "Not searched yet: one request per second, so it waits to be asked.",
              enterHint: "Ask MusicBrainz — two searches, about two seconds",
              testId: "palette-mb-ask",
              run: askMusicBrainz,
            },
          ],
        };
      }
      const rows: Row[] = [
        ...mb.releaseGroups.map((hit) => ({
          key: `mb-group-${hit.mbid}`,
          icon: Disc3,
          label: hit.title,
          detail: [hit.artist, hit.year === null ? null : String(hit.year), hit.detail]
            .filter((part): part is string => part !== null && part !== "")
            .join(" · "),
          enterHint: `Start an import pinned to “${hit.title}” — you paste the YouTube link next`,
          testId: "palette-mb-group",
          disabled: busy,
          run: () => {
            follow("release-group", hit.mbid, hit.title);
          },
        })),
        ...mb.recordings.map((hit) => ({
          key: `mb-recording-${hit.mbid}`,
          icon: Music,
          label: hit.title,
          detail: [hit.artist, hit.detail]
            .filter((part): part is string => part !== null && part !== "")
            .join(" · "),
          enterHint: `Show the tracks in your library that match “${hit.title}”`,
          testId: "palette-mb-recording",
          disabled: busy,
          run: () => {
            follow("recording", hit.mbid, hit.title);
          },
        })),
      ];
      if (rows.length === 0) {
        rows.push({
          key: "mb-empty",
          icon: Globe,
          label: `MusicBrainz has no record or recording called “${mb.query}”.`,
          detail: mb.queries.join("  ·  "),
          enterHint: "Nothing found — the queries that were sent are shown beside it",
          testId: "palette-mb-empty",
          disabled: true,
          run: () => undefined,
        });
      }
      return { heading: `MusicBrainz · “${mb.query}”`, rows };
    }
  }, [
    ACTIONS,
    act,
    askMusicBrainz,
    busy,
    close,
    follow,
    go,
    intent,
    libraryAnswer,
    librarySearching,
    mbAnswer,
    mbFailure,
    mbSearching,
    navigate,
    referenceAnswer,
    referenceSearching,
    toast,
    trimmed,
  ]);

  /*
   * The footer's sentence, and the reason every row carries one.
   *
   * A palette that offers "Discovery" three times — an album of yours, a MusicBrainz record, a
   * page — has to say which is which *before* Enter, not after. cmdk tracks the highlight in
   * `value`, so the sentence under the list is a lookup rather than a second source of truth.
   */
  const highlighted = useMemo(
    () => groups.flatMap((group) => group.rows).find((row) => row.key === active) ?? null,
    [groups, active],
  );

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={(open: boolean) => {
        if (!open) close();
        else setPaletteOpen(true);
      }}
      title="Command palette"
      description="Search your library, paste a YouTube URL or a MusicBrainz id, or jump to a page."
      className="w-palette max-w-palette"
    >
      {/*
        `CommandDialog` in this shadcn style puts a dialog around its children and nothing
        else — it does not itself provide cmdk's context. Without this wrapper every command
        primitive inside throws "Cannot read properties of undefined (reading 'subscribe')",
        the render is caught by the router's error boundary, and the palette simply never
        opens. It did not, until the browser check for this phase tried it.
      */}
      <Command
        shouldFilter={false}
        value={active}
        onValueChange={setActive}
        label="Search, import or go to"
      >
        <CommandInput
          data-testid={testId("palette-input")}
          value={query}
          onValueChange={setTyped}
          placeholder="Search, or paste a YouTube link or a MusicBrainz id…"
        />
        <CommandList data-testid={testId("palette-list")}>
          <CommandEmpty>
            Nothing matches. Paste a YouTube link to import it, or a MusicBrainz id to start from
            that.
          </CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.rows.map((row) => (
                <CommandItem
                  key={row.key}
                  value={row.key}
                  disabled={row.disabled ?? false}
                  {...(row.testId === undefined ? {} : { "data-testid": testId(row.testId) })}
                  onSelect={row.run}
                >
                  <row.icon
                    className={row.icon === LoaderCircle ? "size-4 animate-spin" : "size-4"}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{row.label}</span>
                  {row.detail === undefined || row.detail === null || row.detail === "" ? null : (
                    <span className="min-w-0 truncate text-2xs text-fg-3">{row.detail}</span>
                  )}
                  {row.shortcut === undefined ? null : (
                    <CommandShortcut>{row.shortcut}</CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <footer
          className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-2xs text-fg-3"
          data-testid={testId("palette-hint")}
        >
          <Kbd>
            ↵<span className="sr-only">Enter</span>
          </Kbd>
          {/*
            `aria-live`, because this sentence is the answer to a question the highlight has
            just changed. cmdk already points `aria-activedescendant` at the option, so a
            screen reader hears the row's *name*; what it cannot hear is the difference between
            "Discovery, the album you own" and "Discovery, the record on MusicBrainz you could
            import" — which is exactly what the sentence is for, and exactly what a sighted
            person reads here.
          */}
          <span className="min-w-0 flex-1 truncate" aria-live="polite">
            {highlighted?.enterHint ?? "Type to search, ↑↓ to choose, Esc to close."}
          </span>
        </footer>
      </Command>
    </CommandDialog>
  );
}

/** The local filter for the two static lists. Substring, case-insensitive, no fuzz. */
function matches(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return label.toLowerCase().includes(needle);
}
