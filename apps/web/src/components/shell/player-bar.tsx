/**
 * The mini-player: a strip along the bottom of every page, present only while something is
 * loaded.
 *
 * It is a *view*. All of the state, and the `<audio>` element itself, belong to
 * `player-context.tsx`; nothing here does more than read it and call a method, which is what
 * lets the bar be hidden and shown without ever interrupting playback.
 *
 * Three things it insists on saying, because a player that hides them is lying:
 *
 *  - **where the sound comes from** — `Library` for one of our files, `Deezer preview 30s` for
 *    a clip of a record we do not own. The Console's whole premise is that the library is the
 *    source of truth, so "you are hearing a thirty-second stand-in" is not a detail.
 *  - **the queue position**, when there is a queue, so "play album" is visibly an album.
 *  - **that a source failed**, in words, rather than by simply refusing to move.
 *
 * Keyboard: `Space` toggles while the focus is inside the bar. It is deliberately *not* global
 * — `app-shell.tsx` reserves the bare letters and a space that pauses the music from inside a
 * search box is the same hostility that rule exists to prevent.
 */
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, X } from "lucide-react";
import { cn } from "cn";
import { Cover } from "#/components/cover.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { usePlayer } from "#/components/shell/player-context.tsx";
import { mmss } from "#/lib/format.ts";
import { useTestId } from "#/components/pending-tree.tsx";

export function PlayerBar() {
  const player = usePlayer();
  const testId = useTestId();
  const current = player.current;
  if (current === null) return null;

  const length = player.duration > 0 ? player.duration : (current.durationSeconds ?? 0);
  const preview = current.source === "deezer";

  return (
    /*
     * A focusable labelled region rather than a bare `<div>`: `Space` has to mean something
     * *here* and nowhere else, and "here" is only definable if the strip can hold the focus.
     * `tabIndex={0}` is what makes that reachable — Tab into the bar and the shortcut is live,
     * tab away and it is not — and the `region` role with a name is what tells a screen reader
     * why an otherwise non-interactive container is in the tab order.
     */
    <section
      data-testid={testId("player-bar")}
      role="region"
      aria-label="Player"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Spacebar") return;
        // A space on a button or the slider is that control's own business.
        const target = event.target as HTMLElement;
        if (["BUTTON", "INPUT", "A"].includes(target.tagName)) return;
        event.preventDefault();
        player.toggle();
      }}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface-2/95 backdrop-blur"
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <Cover
          size="sm"
          src={current.coverUrl}
          seed={current.id}
          label={current.album ?? current.title}
        />

        <div className="min-w-0 w-56 shrink-0">
          <div className="truncate font-medium" data-testid={testId("player-title")}>
            {current.title}
          </div>
          <div className="truncate text-2xs text-fg-3" data-testid={testId("player-artist")}>
            {current.artist ?? "Unknown artist"}
            {current.album === null ? null : ` · ${current.album}`}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label="Previous track"
            disabled={player.queue.length < 2}
            onClick={player.previous}
          >
            <SkipBack className="size-4" aria-hidden="true" />
          </IconButton>
          <IconButton
            label={player.playing ? "Pause" : "Play"}
            testid="player-toggle"
            primary
            onClick={player.toggle}
          >
            {player.playing ? (
              <Pause className="size-4" aria-hidden="true" />
            ) : (
              <Play className="size-4" aria-hidden="true" />
            )}
          </IconButton>
          <IconButton
            label="Next track"
            disabled={player.index + 1 >= player.queue.length}
            onClick={player.next}
          >
            <SkipForward className="size-4" aria-hidden="true" />
          </IconButton>
        </div>

        <span className="w-10 shrink-0 text-right font-mono text-2xs text-fg-3">
          {mmss(player.position)}
        </span>
        <input
          type="range"
          data-testid={testId("player-seek")}
          aria-label="Seek"
          className="h-1 grow accent-primary"
          min={0}
          max={length > 0 ? length : 1}
          step={0.5}
          value={Math.min(player.position, length > 0 ? length : 1)}
          disabled={length === 0}
          onChange={(event) => {
            player.seek(Number.parseFloat(event.target.value));
          }}
        />
        <span className="w-10 shrink-0 font-mono text-2xs text-fg-3">{mmss(length)}</span>

        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton
            label={player.muted ? "Unmute" : "Mute"}
            onClick={player.toggleMuted}
            testid="player-mute"
          >
            {player.muted || player.volume === 0 ? (
              <VolumeX className="size-4" aria-hidden="true" />
            ) : (
              <Volume2 className="size-4" aria-hidden="true" />
            )}
          </IconButton>
          <input
            type="range"
            aria-label="Volume"
            data-testid={testId("player-volume")}
            className="h-1 w-20 accent-primary"
            min={0}
            max={1}
            step={0.01}
            value={player.muted ? 0 : player.volume}
            onChange={(event) => {
              player.setVolume(Number.parseFloat(event.target.value));
            }}
          />
        </div>

        <ToneBadge
          tone={preview ? "info" : "ok"}
          data-testid={testId("player-source")}
          title={
            preview
              ? "A thirty-second clip from Deezer. This record is not in your library."
              : "Streamed from your own library file."
          }
        >
          {preview ? "Deezer preview 30s" : "Library"}
        </ToneBadge>

        {player.queue.length < 2 ? null : (
          <span
            className="shrink-0 font-mono text-2xs text-fg-3"
            data-testid={testId("player-queue")}
          >
            {player.index + 1}/{player.queue.length}
          </span>
        )}

        <IconButton label="Close the player" onClick={player.close} testid="player-close">
          <X className="size-4" aria-hidden="true" />
        </IconButton>
      </div>

      {player.error === null ? null : (
        <p
          className="px-4 pb-2 text-2xs text-danger"
          data-testid={testId("player-error")}
          role="status"
        >
          {player.error}
        </p>
      )}
    </section>
  );
}

function IconButton({
  label,
  testid,
  primary = false,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly testid?: string;
  readonly primary?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  const scoped = useTestId();
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      {...(testid === undefined ? {} : { "data-testid": scoped(testid) })}
      className={cn(
        "inline-grid size-8 shrink-0 place-items-center rounded-md border transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        primary
          ? "border-primary bg-primary-soft text-primary hover:bg-primary hover:text-primary-foreground"
          : "border-line-strong bg-surface-3 text-fg-1 hover:bg-surface-1",
      )}
    >
      {children}
    </button>
  );
}
