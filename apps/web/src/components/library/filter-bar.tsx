/**
 * The library's filter conditions: chips, each one a field, an operator and a value.
 *
 * A chip is a *condition*, not a preset. `Year at least 2000`, `Completion is Unknown total`,
 * `Format is one of Opus, FLAC` — composable, each removable on its own, the whole lot encoded
 * into `?f=` so the view is a link. `filter-chips.tsx` next door stays what it always was: the
 * fixed presets, which are links and not state.
 *
 * This file no longer draws a *bar*. It used to own a row of its own — a filter icon, the
 * chips, the builder trigger, and a `Callout` underneath — sitting between the search box and
 * the presets, which is how the filter area came to take three lines for one idea. What it
 * exports now are the two pieces that row was made of, `FilterConditions` and `FilterNotice`,
 * so that `components/library/filter-toolbar.tsx` can place them in one row with everything
 * else that filters.
 *
 * ## Why it is written here rather than installed
 *
 * The shape is borrowed from the chip-based filter bars going around (reui's is the one the
 * owner pointed at); nothing else is. It is built out of this Console's own primitives —
 * `Popover`, `Select`, `Input`, `Checkbox`, `Button`, `Callout` — and its own tokens, because
 * a second component library would arrive with a second set of colours, a second focus ring
 * and a second idea of what a small button is.
 *
 * ## What it can and cannot build
 *
 * The bar builds **one level**: a list of conditions joined by all/any. The tree underneath it
 * is fully recursive and the compiler, the encoding and the tests all handle nested groups, so
 * a link holding `a;(b,c)` renders here — as a read-only group chip that can be removed but
 * not edited. Growing the editor into nested groups is a change to this file alone.
 *
 * ## Keyboard and screen reader
 *
 * Every control is a real `<button>`, `<input>` or `<select>`; the popover is Base UI's, which
 * owns the focus trap and Escape. A chip's accessible name is the whole condition read out
 * ("Year at least 2000"), and its remove button names what it removes — nothing here is
 * distinguishable by colour alone, because the chip says in words what it is.
 */
import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger } from "#/components/ui/select.tsx";
import { Callout } from "#/components/callout.tsx";
import {
  FILTER_OPERATOR_ARITY,
  FILTER_OPERATOR_LABELS,
  addCondition,
  conditionsOf,
  decodeFilter,
  describeValues,
  encodeFilter,
  findField,
  replaceChild,
  withJoin,
  type FilterCondition,
  type FilterFieldDef,
  type FilterFieldSet,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
} from "#/lib/filters/index.ts";

export interface FilterConditionsProps {
  readonly fields: FilterFieldSet;
  /** The `?f=` value, exactly as the URL holds it. */
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly testId?: string;
}

export interface FilterNoticeProps {
  readonly fields: FilterFieldSet;
  readonly value: string;
  /** What the *server* made of the same string. Wins over what this side decodes. */
  readonly error?: string | null;
}

/* ------------------------------------------------------------------ */
/* one chip                                                            */
/* ------------------------------------------------------------------ */

const CHIP =
  "inline-flex h-7 items-center gap-1 rounded-lg border border-line-strong bg-surface-2 pl-2.5 text-xs text-fg-1";

function conditionLabel(fields: FilterFieldSet, condition: FilterCondition): string {
  const def = findField(fields, condition.field);
  if (def === undefined) return `${condition.field} ${condition.op}`;
  const values = describeValues(def, condition);
  return `${def.label} ${FILTER_OPERATOR_LABELS[condition.op]}${values === "" ? "" : ` ${values}`}`;
}

/** A nested group, read out as `(this or that)`. Removable; not editable here. */
function groupLabel(fields: FilterFieldSet, group: FilterGroup): string {
  const join = group.join === "and" ? " and " : " or ";
  return `(${conditionsOf(group)
    .map((condition) => conditionLabel(fields, condition))
    .join(join)})`;
}

