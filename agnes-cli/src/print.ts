import { qualifiedName, type ColumnType, type DatabaseIR, type TableIR } from "./ir";

const HELPER: Record<ColumnType, string> = {
  int: "int",
  bigint: "bigint",
  text: "text",
  bool: "bool",
  float: "float",
  bytes: "bytes",
  json: "json",
};

const ON_ACTION: Record<string, string> = {
  "NO ACTION": "OnAction.None",
  RESTRICT: "OnAction.Restrict",
  CASCADE: "OnAction.Cascade",
  "SET NULL": "OnAction.SetNull",
  "SET DEFAULT": "OnAction.SetDefault",
};

const HEADER =
  `import { table, int, bigint, text, bool, float, bytes, json, one, OnAction } from "agnes-library";\n`;

function onAction(rule: string): string {
  return ON_ACTION[rule.toUpperCase()] ?? "OnAction.None";
}

/**
 * Render a raw DB default into the `.default(...)` argument for a given column
 * type, or `null` to omit it. Introspection hands us raw strings ("true", "1",
 * "'x'::text", "CURRENT_TIMESTAMP"); we coerce them to the type the DSL expects
 * and drop SQL expressions we can't represent as a literal.
 */
function renderDefault(type: ColumnType, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  // Strip a trailing type cast: 'x'::text, 5::integer, 'a'::character varying.
  const cast = s.replace(/::[\w\s"]+$/, "").trim();
  const quoted = cast.match(/^'([\s\S]*)'$/);
  const inner = quoted ? quoted[1]!.replace(/''/g, "'") : undefined;
  const scalar = inner ?? cast;

  switch (type) {
    case "bool": {
      const t = scalar.toLowerCase();
      if (t === "true" || t === "t" || t === "1") return "true";
      if (t === "false" || t === "f" || t === "0") return "false";
      return null;
    }
    case "int":
    case "float": {
      const n = Number(scalar);
      return scalar !== "" && Number.isFinite(n) ? String(n) : null;
    }
    case "bigint":
      return /^-?\d+$/.test(scalar) ? `${scalar}n` : null;
    case "text":
    case "json":
      // Only string literals; skip expressions (CURRENT_TIMESTAMP, now(), …).
      return inner !== undefined ? JSON.stringify(inner) : null;
    default:
      return null; // bytes
  }
}

/** A qualified name → a valid JS identifier (for the `schema` object keys / relation keys). */
function idKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Render the `table({...}, "physical")` expression. `pad` indents column lines. */
function tableBody(t: TableIR, pad: string): string {
  const physical = qualifiedName(t.name, t.schema);
  const fkByColumn = new Map(t.foreignKeys.map((fk) => [fk.column, fk]));
  const lines: string[] = [];

  // Relation keys must be unique and not collide with column keys. Derive from
  // the local FK column (dropping a trailing _id) so two FKs to the same table
  // (e.g. decisor_etapa_sim_id / _nao_id) get distinct, readable keys.
  const usedKeys = new Set(t.columns.map((c) => c.name));
  const relKeyFor = (fk: { column: string; refTable: string }): string => {
    const base = idKey(fk.column.replace(/_?id$/i, "")) || idKey(fk.refTable);
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base}_${n}`;
    usedKeys.add(key);
    return key;
  };

  for (const col of t.columns) {
    let expr = `${HELPER[col.type]}(${JSON.stringify(col.name)})`;
    if (col.primary) expr += ".primary()";
    else if (col.nullable) expr += ".nullable()";
    if (col.autoincrement) {
      expr += ".autoincrement()";
    } else {
      const d = renderDefault(col.type, col.default);
      if (d !== null) expr += `.default(${d})`;
    }
    for (const idx of t.indexes) {
      if (idx.columns.length === 1 && idx.columns[0] === col.name) {
        expr += idx.unique
          ? `.uniqueIndex(${JSON.stringify(idx.name)})`
          : `.index(${JSON.stringify(idx.name)})`;
      }
    }
    lines.push(`${pad}  ${col.name}: ${expr},`);
  }

  for (const fk of fkByColumn.values()) {
    const relKey = relKeyFor(fk);
    lines.push(
      `${pad}  ${relKey}: one(${JSON.stringify(fk.refTable)}, ${JSON.stringify(fk.column)}, ` +
        `${JSON.stringify(fk.refColumn)}, ${onAction(fk.onUpdate)}, ${onAction(fk.onDelete)}),`,
    );
  }

  return `table({\n${lines.join("\n")}\n${pad}}, ${JSON.stringify(physical)})`;
}

const byQualified = (a: TableIR, b: TableIR) =>
  qualifiedName(a.name, a.schema).localeCompare(qualifiedName(b.name, b.schema));

/**
 * Render the `{ ... }` body of `export const schema`. Default-schema tables sit
 * at the top level (`users: table(...)`); tables from other schemas are grouped
 * one level deep (`legislativo: { etapas: table(...) }`), which flattens to the
 * dotted key `legislativo.etapas` — matching each table's physical name.
 */
function schemaObject(tables: TableIR[]): string {
  const top: TableIR[] = [];
  const groups = new Map<string, TableIR[]>();
  for (const t of tables) {
    if (!t.schema || t.schema === "public") top.push(t);
    else (groups.get(t.schema) ?? groups.set(t.schema, []).get(t.schema)!).push(t);
  }

  const lines: string[] = [];
  for (const t of top.sort(byQualified)) {
    lines.push(`  ${idKey(t.name)}: ${tableBody(t, "  ")},`);
  }
  for (const schema of [...groups.keys()].sort()) {
    const inner = groups
      .get(schema)!
      .sort(byQualified)
      .map((t) => `    ${idKey(t.name)}: ${tableBody(t, "    ")},`)
      .join("\n");
    lines.push(`  ${idKey(schema)}: {\n${inner}\n  },`);
  }
  return `export const schema = {\n${lines.join("\n")}\n};\n`;
}

function schemaBlock(tables: TableIR[]): string {
  return schemaObject(tables);
}

/** Render a full DatabaseIR into a single schema.ts source string. */
export function printSchema(ir: DatabaseIR): string {
  return (
    `// Generated by \`agnes pull\`. Edit and re-run \`agnes push\` to apply changes.\n` +
    HEADER +
    `\n` +
    schemaBlock(Object.values(ir))
  );
}

export interface SchemaFile {
  /** Bare file name without extension, e.g. "public", "auth". */
  name: string;
  source: string;
}

/**
 * Render a DatabaseIR into one file per DB schema plus an `index` that
 * re-exports every file's tables merged into a single `schema` object.
 */
export function printSchemaFiles(ir: DatabaseIR): { files: SchemaFile[]; index: string } {
  const bySchema = new Map<string, TableIR[]>();
  for (const t of Object.values(ir)) {
    const key = t.schema ?? "public";
    (bySchema.get(key) ?? bySchema.set(key, []).get(key)!).push(t);
  }

  const names = [...bySchema.keys()].sort();
  const files: SchemaFile[] = names.map((name) => ({
    name,
    source:
      `// Generated by \`agnes pull\`. Schema "${name}".\n` +
      HEADER +
      `\n` +
      schemaBlock(bySchema.get(name)!),
  }));

  // Alias with a "Schema" suffix so reserved words (e.g. "public") stay valid bindings.
  const alias = (n: string) => `${idKey(n)}Schema`;
  const imports = names
    .map((n) => `import { schema as ${alias(n)} } from ${JSON.stringify(`./${n}`)};`)
    .join("\n");
  const spread = names.map((n) => `  ...${alias(n)},`).join("\n");
  const index =
    `// Generated by \`agnes pull\`. Merges every per-schema file into one \`schema\`.\n` +
    `${imports}\n\nexport const schema = {\n${spread}\n};\n`;

  return { files, index };
}
