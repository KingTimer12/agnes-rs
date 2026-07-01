// Dialect-agnostic intermediate representation of a database schema.
// Both the TS schema DSL and live-DB introspection are normalized into
// DatabaseIR so push/pull/migrate can diff them structurally.

export type ColumnType = "int" | "bigint" | "text" | "bool" | "float" | "bytes" | "json";

export interface ColumnIR {
  name: string;
  type: ColumnType;
  nullable: boolean;
  primary: boolean;
  /** default value as a literal; undefined = no default. */
  default?: unknown;
}

export interface IndexIR {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeyIR {
  /** Deterministic name so diff is stable. */
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
}

export interface TableIR {
  name: string;
  columns: ColumnIR[];
  indexes: IndexIR[];
  foreignKeys: ForeignKeyIR[];
}

/** Keyed by physical table name. */
export type DatabaseIR = Record<string, TableIR>;

// ─── Structural view of the schema DSL ──────────────────────────────────────
// We treat the schema object duck-typed (via `_kind`) so the CLI never has to
// share a compiled build with agnes-library — only the shape matters.

interface DslColumn {
  _kind: "column";
  name: string;
  type: ColumnType;
  flags: {
    primary?: boolean;
    nullable?: boolean;
    default?: unknown;
    index?: { name: string; unique: boolean };
  };
}

interface DslOneRelation {
  _kind: "one";
  target: string;
  localKey: string;
  targetKey: string;
  onUpdate: string;
  onDelete: string;
}

interface DslManyRelation {
  _kind: "many";
  target: string;
  foreignKey: string;
}

type DslField = DslColumn | DslOneRelation | DslManyRelation;

interface DslTableEntry {
  def: Record<string, DslField>;
  tableName: string;
}

export type DslSchema = Record<string, DslTableEntry>;

function fkName(table: string, column: string): string {
  return `fk_${table}_${column}`;
}

/** Resolve the physical column name of a DSL key inside a table def. */
function colName(def: Record<string, DslField>, key: string): string | undefined {
  const f = def[key];
  return f && f._kind === "column" ? f.name : undefined;
}

/** Convert the user's schema DSL into the canonical DatabaseIR. */
export function schemaToIR(schema: DslSchema): DatabaseIR {
  // Map DSL table key → physical name for relation resolution.
  const physicalName = new Map<string, string>();
  for (const key in schema) physicalName.set(key, schema[key]!.tableName);

  const ir: DatabaseIR = {};

  for (const key in schema) {
    const entry = schema[key]!;
    const def = entry.def;
    const columns: ColumnIR[] = [];
    const indexes: IndexIR[] = [];
    const foreignKeys: ForeignKeyIR[] = [];

    for (const fieldKey in def) {
      const field = def[fieldKey]!;
      if (field._kind === "column") {
        columns.push({
          name: field.name,
          type: field.type,
          nullable: field.flags.nullable ?? false,
          primary: field.flags.primary ?? false,
          default: field.flags.default,
        });
        if (field.flags.index) {
          indexes.push({
            name: field.flags.index.name,
            columns: [field.name],
            unique: field.flags.index.unique,
          });
        }
      } else if (field._kind === "one") {
        const localCol = colName(def, field.localKey);
        const targetDef = schema[field.target]?.def;
        const refCol = targetDef ? colName(targetDef, field.targetKey) : undefined;
        const refTable = physicalName.get(field.target);
        if (localCol && refCol && refTable) {
          foreignKeys.push({
            name: fkName(entry.tableName, localCol),
            column: localCol,
            refTable,
            refColumn: refCol,
            onUpdate: field.onUpdate,
            onDelete: field.onDelete,
          });
        }
      }
      // `many` relations have no physical footprint — the FK lives on the target side.
    }

    ir[entry.tableName] = { name: entry.tableName, columns, indexes, foreignKeys };
  }

  return ir;
}
