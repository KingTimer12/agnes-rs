// DDL generation — emit CREATE TABLE / CREATE INDEX from a schema definition.
// This is idempotent "schema push" (CREATE ... IF NOT EXISTS), not a diffing
// migration: it creates what's missing but never alters or drops existing
// objects. Full diff migrations need live-DB introspection (a later feature).

import {
  Column,
  OneRelation,
  type ColumnType,
  type Schema,
  type TableDef,
  type TableEntry,
} from "../schema";
import type { Dialect } from "./builder";

function ident(dialect: Dialect, name: string): string {
  const q = (p: string) => (dialect === "mysql" ? `\`${p}\`` : `"${p}"`);
  return name.includes(".") ? name.split(".").map(q).join(".") : q(name);
}

function baseType(dialect: Dialect, t: ColumnType): string {
  switch (t) {
    case "int":
      return dialect === "postgres" ? "INTEGER" : dialect === "mysql" ? "INT" : "INTEGER";
    case "bigint":
      return dialect === "sqlite" ? "INTEGER" : "BIGINT";
    case "text":
      return "TEXT";
    case "bool":
      return dialect === "postgres" ? "BOOLEAN" : dialect === "mysql" ? "TINYINT(1)" : "INTEGER";
    case "float":
      return dialect === "postgres" ? "DOUBLE PRECISION" : dialect === "mysql" ? "DOUBLE" : "REAL";
    case "bytes":
      return dialect === "postgres" ? "BYTEA" : "BLOB";
    case "json":
      return dialect === "postgres" ? "JSONB" : dialect === "mysql" ? "JSON" : "TEXT";
  }
}

/** SQL literal for a column default. Returns null for unsupported value kinds. */
function defaultLiteral(dialect: Dialect, v: unknown): string | null {
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") {
    if (dialect === "postgres") return v ? "TRUE" : "FALSE";
    return v ? "1" : "0";
  }
  return null;
}

interface ColumnLine {
  sql: string;
  /** True when the line itself carries `PRIMARY KEY` (SQLite autoincrement). */
  inlinePk: boolean;
}

function columnLine(dialect: Dialect, col: Column<unknown, boolean>): ColumnLine {
  const name = ident(dialect, col.name);
  const auto = col.flags.autoincrement === true;
  const primary = col.flags.primary === true;

  // SQLite: an autoincrement PK must be exactly `INTEGER PRIMARY KEY AUTOINCREMENT`.
  if (dialect === "sqlite" && auto && primary) {
    return { sql: `${name} INTEGER PRIMARY KEY AUTOINCREMENT`, inlinePk: true };
  }

  let type: string;
  if (auto && dialect === "postgres") {
    type = col.type === "bigint" ? "BIGSERIAL" : "SERIAL";
  } else if (auto && dialect === "mysql") {
    type = `${baseType(dialect, col.type)} AUTO_INCREMENT`;
  } else {
    type = baseType(dialect, col.type);
  }

  let sql = `${name} ${type}`;
  if (!col.flags.nullable && !primary) sql += " NOT NULL";
  if (col.flags.default !== undefined) {
    const lit = defaultLiteral(dialect, col.flags.default);
    if (lit !== null) sql += ` DEFAULT ${lit}`;
  }
  return { sql, inlinePk: false };
}

/** CREATE TABLE IF NOT EXISTS for one table entry (columns, PK, FKs). */
export function createTableSql(dialect: Dialect, entry: TableEntry<TableDef>, schema: Schema): string {
  const cols: string[] = [];
  const pkCols: string[] = [];
  let hasInlinePk = false;

  for (const field of Object.values(entry.def)) {
    if (field instanceof Column) {
      const line = columnLine(dialect, field);
      cols.push(line.sql);
      if (line.inlinePk) hasInlinePk = true;
      else if (field.flags.primary) pkCols.push(ident(dialect, field.name));
    }
  }

  const constraints: string[] = [];
  if (!hasInlinePk && pkCols.length > 0) {
    constraints.push(`PRIMARY KEY (${pkCols.join(", ")})`);
  }

  for (const field of Object.values(entry.def)) {
    if (!(field instanceof OneRelation)) continue;
    const localCol = entry.def[field.localKey];
    const target = schema[field.target] as TableEntry<TableDef> | undefined;
    if (!(localCol instanceof Column) || !target) continue;
    const targetCol = target.def[field.targetKey];
    if (!(targetCol instanceof Column)) continue;
    constraints.push(
      `FOREIGN KEY (${ident(dialect, localCol.name)}) ` +
        `REFERENCES ${ident(dialect, target.tableName)} (${ident(dialect, targetCol.name)}) ` +
        `ON UPDATE ${field.onUpdate} ON DELETE ${field.onDelete}`,
    );
  }

  const body = [...cols, ...constraints].join(", ");
  return `CREATE TABLE IF NOT EXISTS ${ident(dialect, entry.tableName)} (${body})`;
}

/** CREATE [UNIQUE] INDEX IF NOT EXISTS statements for a table's indexed columns. */
function indexStatements(dialect: Dialect, entry: TableEntry<TableDef>): string[] {
  const out: string[] = [];
  for (const field of Object.values(entry.def)) {
    if (field instanceof Column && field.flags.index) {
      const { name, unique } = field.flags.index;
      out.push(
        `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${ident(dialect, name)} ` +
          `ON ${ident(dialect, entry.tableName)} (${ident(dialect, field.name)})`,
      );
    }
  }
  return out;
}

/**
 * Order tables so a table referenced by a foreign key is created before the
 * table that references it. Best-effort: cycles fall back to declaration order.
 */
function topoSort(schema: Schema): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const visiting = new Set<string>();

  const visit = (key: string) => {
    if (visited.has(key) || visiting.has(key)) return; // cycle → bail on this edge
    visiting.add(key);
    const entry = schema[key];
    if (entry) {
      for (const field of Object.values(entry.def)) {
        if (field instanceof OneRelation && field.target !== key && schema[field.target]) {
          visit(field.target);
        }
      }
    }
    visiting.delete(key);
    visited.add(key);
    order.push(key);
  };

  for (const key of Object.keys(schema)) visit(key);
  return order;
}

/**
 * All DDL statements to create a schema: every CREATE TABLE (dependency-ordered)
 * followed by every CREATE INDEX. Safe to run repeatedly — all use IF NOT EXISTS.
 */
export function generateSchemaDdl(dialect: Dialect, schema: Schema): string[] {
  const ordered = topoSort(schema);
  const tables: string[] = [];
  const indexes: string[] = [];
  for (const key of ordered) {
    const entry = schema[key];
    if (!entry) continue;
    tables.push(createTableSql(dialect, entry, schema));
    indexes.push(...indexStatements(dialect, entry));
  }
  return [...tables, ...indexes];
}
