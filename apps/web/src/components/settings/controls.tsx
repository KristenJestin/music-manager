/**
 * The four form controls the Settings pages are built from.
 *
 * They are the prototype's own `row`, `tg` and `chip` rendered with the Console's tokens, and
 * they stay deliberately dumb — value in, `onChange` out, no state — so that a settings page is
 * one object of values and one Save button, and never a dozen little pieces of state that can
 * disagree with each other. `Toggle` is a thin wrapper over the shadcn/Base UI `Switch` rather
 * than a pill of its own (owner review C11); the wrapper is what keeps its thirty call sites
 * from having to know the primitive's prop names.
 */
import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "cn";
import { Label } from "#/components/ui/label.tsx";
import { Switch } from "#/components/ui/switch.tsx";

/** Label on the left, control on the right, help text under the label. */
export function FormRow({
  label,
  help,
  children,
  htmlFor,
}: {
  readonly label: string;
  readonly help?: string;
  readonly children: ReactNode;
  readonly htmlFor?: string;
}) {
  return (
    <div className="grid gap-1.5 border-b border-line py-3 last:border-b-0 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-4">
      <div>
        <label htmlFor={htmlFor} className="text-xs font-medium">
          {label}
        </label>
        {help === undefined ? null : <p className="mt-0.5 text-2xs text-fg-3">{help}</p>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Section({
  id,
  title,
  description,
  children,
}: {
  /**
   * Anchor, so that a page which says "this is not configured" can link straight at the
   * block that configures it (`/settings/integrations#navidrome`, owner review B5).
   * `scroll-mt` keeps the heading clear of the sticky topbar when the browser jumps.
   */
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-topbar rounded-xl border border-line bg-surface-1 px-3.5 py-1 target:border-primary"
    >
      <header className="border-b border-line py-2.5">
        <h2 className="text-xs font-medium tracking-wide">{title}</h2>
        {description === undefined ? null : (
          <p className="mt-0.5 text-2xs text-fg-3">{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * A boolean, as the shadcn/Base UI `Switch`.
 *
 * It was a hand-rolled `<button role="switch">` until the owner review (C11): the pill was
 * drawn here, the keyboard behaviour was whatever a button gives you, and it was the only
 * control on the Settings pages that did not come from `components/ui/`. The wrapper stays,
 * because thirty call sites pass `checked` / `onChange` / `label` / `testId` and none of them
 * should have to know about `onCheckedChange` or about the label being a sibling element.
 */
export function Toggle({
  checked,
  onChange,
  label,
  testId,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label?: string;
  readonly testId?: string;
}) {
  const id = useId();
  const control = (
    <Switch
      id={id}
      size="sm"
      checked={checked}
      aria-label={label}
      data-testid={testId}
      onCheckedChange={onChange}
    />
  );
  if (label === undefined) return control;
  return (
    <span className="flex items-center gap-2">
      {control}
      {/* The word beside the switch toggles it too — a `<button>` is a labelable element. */}
      <Label htmlFor={id} className="text-xs font-normal text-fg-1">
        {label}
      </Label>
    </span>
  );
}

/** A closed vocabulary, as a row of chips. One choice. */
export function ChipGroup<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (next: T) => void;
  readonly testId?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
          className={cn(
            "inline-flex h-6 items-center rounded-xl border px-2.5 text-xs",
            option.value === value
              ? "border-primary bg-primary-soft text-primary"
              : "border-line-strong bg-surface-2 text-fg-1 hover:bg-surface-3",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The same, but any number of them may be on. */
export function ChipMulti<T extends string>({
  values,
  options,
  onChange,
  testId,
}: {
  readonly values: readonly T[];
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (next: T[]) => void;
  readonly testId?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map((option) => {
        const on = values.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => {
              onChange(on ? values.filter((v) => v !== option.value) : [...values, option.value]);
            }}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-xl border px-2.5 text-xs",
              on
                ? "border-primary bg-primary-soft text-primary"
                : "border-line-strong bg-surface-2 text-fg-1 hover:bg-surface-3",
            )}
          >
            {on ? <Check className="size-3" aria-hidden="true" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A read-only value that comes from somewhere the Console cannot edit. */
export function ReadOnly({ value, note }: { readonly value: string; readonly note?: string }) {
  return (
    <span className="flex items-center gap-2">
      <code className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-2xs text-fg-2">
        {value}
      </code>
      {note === undefined ? null : <span className="text-2xs text-fg-3">{note}</span>}
    </span>
  );
}
