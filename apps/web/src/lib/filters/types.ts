/**
 * The vocabulary of the library filter builder — **client-safe and import-free**.
 *
 * A filter is a tree: a group (`and` / `or`) of conditions, each condition a *whitelisted
 * field*, an operator that field allows, and operands. Three properties matter and none of
 * them is decoration:
 *
 *  - **the field is data, never a string from the URL.** A condition names a field by key, and
 *    the key has to be in the page's declared set before anything is compiled. A filter that
 *    could name a column would be a SQL injection surface and a way to sort by something with
 *    no index;
 *  - **the operand is typed by the field.** `year` takes numbers, `hasCover` takes a boolean,
 *    `format` takes one of a fixed list. The zod schema in `schema.ts` enforces it, so the
 *    compiler downstream can coerce without re-checking;
 *  - **nothing here imports anything.** The routes validate their search parameters against
 *    these declarations, so they import them *as values* into the browser bundle
 *    (`client-boundary.guard.test.ts` computes purity rather than trusting a list).
 *
 * The tree is deliberately more general than the current UI. `or` is compiled, encoded and
 * tested; the filter bar only ever builds one level of it, and can grow into nested groups
 * without anything below the component changing.
 */

/* ------------------------------------------------------------------ */
/* operators                                                           */
/* ------------------------------------------------------------------ */

export const FILTER_OPERATORS = [
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "notIn",
  "is",
  "isEmpty",
  "isNotEmpty",
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export function isFilterOperator(value: string): value is FilterOperator {
  return (FILTER_OPERATORS as readonly string[]).includes(value);
}

/** What a chip says, and what the operator picker offers. */
export const FILTER_OPERATOR_LABELS: Readonly<Record<FilterOperator, string>> = Object.freeze({
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  eq: "is",
  neq: "is not",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  between: "between",
  in: "is one of",
  notIn: "is none of",
  is: "is",
  isEmpty: "is not set",
  isNotEmpty: "is set",
});

/**
 * How many operands an operator takes, as `[min, max]`.
 *
 * `in` / `notIn` are open-ended and capped, because a list is the one operand that a URL can
 * make arbitrarily long and the one a database would then turn into an arbitrarily long `or`.
 */
export const FILTER_OPERATOR_ARITY: Readonly<Record<FilterOperator, readonly [number, number]>> =
  Object.freeze({
    contains: [1, 1],
    notContains: [1, 1],
    startsWith: [1, 1],
    endsWith: [1, 1],
    eq: [1, 1],
    neq: [1, 1],
    gt: [1, 1],
    gte: [1, 1],
    lt: [1, 1],
    lte: [1, 1],
    between: [2, 2],
    in: [1, 24],
    notIn: [1, 24],
    is: [1, 1],
    isEmpty: [0, 0],
    isNotEmpty: [0, 0],
  });

/* ------------------------------------------------------------------ */
/* fields                                                              */
/* ------------------------------------------------------------------ */

/**
 * What the value editor renders, and what the operands mean.
 *
 * There is no `range` type: a range is the `between` operator on a `number` or a `date`, which
 * is why the editor draws two boxes for it and one for everything else. A type that meant
 * "two numbers" would have to be re-invented for dates the day somebody asked.
 */
export type FilterFieldType = "text" | "number" | "enum" | "boolean" | "date";

export interface FilterFieldOption {
  readonly value: string;
  readonly label: string;
  /** One line under the option in the picker: what this state actually means. */
  readonly hint?: string;
}

export interface FilterFieldDef {
  /** The key in the URL. Short, lower camel case, stable — it is part of a shared link. */
  readonly name: string;
  readonly label: string;
  readonly type: FilterFieldType;
  readonly operators: readonly FilterOperator[];
  /** `enum` only: every value the field accepts, in the order the picker offers them. */
  readonly options?: readonly FilterFieldOption[];
  /** Shown under the value editor and on the field picker. */
  readonly hint?: string;
  /** `number` only: the bounds the editor suggests and the schema enforces. */
  readonly min?: number;
  readonly max?: number;
  /** `number` only: written after the value on the chip — `%`, `s`, `tracks`. */
  readonly unit?: string;
}

export type FilterFieldSet = readonly FilterFieldDef[];

export function findField(fields: FilterFieldSet, name: string): FilterFieldDef | undefined {
  return fields.find((field) => field.name === name);
}

/* ------------------------------------------------------------------ */
/* the tree                                                            */
/* ------------------------------------------------------------------ */

export type FilterJoin = "and" | "or";

export interface FilterCondition {
  readonly kind: "condition";
  readonly field: string;
  readonly op: FilterOperator;
  /**
   * The operands, as written in the URL.
   *
   * Strings even for numbers and booleans: the URL is the storage format, the zod schema has
   * already proved every one of them parses under the field's type, and the compiler coerces
   * once, where it knows which column it is talking to. Parsing twice is how the two halves
   * come to disagree.
   */
  readonly values: readonly string[];
}

export interface FilterGroup {
  readonly kind: "group";
  readonly join: FilterJoin;
  readonly children: readonly FilterNode[];
}

export type FilterNode = FilterCondition | FilterGroup;

/** No filter at all. The one value that compiles to "no `where` clause". */
export const EMPTY_FILTER: FilterGroup = Object.freeze({
  kind: "group",
  join: "and",
  children: Object.freeze([]) as readonly FilterNode[],
});

export function isEmptyFilter(node: FilterGroup): boolean {
  return node.children.length === 0;
}

/** Every condition of a tree, in the order it is written. */
export function conditionsOf(node: FilterNode): readonly FilterCondition[] {
  if (node.kind === "condition") return [node];
  return node.children.flatMap(conditionsOf);
}