function Chip({
  label,
  onOpen,
  onRemove,
  testId,
}: {
  readonly label: string;
  readonly onOpen?: () => void;
  readonly onRemove: () => void;
  readonly testId?: string;
}) {
  return (
    <span className={CHIP} data-testid={testId} data-filter-chip={label}>
      {onOpen === undefined ? (
        <span className="py-0.5">{label}</span>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="rounded-l-lg py-0.5 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {label}
        </button>
      )}
      <button
        type="button"
        aria-label={`Remove the filter ${label}`}
        onClick={onRemove}
        className="grid size-6 shrink-0 place-items-center rounded-r-lg text-fg-3 hover:text-danger focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* the value editor                                                    */
/* ------------------------------------------------------------------ */

function ValueEditor({
  def,
  op,
  values,
  onChange,
}: {
  readonly def: FilterFieldDef;
  readonly op: FilterOperator;
  readonly values: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}) {
  const [min] = FILTER_OPERATOR_ARITY[op];
  if (min === 0) {
    return <p className="text-2xs text-fg-3">This operator takes no value.</p>;
  }

  const at = (index: number): string => values[index] ?? "";
  const put = (index: number, next: string): void => {
    const copy = [...values];
    while (copy.length <= index) copy.push("");
    copy[index] = next;
    onChange(copy);
  };

  if (def.type === "boolean") {
    return (
      <Select
        value={at(0) === "" ? "true" : at(0)}
        onValueChange={(next: string | null) => {
          if (next !== null) put(0, next);
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid="filter-value-select"
          aria-label={`${def.label} value`}
          className="w-full text-xs"
        >
          <span data-slot="select-value">{at(0) === "false" ? "No" : "Yes"}</span>
        </SelectTrigger>
        <SelectContent className="text-xs">
          <SelectItem value="true" className="text-xs">
            Yes
          </SelectItem>
          <SelectItem value="false" className="text-xs">
            No
          </SelectItem>
        </SelectContent>
      </Select>
    );
  }

  if (def.type === "enum") {
    const options = def.options ?? [];
    // `in` / `notIn` take a list, so they get boxes; `is` / `is not` take one, so a menu.
    if (op === "in" || op === "notIn") {
      return (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">{def.label}</legend>
          {options.map((option) => {
            const checked = values.includes(option.value);
            return (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 text-xs text-fg-1"
              >
                <Checkbox
                  checked={checked}
                  className="mt-0.5"
                  onCheckedChange={(next: boolean) => {
                    onChange(
                      next
                        ? [...values, option.value]
                        : values.filter((value) => value !== option.value),
                    );
                  }}
                />
                <span>
                  {option.label}
                  {option.hint === undefined ? null : (
                    <span className="block text-2xs text-fg-3">{option.hint}</span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      );
    }
    return (
      <Select
        value={at(0) === "" ? (options[0]?.value ?? "") : at(0)}
        onValueChange={(next: string | null) => {
          if (next !== null) put(0, next);
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid="filter-value-select"
          aria-label={`${def.label} value`}
          className="w-full text-xs"
        >
          <span data-slot="select-value" className="truncate">
            {options.find((option) => option.value === at(0))?.label ?? "Choose…"}
          </span>
        </SelectTrigger>
        <SelectContent className="text-xs">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const type = def.type === "number" ? "number" : def.type === "date" ? "date" : "text";
  const box = (index: number, label: string) => (
    <Input
      type={type}
      className="h-7 text-xs"
      aria-label={label}
      data-testid={`filter-value-${String(index)}`}
      min={def.min}
      max={def.max}
      value={at(index)}
      onChange={(event) => {
        put(index, event.target.value);
      }}
    />
  );

  // A range is `between` on a number or a date, so it is two boxes and never a third type.
  return min === 2 ? (
    <div className="flex items-center gap-1.5">
      {box(0, `${def.label} from`)}
      <span className="text-2xs text-fg-3">to</span>
      {box(1, `${def.label} to`)}
    </div>
  ) : (
    box(0, `${def.label} value`)
  );
}

/* ------------------------------------------------------------------ */
/* the builder popover                                                 */
/* ------------------------------------------------------------------ */

type Draft = { readonly field: FilterFieldDef; readonly op: FilterOperator; values: string[] };

function defaultValues(def: FilterFieldDef, op: FilterOperator): string[] {
  const [min] = FILTER_OPERATOR_ARITY[op];
  if (min === 0) return [];
  if (def.type === "boolean") return ["true"];
  if (def.type === "enum")
    return op === "in" || op === "notIn" ? [] : [def.options?.[0]?.value ?? ""];
  return min === 2 ? ["", ""] : [""];
}

function ConditionBuilder({
  fields,
  initial,
  onCommit,
  onCancel,
}: {
  readonly fields: FilterFieldSet;
  readonly initial: FilterCondition | null;
  readonly onCommit: (condition: FilterCondition) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (initial === null) return null;
    const def = findField(fields, initial.field);
    return def === undefined ? null : { field: def, op: initial.op, values: [...initial.values] };
  });

  if (draft === null) {
    return (
      <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto" data-testid="filter-fields">
        <p className="px-1 pb-1 text-2xs text-fg-3">Filter by…</p>
        {fields.map((def) => (
          <button
            key={def.name}
            type="button"
            data-testid={`filter-field-${def.name}`}
            onClick={() => {
              const op = def.operators[0] ?? "eq";
              setDraft({ field: def, op, values: defaultValues(def, op) });
            }}
            className="rounded-md px-1.5 py-1 text-left text-xs text-fg-1 hover:bg-surface-3 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {def.label}
            {def.hint === undefined ? null : (
              <span className="block text-2xs text-fg-3">{def.hint}</span>
            )}
          </button>
        ))}
      </div>
    );
  }

  const def = draft.field;
  /*
   * Enough operands to be a condition at all.
   *
   * The same arity the schema enforces, checked here so that "Add filter" is simply not
   * available on a half-written chip. Letting it through would write a filter the URL cannot
   * carry, and the reader would meet it as a notice saying the link was ignored — a reproach
   * for a mistake the button could have declined to make.
   */
  const operands = draft.values.filter((value) => value.trim() !== "").length;
  const ready = operands >= FILTER_OPERATOR_ARITY[draft.op][0];

  return (
    <div className="flex flex-col gap-2" data-testid="filter-builder">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{def.label}</span>
        {initial === null ? (
          <button
            type="button"
            onClick={() => {
              setDraft(null);
            }}
            className="text-2xs text-fg-3 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            change field
          </button>
        ) : null}
      </div>

      <Select
        value={draft.op}
        onValueChange={(next: string | null) => {
          if (next === null) return;
          const op = next as FilterOperator;
          setDraft({ field: def, op, values: defaultValues(def, op) });
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid="filter-operator"
          aria-label={`${def.label} operator`}
          className="w-full text-xs"
        >
          <span data-slot="select-value">{FILTER_OPERATOR_LABELS[draft.op]}</span>
        </SelectTrigger>
        <SelectContent className="text-xs">
          {def.operators.map((op) => (
            <SelectItem key={op} value={op} className="text-xs">
              {FILTER_OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ValueEditor
        def={def}
        op={draft.op}
        values={draft.values}
        onChange={(values) => {
          setDraft({ field: def, op: draft.op, values: [...values] });
        }}
      />

      {def.hint === undefined ? null : <p className="text-2xs text-fg-3">{def.hint}</p>}

      <div className="flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          data-testid="filter-apply"
          disabled={!ready}
          onClick={() => {
            onCommit({
              kind: "condition",
              field: def.name,
              op: draft.op,
              values: draft.values.map((value) => value.trim()),
            });
          }}
        >
          {initial === null ? "Add filter" : "Update"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the bar                                                             */
/* ------------------------------------------------------------------ */

/**
 * The conditions and the builder, inline — no row of its own, no margin, no notice.
 *
 * It used to be a strip on its own line under the search box, with the search echoed into it
 * as one more chip. Both of those are gone: it is one item in
 * `components/library/filter-toolbar.tsx`'s single row now, and the free-text search sits two
 * items to its left with its own clear button, so repeating it here was a second copy of one
 * fact rather than a way to remove it.
 */
export function FilterConditions({ fields, value, onChange, testId }: FilterConditionsProps) {
  const decoded = useMemo(() => decodeFilter(value, fields), [value, fields]);
  const tree = decoded.tree;

  /**
   * `null` closed, `"new"` adding, a number editing that top-level child.
   *
   * Every commit closes it, so the only way to be left pointing at a chip that is no longer
   * there is the back button — and `tree.children[editing] ?? null` then reads as "add a new
   * one", which is the harmless reading.
   */
  const [editing, setEditing] = useState<number | "new" | null>(null);

  const commit = (next: FilterGroup): void => {
    setEditing(null);
    onChange(encodeFilter(next));
  };

  const editingChild: FilterNode | null =
    typeof editing === "number" ? (tree.children[editing] ?? null) : null;

  return (
    <div
      role="group"
      aria-label="Filters"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid={testId}
    >
      {tree.children.map((child, index) => (
        <Chip
          key={index}
          testId={`filter-chip-${String(index)}`}
          label={
            child.kind === "condition" ? conditionLabel(fields, child) : groupLabel(fields, child)
          }
          onOpen={
            child.kind === "condition"
              ? () => {
                  setEditing(index);
                }
              : undefined
          }
          onRemove={() => {
            commit(replaceChild(tree, index, null));
          }}
        />
      ))}

      {/*
          One popover for "add" and for "edit this chip", anchored to the trigger either way.
          Its open state *is* `editing`, rather than a second boolean beside it: two sources of
          truth for one panel is how a trigger click ends up closing and reopening it in the
          same tick.
        */}
      <Popover
        open={editing !== null}
        onOpenChange={(open: boolean) => {
          setEditing(open ? (editing === null ? "new" : editing) : null);
        }}
      >
        <PopoverTrigger
          data-testid="filter-add"
          render={
            <button
              type="button"
              className={cn(
                CHIP,
                "cursor-pointer gap-1 pr-2.5 text-fg-2 hover:bg-surface-3 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              )}
            >
              <Plus className="size-3" aria-hidden="true" />
              Filter
            </button>
          }
        />
        <PopoverContent align="start" className="w-64">
          <ConditionBuilder
            // Remounts between "add" and "edit this one", so the draft never leaks across.
            key={typeof editing === "number" ? `edit-${String(editing)}` : "new"}
            fields={fields}
            initial={editingChild?.kind === "condition" ? editingChild : null}
            onCancel={() => {
              setEditing(null);
            }}
            onCommit={(condition) => {
              commit(
                typeof editing === "number"
                  ? replaceChild(tree, editing, condition)
                  : addCondition(tree, condition),
              );
            }}
          />
        </PopoverContent>
      </Popover>

      {tree.children.length > 1 ? (
        <Select
          value={tree.join}
          onValueChange={(next: string | null) => {
            if (next === "and" || next === "or") commit(withJoin(tree, next));
          }}
        >
          <SelectTrigger
            size="sm"
            data-testid="filter-join"
            aria-label="Match all or any of the filters"
            className="h-7 border-line bg-surface-1 text-2xs"
          >
            <span data-slot="select-value">{tree.join === "and" ? "Match all" : "Match any"}</span>
          </SelectTrigger>
          <SelectContent className="text-xs">
            <SelectItem value="and" className="text-xs">
              Match all
            </SelectItem>
            <SelectItem value="or" className="text-xs">
              Match any
            </SelectItem>
          </SelectContent>
        </Select>
      ) : null}

      {tree.children.length > 0 ? (
        <button
          type="button"
          data-testid="filter-clear"
          onClick={() => {
            commit({ ...tree, join: "and", children: [] });
          }}
          className="text-2xs text-fg-3 underline-offset-2 hover:text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

/**
 * What the *server* made of `?f=`, said under the toolbar rather than inside it.
 *
 * Its own component because the conditions are now one item in a single row and a warning
 * banner is not: a notice that widened the row would be a notice that moved every control
 * beside it. The bar decodes the string too, and would reach the same verdict — but the one
 * shown has to be the verdict the query acted on, or a reader could be told the filter applied
 * while the list in front of them says otherwise.
 */
export function FilterNotice({ fields, value, error }: FilterNoticeProps) {
  const decoded = useMemo(() => decodeFilter(value, fields), [value, fields]);
  const notice = error ?? decoded.error;
  if (notice === null || notice === undefined) return null;
  return (
    <Callout tone="warn" role="status" data-testid="filter-error" className="mb-3">
      {notice} Everything is shown.
    </Callout>
  );
}
