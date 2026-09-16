/**
 * The filter tree's URL encoding, and the zod schema that lets it back in.
 *
 * ## The encoding
 *
 * One search parameter, `f`, holding a small expression language. It is compact enough to
 * paste into a chat window and legible enough to read there:
 *
 * ```
 * title:contains:daft punk;year:between:1990|2000
 * completion:eq:incomplete;(hasCover:is:false,schema:eq:behind)
 * ```
 *
 *  - a **condition** is `field:operator` or `field:operator:operand|operand`;
 *  - `;` joins with **and**, `,` joins with **or**, and mixing the two at one level is a
 *    syntax error rather than a precedence rule nobody would guess right — write the
 *    parentheses;
 *  - `( … )` is a nested group, so `or` is expressible today even though the filter bar only
 *    offers one level of it;
 *  - `\` escapes any of `\ : ; , ( ) |` inside an operand, which is what lets a title contain
 *    a colon.
 *
 * JSON in a query string was the alternative and is worse on every count that matters here:
 * three times longer once encoded, unreadable in a link, and no cheaper to validate.
 *
 * ## Getting it wrong
 *
 * `decodeFilter` never throws. A malformed `f` — a truncated link, a field somebody invented,
 * an operator a field does not allow — yields the *empty* tree and a sentence saying what was
 * wrong, which the page renders above the list. A filter is a view, and a broken view must
 * degrade to the unfiltered one, not to a 500.
 *
 * Client-safe: zod and this directory's own types, nothing else.
 */
import { z } from "zod";
import {
  EMPTY_FILTER,
  FILTER_OPERATORS,
  FILTER_OPERATOR_ARITY,
  FILTER_OPERATOR_LABELS,
  findField,
  isEmptyFilter,
  type FilterCondition,
  type FilterFieldDef,
  type FilterFieldSet,
  type FilterGroup,
  type FilterNode,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

/** A URL is untrusted input; a tree from one gets a size, a width and a depth. */
export const FILTER_LIMITS = Object.freeze({
  conditions: 12,
  depth: 3,
  /*
   * Wider than `conditions` on purpose. The structural schema runs first, so if this were the
   * bound that fired on an oversized tree the reader would be shown zod's "expected array to
   * have <=12 items" rather than a sentence about filters. This is the absurdity guard; the
   * line above is the one that counts what a person would recognise.
   */
  children: 32,
  operandLength: 200,
});

/* ------------------------------------------------------------------ */
/* lexing                                                              */
/* ------------------------------------------------------------------ */

const SPECIAL = new Set(["\\", ":", ";", ",", "(", ")", "|"]);

function escapeToken(value: string): string {
  let out = "";
  for (const character of value) out += SPECIAL.has(character) ? `\\${character}` : character;
  return out;
}

function unescapeToken(value: string): string {
  let out = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      out += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    out += character;
  }
  return out;
}

class FilterSyntaxError extends Error {}

/**
 * Split on the given separators at depth zero, honouring `\` and `( … )`.
 *
 * Returns which separator was used, because "which one" is the and/or of the level — and
 * refuses a level that used both, which is the ambiguity this grammar does not resolve
 * silently.
 */
function splitTop(
  input: string,
  separators: readonly string[],
): { readonly separator: string | null; readonly parts: readonly string[] } {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let escaped = false;
  let separator: string | null = null;

  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      current += character;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new FilterSyntaxError('there is a ")" with no "(" before it');
      current += character;
      continue;
    }
    if (depth === 0 && separators.includes(character)) {
      if (separator === null) separator = character;
      else if (separator !== character) {
        throw new FilterSyntaxError(
          'one level mixes ";" (and) with "," (or): put the "or" part in parentheses',
        );
      }
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }

  if (escaped) throw new FilterSyntaxError('it ends on a "\\" that escapes nothing');
  if (depth !== 0) throw new FilterSyntaxError('there is a "(" that is never closed');
  parts.push(current);
  return { separator, parts };
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

function parseCondition(input: string): FilterNode {
  const { parts } = splitTop(input, [":"]);
  if (parts.length < 2 || parts.length > 3) {
    throw new FilterSyntaxError(
      `"${input}" is not "field:operator" or "field:operator:value" (escape a ":" inside a value with "\\:")`,
    );
  }
  const field = unescapeToken(parts[0] ?? "").trim();
  const op = unescapeToken(parts[1] ?? "").trim();
  const rest = parts[2];
  const values = rest === undefined ? [] : splitTop(rest, ["|"]).parts.map(unescapeToken);
  // The structural schema re-checks all of this; the cast is what carries the shape across.
  return { kind: "condition", field, op, values } as FilterCondition;
}

