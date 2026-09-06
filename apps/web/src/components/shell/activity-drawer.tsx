/**
 * The activity drawer: the tail of the whole journal, on any page.
 *
 * The same rows as a job's log, without the job filter — which is exactly what you want when
 * something changed and you do not yet know which import it belonged to. Every line links to
 * its job, so "what was that?" is one click from "here it is".
 */
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { cn } from "cn";
import { timeAgo } from "#/lib/format.ts";
import { useShell } from "#/components/shell/shell-context.tsx";

const DOT: Record<string, string> = {
  info: "bg-info",
  warn: "bg-warn",
  error: "bg-danger",
};

export function ActivityDrawer() {
  const { drawerOpen, setDrawerOpen, data } = useShell();
  const events = data?.activity ?? [];
  const now = new Date();

  return (
    <aside
      data-testid="activity-drawer"
      aria-hidden={!drawerOpen}
      className={cn(
        "fixed inset-y-0 right-0 z-40 flex w-drawer flex-col border-l border-line bg-surface-1 transition-transform duration-200",
        drawerOpen ? "translate-x-0" : "translate-x-full",
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-3.5 py-3">
        <h2 className="text-sm font-semibold">Activity</h2>
        <button
          type="button"
          aria-label="Close activity"
          onClick={() => {
            setDrawerOpen(false);
          }}
          className="grid size-7 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="overflow-auto py-1.5">
        {events.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-fg-2">Nothing has happened yet.</p>
        ) : (
          events.map((event) => {
            const body = (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    DOT[event.level] ?? "bg-fg-3",
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-xs">{event.message}</span>
                  <span className="mt-0.5 block text-2xs text-fg-3">
                    {event.step ?? event.type} · {timeAgo(event.at, now)}
                  </span>
                </span>
              </>
            );
            return event.importId === null ? (
              <div key={event.id} className="flex gap-2.5 border-b border-line px-3.5 py-2.5">
                {body}
              </div>
            ) : (
              <Link
                key={event.id}
                to="/imports/$id"
                params={{ id: event.importId }}
                onClick={() => {
                  setDrawerOpen(false);
                }}
                className="flex gap-2.5 border-b border-line px-3.5 py-2.5 hover:bg-surface-2"
              >
                {body}
              </Link>
            );
          })
        )}
      </div>
    </aside>
  );
}
