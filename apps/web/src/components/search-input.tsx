/**
 * The Console's one search box.
 *
 * Albums, Artists and Tracks each carried their own copy — a `<label>` painted
 * `bg-surface-1` around an `Input` with its border, background and focus ring stripped off.
 * The result read as a flat rectangle whose fill matched no other field on the page, which is
 * what the owner saw as "the background of the search box is odd" (review B4); the
 * duplication was already on the debt list (`orchestration/STATUS.md`, P07-verify-1).
 *
 * So this keeps the standard `Input` exactly as it is — its border, its `dark:bg-input/30`
 * fill, its focus ring — and only lays the magnifier and the clear button over it. Nothing
 * about the field's chrome is re-declared here, which is the whole point of factoring it out.
 *
 * (`components/ui/input-group.tsx` would have been the natural base, but every one of its
 * imports uses a `@/` alias this workspace does not define, so it cannot be loaded at all.)
 */
import { Search, X } from "lucide-react";
import { cn } from "cn";
import { Input } from "#/components/ui/input.tsx";

export interface SearchInputProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Enter, and the clear button. Called with the value the field now holds. */
  readonly onSubmit?: (value: string) => void;
  readonly placeholder?: string;
  readonly className?: string;
  readonly "data-testid"?: string;
  /** Accessible name. Defaults to the placeholder, then to "Search". */
  readonly label?: string;
}

export function SearchInput({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  className,
  label,
  "data-testid": testId,
}: SearchInputProps) {
  const clear = (): void => {
    onValueChange("");
    onSubmit?.("");
  };

  return (
    <div data-slot="search-input" className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3"
        aria-hidden="true"
      />
      <Input
        type="search"
        data-testid={testId}
        aria-label={label ?? placeholder ?? "Search"}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit?.(event.currentTarget.value);
          }
          if (event.key === "Escape" && value !== "") {
            event.preventDefault();
            clear();
          }
        }}
        // `[&::-webkit-search-cancel-button]:hidden` — Chrome's own cross ignores the palette
        // and only appears while the field has focus; the button below is the honest one.
        className={cn(
          "pl-7.5 text-xs [&::-webkit-search-cancel-button]:hidden",
          value === "" ? "" : "pr-7",
        )}
      />
      {value === "" ? null : (
        <button
          type="button"
          aria-label="Clear the search"
          onClick={clear}
          className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