function parseNode(input: string): FilterNode {
  const trimmed = input.trim();
  if (trimmed === "") throw new FilterSyntaxError("there is an empty condition between separators");

  const { separator, parts } = splitTop(trimmed, [";", ","]);
  if (separator !== null) {
    return {
      kind: "group",
      join: separator === ";" ? "and" : "or",
      children: parts.map(parseNode),
    };
  }

  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    const inner = parseNode(trimmed.slice(1, -1));
    return inner;
  }

  return parseCondition(trimmed);
}

/* ------------------------------------------------------------------ */
/* the structural schema                                               */
/* ------------------------------------------------------------------ */

const conditionSchema = z.object({
  kind: z.literal("condition"),
  field: z.string().min(1).max(40),
  op: z.enum(FILTER_OPERATORS),
  values: z.array(z.string().max(FILTER_LIMITS.operandLength)).max(FILTER_LIMITS.children * 2),
});

const nodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([conditionSchema, groupSchema]),
) as z.ZodType<FilterNode>;

const groupSchema: z.ZodType<FilterGroup> = z.object({
  kind: z.literal("group"),
  join: z.enum(["and", "or"]),
  children: z.array(nodeSchema).max(FILTER_LIMITS.children),
});

/* ------------------------------------------------------------------ */
/* the semantic check                                                  */
/* ------------------------------------------------------------------ */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkNumber(value: string, def: FilterFieldDef): string | null {
  if (value.trim() === "") return `${def.label} needs a number.`;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `"${value}" is not a number for ${def.label}.`;
  if (def.min !== undefined && parsed < def.min) {
    return `${def.label} cannot be below ${String(def.min)}.`;
  }
  if (def.max !== undefined && parsed > def.max) {
    return `${def.label} cannot be above ${String(def.max)}.`;
  }
  return null;
}

/** Everything about one condition that the field set, rather than the grammar, decides. */
function conditionProblem(condition: FilterCondition, fields: FilterFieldSet): string | null {
  const def = findField(fields, condition.field);
  if (def === undefined) return `"${condition.field}" is not a field this page can filter on.`;
  if (!def.operators.includes(condition.op)) {
    return `${def.label} does not support "${FILTER_OPERATOR_LABELS[condition.op]}".`;
  }

  const [min, max] = FILTER_OPERATOR_ARITY[condition.op];
  const count = condition.values.length;
  if (count < min || count > max) {
    return `"${FILTER_OPERATOR_LABELS[condition.op]}" on ${def.label} takes ${
      min === max ? String(min) : `${String(min)} to ${String(max)}`
    } value(s), not ${String(count)}.`;
  }
  if (count === 0) return null;

  switch (def.type) {
    case "text": {
      for (const value of condition.values) {
        if (value.trim() === "") return `${def.label} needs something to compare against.`;
      }
      return null;
    }
    case "number": {
      for (const value of condition.values) {
        const problem = checkNumber(value, def);
        if (problem !== null) return problem;
      }
      if (condition.op === "between") {
        const from = Number(condition.values[0]);
        const to = Number(condition.values[1]);
        if (from > to) return `${def.label}: the range starts above where it ends.`;
      }
      return null;
    }
    case "enum": {
      const allowed = new Set((def.options ?? []).map((option) => option.value));
      for (const value of condition.values) {
        if (!allowed.has(value)) return `"${value}" is not one of ${def.label}'s values.`;
      }
      return null;
    }
    case "boolean": {
      const value = condition.values[0];
      if (value !== "true" && value !== "false") {
        return `${def.label} is true or false, not "${value ?? ""}".`;
      }
      return null;
    }
    case "date": {
      for (const value of condition.values) {
        if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
          return `${def.label} wants a date as YYYY-MM-DD, not "${value}".`;
        }
      }
      if (condition.op === "between") {
        const from = condition.values[0] ?? "";
        const to = condition.values[1] ?? "";
        if (from > to) return `${def.label}: the range starts above where it ends.`;
      }
      return null;
    }
  }
}

function treeProblem(node: FilterNode, fields: FilterFieldSet, depth: number): string | null {
  if (node.kind === "condition") return conditionProblem(node, fields);
  if (depth > FILTER_LIMITS.depth) {
    return `The filter nests more than ${String(FILTER_LIMITS.depth)} groups deep.`;
  }
  for (const child of node.children) {
    const problem = treeProblem(child, fields, depth + 1);
    if (problem !== null) return problem;
  }
  return null;
}

function countConditions(node: FilterNode): number {
  return node.kind === "condition" ? 1 : node.children.reduce((n, c) => n + countConditions(c), 0);
}

