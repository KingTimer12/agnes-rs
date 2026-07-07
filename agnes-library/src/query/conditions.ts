import type { Column } from '../schema';
import type { Condition, Dialect, WhereOp } from './builder'
import { ident, placeholder } from './utils';

export function eq<T>(col: Column<T, boolean>, value: T): Condition {
  return { kind: "cmp", col: col.name, op: "=", value };
}
export function neq<T>(col: Column<T, boolean>, value: T): Condition {
  return { kind: "cmp", col: col.name, op: "!=", value };
}
export function gt<T>(col: Column<T, boolean>, value: T): Condition {
  return { kind: "cmp", col: col.name, op: ">", value };
}
export function gte<T>(col: Column<T, boolean>, value: T): Condition {
  return { kind: "cmp", col: col.name, op: ">=", value };
}
export function lt<T>(col: Column<T, boolean>, value: T): Condition {
  return { kind: "cmp", col: col.name, op: "<", value };
}
export function lte<T>(col: Column<T, boolean>, value: T): Condition {
  return { kind: "cmp", col: col.name, op: "<=", value };
}
export function like(col: Column<string, boolean>, value: string): Condition {
  return { kind: "cmp", col: col.name, op: "like", value };
}
/** Case-insensitive LIKE. Postgres `ILIKE`; emulated with `LOWER()` elsewhere. */
export function ilike(col: Column<string, boolean>, value: string): Condition {
  return { kind: "ilike", col: col.name, value };
}
/** `col IN (…)`. An empty list is always-false (never matches). */
export function inArray<T>(col: Column<T, boolean>, values: T[]): Condition {
  return { kind: "in", col: col.name, values, negated: false };
}
/** `col NOT IN (…)`. An empty list is always-true (matches every row). */
export function notInArray<T>(col: Column<T, boolean>, values: T[]): Condition {
  return { kind: "in", col: col.name, values, negated: true };
}
export function isNull(col: Column<unknown, boolean>): Condition {
  return { kind: "null", col: col.name, negated: false };
}
export function isNotNull(col: Column<unknown, boolean>): Condition {
  return { kind: "null", col: col.name, negated: true };
}
export function between<T>(col: Column<T, boolean>, lo: T, hi: T): Condition {
  return { kind: "between", col: col.name, lo, hi };
}
export function and(...children: Condition[]): Condition {
  return { kind: "group", op: "AND", children };
}
export function or(...children: Condition[]): Condition {
  return { kind: "group", op: "OR", children };
}
export function not(child: Condition): Condition {
  return { kind: "not", child };
}

/** Render one predicate, pushing its bound values onto `params`. */
export function renderCondition(dialect: Dialect, c: Condition, params: unknown[]): string {
  switch (c.kind) {
    case "cmp": {
      params.push(c.value);
      return `${ident(dialect, c.col)} ${c.op} ${placeholder(dialect, params.length)}`;
    }
    case "in": {
      if (c.values.length === 0) return c.negated ? "1 = 1" : "1 = 0";
      const phs = c.values.map((v) => {
        params.push(v);
        return placeholder(dialect, params.length);
      });
      return `${ident(dialect, c.col)} ${c.negated ? "NOT IN" : "IN"} (${phs.join(", ")})`;
    }
    case "null":
      return `${ident(dialect, c.col)} IS ${c.negated ? "NOT " : ""}NULL`;
    case "between": {
      params.push(c.lo);
      const lo = placeholder(dialect, params.length);
      params.push(c.hi);
      const hi = placeholder(dialect, params.length);
      return `${ident(dialect, c.col)} BETWEEN ${lo} AND ${hi}`;
    }
    case "ilike": {
      params.push(c.value);
      const ph = placeholder(dialect, params.length);
      return dialect === "postgres"
        ? `${ident(dialect, c.col)} ILIKE ${ph}`
        : `LOWER(${ident(dialect, c.col)}) LIKE LOWER(${ph})`;
    }
    case "not":
      return `NOT (${renderCondition(dialect, c.child, params)})`;
    case "group": {
      if (c.children.length === 0) return c.op === "AND" ? "1 = 1" : "1 = 0";
      return `(${c.children.map((ch) => renderCondition(dialect, ch, params)).join(` ${c.op} `)})`;
    }
  }
}

export function buildWhere(dialect: Dialect, conds: Condition[], params: unknown[]): string {
  if (conds.length === 0) return "";
  const parts = conds.map((c) => renderCondition(dialect, c, params));
  return ` WHERE ${parts.join(" AND ")}`;
}
