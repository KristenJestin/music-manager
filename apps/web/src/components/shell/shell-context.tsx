/**
 * The shell's shared state: live counters, toasts, and the two overlays.
 *
 * One context rather than three, because everything in it is "things the chrome around the
 * page needs" and because a page that wants to raise a toast should not have to know which of
 * four providers owns it.
 *
 * The counters refresh on an interval *and* whenever the SSE stream says something happened.
 * The interval alone would make the sidebar lag behind the log by up to ten seconds; the
 * stream alone would leave a tab that was open across a server restart stale forever.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast as toastManager } from "#/components/ui/toast.tsx";
import { fetchShell, type ShellPayload } from "#/server/functions/dashboard.ts";

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: "info" | "ok" | "warn" | "danger";
}

export interface ShellContextValue {
  readonly data: ShellPayload | null;
  readonly toasts: readonly Toast[];
  toast(message: string, tone?: Toast["tone"]): void;
  dismissToast(id: number): void;
  refresh(): void;
  readonly paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
  readonly drawerOpen: boolean;
  setDrawerOpen(open: boolean): void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/** How often the sidebar re-reads its counters when nothing is happening. */
const POLL_MS = 10_000;
const TOAST_MS = 3_200;

export function ShellProvider({
  initial,
  children,
}: {
  /**
   * `null` when the shell's own loader is what failed — the error boundary of `_app.tsx`
   * still has to draw the chrome, and a sidebar with no counters is navigable while a blank
   * document is not. The interval below fills them in as soon as the server answers again.
   */
  readonly initial: ShellPayload | null;
  readonly children: ReactNode;
}) {
  const [data, setData] = useState<ShellPayload | null>(initial);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const nextToastId = useRef(1);

  const refresh = useCallback(() => {
    void fetchShell().then(setData, () => {
      // A failed refresh is not worth a toast: the next tick will try again, and the page the
      // user is actually reading has its own error handling.
    });
  }, []);

  /*
   * The queue itself is Base UI's — `ui/toast`'s module-level manager, which works outside
   * React and is what `<Toaster />` renders. This context keeps the shape it always had
   * (`toast(message, tone)`, numeric ids, a readable `toasts` list) and delegates: the numeric
   * id is handed to the manager as its string id, so `dismissToast` is a `close`, and the list
   * is kept in step by the manager's own `onRemove` rather than by a second timer.
   */
  const toast = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = nextToastId.current;
    nextToastId.current += 1;
    toastManager.add({
      id: String(id),
      title: message,
      type: tone,
      timeout: TOAST_MS,
      onRemove: () => {
        setToasts((current) => current.filter((entry) => entry.id !== id));
      },
    });
    setToasts((current) => [...current, { id, message, tone }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    toastManager.close(String(id));
  }, []);

  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  // Anything the orchestrator writes to the journal is a reason to re-read the counters.
  useEffect(() => {
    const source = new EventSource("/api/events");
    let pending: ReturnType<typeof setTimeout> | null = null;
    const nudge = (): void => {
      if (pending !== null) return;
      pending = setTimeout(() => {
        pending = null;
        refresh();
      }, 400);
    };
    source.onmessage = nudge;
    source.addEventListener("import.done", nudge);
    source.addEventListener("import.failed", nudge);
    source.addEventListener("inbox.created", nudge);
    source.addEventListener("inbox.resolved", nudge);
    return () => {
      if (pending !== null) clearTimeout(pending);
      source.close();
    };
  }, [refresh]);

  const value = useMemo<ShellContextValue>(
    () => ({
      data,
      toasts,
      toast,
      dismissToast,
      refresh,
      paletteOpen,
      setPaletteOpen,
      drawerOpen,
      setDrawerOpen,
    }),
    [data, toasts, toast, dismissToast, refresh, paletteOpen, drawerOpen],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error("useShell must be used inside <ShellProvider>.");
  return value;
}

/** Raise a toast from anywhere under the shell. */
export function useToast(): (message: string, tone?: Toast["tone"]) => void {
  return useShell().toast;
}
