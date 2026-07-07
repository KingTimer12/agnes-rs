import type {
  Column,
  TableDef,
  InferRow,
  InferInsert,
  RelationKeys,
} from "../schema";
import type { QueryRunner } from "../bridge";
import type { Dialect } from "./builder";

export function placeholder(dialect: Dialect, n: number): string {
  return dialect === "postgres" ? `$${n}` : "?";
}

export function ident(dialect: Dialect, name: string): string {
  const q = (p: string) => (dialect === "mysql" ? `\`${p}\`` : `"${p}"`);
  return name.includes(".") ? name.split(".").map(q).join(".") : q(name);
}

/** RETURNING clause. Throws on MySQL, which has no RETURNING. */
export function returningClause(dialect: Dialect, returning: string[] | "*" | undefined): string {
  if (!returning) return "";
  if (dialect === "mysql")
    throw new Error("RETURNING is not supported on MySQL; use a follow-up SELECT instead");
  const cols = returning === "*" ? "*" : returning.map((c) => ident(dialect, c)).join(", ");
  return ` RETURNING ${cols}`;
}

// ─── Aggregations ─────────────────────────────────────────────────────────────

// ─── SelectBuilder ────────────────────────────────────────────────────────────

// ─── InsertBuilder ────────────────────────────────────────────────────────────

// Bound-parameter ceilings: split a bulk insert into this many rows per
// statement so we never exceed the driver's placeholder limit. SQLite defaults
// to 32766 vars (older builds 999); Postgres allows 65535. Stay conservative.
export function maxVars(dialect: Dialect): number {
  return dialect === "sqlite" ? 900 : 60000;
}

// ─── UpdateBuilder ────────────────────────────────────────────────────────────

// ─── DeleteBuilder ────────────────────────────────────────────────────────────

export type { Dialect };
