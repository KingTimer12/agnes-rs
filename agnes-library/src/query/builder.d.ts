import type { RelationKeys } from "../schema";
import type { RelationQuery } from "./relations";

export type Dialect = "postgres" | "mysql" | "sqlite";
export type WhereOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "like";

export type IncludeValue = true | RelationQuery;
export type IncludeShape<T extends TableDef> = Partial<Record<RelationKeys<T>, IncludeValue>>;

export type JoinType = "left" | "inner" | "right" | "full";

/**
 * A WHERE predicate. A tree of leaves (comparisons, IN, NULL, BETWEEN, ILIKE)
 * and combinators (`and`/`or`/`not`). Build leaves with `eq`/`gt`/`inArray`/…
 * and nest with `and(...)`/`or(...)`/`not(...)`. `where(a, b)` still means
 * `a AND b`.
 */
export type Condition =
  | { kind: "cmp"; col: string; op: WhereOp; value: unknown }
  | { kind: "in"; col: string; values: unknown[]; negated: boolean }
  | { kind: "null"; col: string; negated: boolean }
  | { kind: "between"; col: string; lo: unknown; hi: unknown }
  | { kind: "ilike"; col: string; value: string }
  | { kind: "not"; child: Condition }
  | { kind: "group"; op: "AND" | "OR"; children: Condition[] };

export type AggFn = "count" | "sum" | "avg" | "min" | "max";

/** Row shape returned by `.aggregate()`: the aliases plus any grouped columns. */
export type AggregateRow<A extends Record<string, Aggregate>> = {
  [K in keyof A]: number | null;
} & Record<string, unknown>;

export type ConflictMode = "none" | "ignore" | "merge";
