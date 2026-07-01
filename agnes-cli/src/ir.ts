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
  /** DB assigns the value (serial/identity/AUTO_INCREMENT). Mutually exclusive with `default`. */
  autoincrement?: boolean;
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
  /** Physical table name (unqualified). */
  name: string;
  /** Owning DB schema. `undefined`/"public" = default schema. */
  schema?: string;
  columns: ColumnIR[];
  indexes: IndexIR[];
  foreignKeys: ForeignKeyIR[];
}

/** Keyed by qualified name (see {@link qualifiedName}). */
export type DatabaseIR = Record<string, TableIR>;

/** IR key / physical reference: `table` in the default schema, else `schema.table`. */
export function qualifiedName(name: string, schema?: string): string {
  return !schema || schema === "public" ? name : `${schema}.${name}`;
}

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
    autoincrement?: boolean;
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

/** Entries may sit at the top level or be grouped one level deep by DB schema. */
export type DslSchema = Record<string, DslTableEntry | Record<string, DslTableEntry>>;

function fkName(table: string, column: string): string {
  return `fk_${table}_${column}`;
}

/** Resolve the physical column name of a DSL key inside a table def. */
function colName(def: Record<string, DslField>, key: string): string | undefined {
  const f = def[key];
  return f && f._kind === "column" ? f.name : undefined;
}

function isTableEntry(v: unknown): v is DslTableEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as DslTableEntry).tableName === "string" &&
    typeof (v as DslTableEntry).def === "object"
  );
}

/** Flatten nested groups; pair each entry with its path key ("grp.tbl" or "tbl"). */
function flattenDsl(schema: DslSchema): { key: string; entry: DslTableEntry }[] {
  const out: { key: string; entry: DslTableEntry }[] = [];
  for (const k in schema) {
    const v = schema[k];
    if (isTableEntry(v)) {
      out.push({ key: k, entry: v });
    } else if (v && typeof v === "object") {
      for (const p in v as Record<string, DslTableEntry>) {
        const e = (v as Record<string, DslTableEntry>)[p];
        if (isTableEntry(e)) out.push({ key: `${k}.${p}`, entry: e });
      }
    }
  }
  return out;
}

/** Convert the user's schema DSL into the canonical DatabaseIR. */
export function schemaToIR(schema: DslSchema): DatabaseIR {
  const entries = flattenDsl(schema);

  // A relation target may reference either the TS path key or the physical
  // table name — index by both so both hand-written and pulled schemas resolve.
  const byRef = new Map<string, DslTableEntry>();
  for (const { key, entry } of entries) {
    byRef.set(key, entry);
    byRef.set(entry.tableName, entry);
  }

  const ir: DatabaseIR = {};

  for (const { entry } of entries) {
    const def = entry.def;
    const columns: ColumnIR[] = [];
    const indexes: IndexIR[] = [];
    const foreignKeys: ForeignKeyIR[] = [];

    for (const fieldKey in def) {
      const field = def[fieldKey]!;
      if (field._kind === "column") {
        const autoincrement = field.flags.autoincrement ?? false;
        columns.push({
          name: field.name,
          type: field.type,
          nullable: field.flags.nullable ?? false,
          primary: field.flags.primary ?? false,
          // Auto-increment supplies the value; never emit an explicit default too.
          default: autoincrement ? undefined : field.flags.default,
          autoincrement,
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
        const targetEntry = byRef.get(field.target);
        const refCol = targetEntry ? colName(targetEntry.def, field.targetKey) : undefined;
        const refTable = targetEntry?.tableName;
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

    // A dotted physical name ("auth.users") carries an explicit schema.
    const dot = entry.tableName.indexOf(".");
    const tblSchema = dot === -1 ? undefined : entry.tableName.slice(0, dot);
    const bare = dot === -1 ? entry.tableName : entry.tableName.slice(dot + 1);
    ir[qualifiedName(bare, tblSchema)] = {
      name: bare,
      schema: tblSchema,
      columns,
      indexes,
      foreignKeys,
    };
  }

  return ir;
}
