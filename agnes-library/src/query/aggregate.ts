import type { Column } from "../schema";
import type { AggFn, Dialect, WhereOp } from "./builder";
import { ident } from "./utils";

export interface Aggregate {
  fn: AggFn;
  /** Physical column name, or "*" for COUNT(*). */
  col: string;
}

/** `COUNT(col)`, or `COUNT(*)` when called with no column. */
export function count(col?: Column<unknown, boolean>): Aggregate {
  return { fn: "count", col: col ? col.name : "*" };
}
export function sum(col: Column<unknown, boolean>): Aggregate {
  return { fn: "sum", col: col.name };
}
export function avg(col: Column<unknown, boolean>): Aggregate {
  return { fn: "avg", col: col.name };
}
export function min(col: Column<unknown, boolean>): Aggregate {
  return { fn: "min", col: col.name };
}
export function max(col: Column<unknown, boolean>): Aggregate {
  return { fn: "max", col: col.name };
}

export function renderAgg(dialect: Dialect, a: Aggregate): string {
  const inner = a.col === "*" ? "*" : ident(dialect, a.col);
  return `${a.fn.toUpperCase()}(${inner})`;
}

export interface HavingClause {
  agg: Aggregate;
  op: WhereOp;
  value: unknown;
}