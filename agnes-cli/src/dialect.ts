import type { ColumnType } from "./ir";

export type Dialect = "postgres" | "mysql" | "sqlite";

// Logical type → physical column type per dialect.
const TYPE_MAP: Record<Dialect, Record<ColumnType, string>> = {
  postgres: {
    int: "integer",
    bigint: "bigint",
    text: "text",
    bool: "boolean",
    float: "double precision",
    bytes: "bytea",
    json: "jsonb",
  },
  mysql: {
    int: "int",
    bigint: "bigint",
    text: "text",
    bool: "tinyint(1)",
    float: "double",
    bytes: "blob",
    json: "json",
  },
  sqlite: {
    int: "integer",
    bigint: "integer",
    text: "text",
    bool: "integer",
    float: "real",
    bytes: "blob",
    json: "text",
  },
};

export function physicalType(dialect: Dialect, type: ColumnType): string {
  return TYPE_MAP[dialect][type];
}

/** Reverse-map a raw DB type name back to a logical ColumnType (best effort). */
export function logicalType(raw: string): ColumnType {
  const t = raw.toLowerCase();
  if (t.includes("bigint")) return "bigint";
  if (t.includes("int")) return "int"; // tinyint/smallint/int/integer
  if (t.includes("bool")) return "bool";
  if (t.includes("double") || t.includes("real") || t.includes("float") || t.includes("numeric") || t.includes("decimal"))
    return "float";
  if (t.includes("json")) return "json";
  if (t.includes("blob") || t.includes("bytea") || t.includes("binary")) return "bytes";
  return "text"; // text/varchar/char/uuid/timestamp/etc. collapse to text
}

export function ident(dialect: Dialect, name: string): string {
  return dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
}

/** Render a default value as a SQL literal. */
export function defaultLiteral(dialect: Dialect, value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") {
    if (dialect === "postgres") return value ? "TRUE" : "FALSE";
    return value ? "1" : "0";
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  // Strings / everything else → single-quoted, escaped.
  return `'${String(value).replace(/'/g, "''")}'`;
}