/**
 * The page's filter schema: the grammar, then the whitelist.
 *
 * Exported so a server function can validate a tree it was handed as a structure rather than
 * as a string — `inputValidator` takes this, and an unknown field is refused there too rather
 * than only on the way out of `decodeFilter`.
 */
export function filterTreeSchema(fields: FilterFieldSet): z.ZodType<FilterGroup> {
  return groupSchema.superRefine((tree, ctx) => {
    const total = countConditions(tree);
    if (total > FILTER_LIMITS.conditions) {
      ctx.addIssue({
        code: "custom",
        message: `A filter may hold ${String(FILTER_LIMITS.conditions)} conditions at most; this one has ${String(total)}.`,
      });
      return;
    }
    const problem = treeProblem(tree, fields, 1);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  }) as z.ZodType<FilterGroup>;
}

/* ------------------------------------------------------------------ */
/* the two directions                                                  */
/* ------------------------------------------------------------------ */

function encodeNode(node: FilterNode, depth: number): string {
  if (node.kind === "condition") {
    const head = `${escapeToken(node.field)}:${escapeToken(node.op)}`;
    if (node.values.length === 0) return head;
    return `${head}:${node.values.map(escapeToken).join("|")}`;
  }
  const separator = node.join === "and" ? ";" : ",";
  const body = node.children.map((child) => encodeNode(child, depth + 1)).join(separator);
  // Parentheses only where they change the reading: never at the root, never around one child.
  return depth === 0 || node.children.length <= 1 ? body : `(${body})`;
}

/** The tree as it is written into `?f=`. The empty tree encodes to the empty string. */
export function encodeFilter(tree: FilterGroup): string {
  return isEmptyFilter(tree) ? "" : encodeNode(tree, 0);
}

export interface DecodedFilter {
  readonly tree: FilterGroup;
  /**
   * What was wrong with the string, in a sentence meant for the person who opened the link.
   * `null` when the filter was read whole — including when there was no filter at all.
   */
  readonly error: string | null;
}

/**
 * Read `?f=` back. Never throws, and never returns a half-applied tree.
 *
 * A filter that does not parse in full is *no filter*: applying the conditions that happened
 * to survive would show a list nobody asked for, under a URL that says otherwise.
 */
export function decodeFilter(raw: string | undefined, fields: FilterFieldSet): DecodedFilter {
  const input = (raw ?? "").trim();
  if (input === "") return { tree: EMPTY_FILTER, error: null };

  let parsed: FilterNode;
  try {
    parsed = parseNode(input);
  } catch (error) {
    const detail = error instanceof FilterSyntaxError ? error.message : "it could not be read";
    return { tree: EMPTY_FILTER, error: `The filter in this link was ignored: ${detail}.` };
  }

  const tree: FilterNode =
    parsed.kind === "group" ? parsed : { kind: "group", join: "and", children: [parsed] };

  const result = filterTreeSchema(fields).safeParse(tree);
  if (!result.success) {
    const first = result.error.issues[0]?.message ?? "it names something this page does not have";
    return { tree: EMPTY_FILTER, error: `The filter in this link was ignored: ${first}` };
  }
  return { tree: result.data, error: null };
}

/* ------------------------------------------------------------------ */
/* small helpers the filter bar needs                                  */
/* ------------------------------------------------------------------ */

/** The operands of one condition, written the way a chip shows them. */
export function describeValues(def: FilterFieldDef, condition: FilterCondition): string {
  const label = (value: string): string =>
    def.type === "enum"
      ? ((def.options ?? []).find((option) => option.value === value)?.label ?? value)
      : def.type === "boolean"
        ? value === "true"
          ? "yes"
          : "no"
        : def.type === "number" && def.unit !== undefined
          ? `${value} ${def.unit}`
          : value;

  if (condition.values.length === 0) return "";
  if (condition.op === "between") {
    return `${label(condition.values[0] ?? "")} – ${label(condition.values[1] ?? "")}`;
  }
  return condition.values.map(label).join(", ");
}

/** Add a condition to the top level of a tree, keeping the tree's own join. */
export function addCondition(tree: FilterGroup, condition: FilterCondition): FilterGroup {
  return { ...tree, children: [...tree.children, condition] };
}

/** Replace the `index`-th top-level child, or drop it when `next` is `null`. */
export function replaceChild(
  tree: FilterGroup,
  index: number,
  next: FilterNode | null,
): FilterGroup {
  const children = tree.children.flatMap((child, at) =>
    at === index ? (next === null ? [] : [next]) : [child],
  );
  return { ...tree, children };
}

/** Flip the whole bar between "match all" and "match any". */
export function withJoin(tree: FilterGroup, join: FilterGroup["join"]): FilterGroup {
  return { ...tree, join };
}
