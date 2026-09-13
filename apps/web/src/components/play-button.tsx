/**
 * The small round "play this" control, used by every list that has something playable in it.
 *
 * It is deliberately dumb: it knows nothing about queues, previews or `<audio>`. The caller
 * decides what pressing it means and passes `active`/`playing` so the icon can mirror the
 * bar — a row that is the one currently sounding shows a pause glyph, which is the only way a
 * fourteen-row track list stays readable while something is playing.
 *
 * `disabled` carries a `title`, always. A button that is off and says nothing is the most
 * annoying thing a page can contain, and "Deezer has no preview for this one" is the whole
 * explanation.
 */
import { Loader2, Pause, Play } from "lucide-react";
import { cn } from "cn";

export function PlayButton({
  onPlay,
  active = false,
  playing = false,
  busy = false,
  disabled = false,
  title,
  label = "Play",
  className,
  "data-testid": testId,
}: {
  readonly onPlay: () => void;
  /** True when this row is the player's current track. */
  readonly active?: boolean;
  readonly playing?: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly label?: string;
  readonly className?: string;
  readonly "data-testid"?: string;
}) {
  const showPause = active && playing;
  return (
    <button
      type="button"
      aria-label={showPause ? "Pause" : label}
      aria-pressed={active}
      title={title ?? (showPause ? "Pause" : label)}
      disabled={disabled || busy}
      data-active={active ? "true" : "false"}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      onClick={(event) => {
        // These sit inside clickable table rows; a play is not a navigation.
        event.stopPropagation();
        onPlay();
      }}
      className={cn(
        "inline-grid size-7 shrink-0 place-items-center rounded-md border transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-primary bg-primary-soft text-primary"
          : "border-line-strong bg-surface-2 text-fg-2 hover:bg-surface-3 hover:text-fg-1",
        className,
      )}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : showPause ? (
        <Pause className="size-3.5" aria-hidden="true" />
      ) : (
        <Play className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}
