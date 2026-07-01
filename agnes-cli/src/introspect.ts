import { logicalType, type Dialect } from "./dialect";
import { qualifiedName, type ColumnIR, type DatabaseIR, type ForeignKeyIR, type IndexIR, type TableIR } from "./ir";

// Minimal DB surface the CLI needs — satisfied by AgnesClient.
export interface QueryClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? "" : String(v));
const truthy = (v: unknown): boolean =>
  v === true || v === 1 || v === "1" || v === "YES" || v === "t" || v === "true";

/** Tables the CLI manages internally and must never diff/drop. */
function isInternal(name: string): boolean {
  return name.startsWith("_agnes") || name.startsWith("sqlite_");
}

export async function introspect(
  db: QueryClient,
  dialect: Dialect,
  schemas?: string[],
): Promise<DatabaseIR> {
  switch (dialect) {
    case "postgres":
      return introspectPostgres(db, schemas && schemas.length ? schemas : ["public"]);
    case "mysql":
      return introspectMysql(db);
    case "sqlite":
      return introspectSqlite(db);
  }
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────

async function introspectPostgres(db: QueryClient, schemas: string[]): Promise<DatabaseIR> {
  const ir: DatabaseIR = {};

  for (const schema of schemas) {
    const tables = await db.query<Row>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [schema],
    );

    for (const tr of tables) {
      const name = str(tr.table_name);
      if (isInternal(name)) continue;

      const cols = await db.query<Row>(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, name],
      );
      const pks = await db.query<Row>(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $2 AND tc.table_schema = $1`,
        [schema, name],
      );
      const pkSet = new Set(pks.map((r) => str(r.column_name)));

      const columns: ColumnIR[] = cols.map((c) => {
        const rawDefault = c.column_default == null ? undefined : str(c.column_default);
        // serial/identity columns default to nextval(...) — surface them as autoincrement.
        const autoincrement = rawDefault != null && /nextval\(/i.test(rawDefault);
        return {
          name: str(c.column_name),
          type: logicalType(str(c.data_type)),
          nullable: str(c.is_nullable) === "YES",
          primary: pkSet.has(str(c.column_name)),
          default: autoincrement ? undefined : rawDefault,
          autoincrement,
        };
      });

      const idxRows = await db.query<Row>(
        `SELECT i.relname AS index_name, a.attname AS column_name,
                ix.indisunique AS is_unique, ix.indisprimary AS is_primary
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE t.relname = $2 AND n.nspname = $1 AND t.relkind = 'r'`,
        [schema, name],
      );
      const indexes = groupIndexes(
        idxRows
          .filter((r) => !truthy(r.is_primary))
          .map((r) => ({ index: str(r.index_name), column: str(r.column_name), unique: truthy(r.is_unique) })),
      );

      const fkRows = await db.query<Row>(
        `SELECT tc.constraint_name, kcu.column_name,
                ccu.table_schema AS foreign_schema, ccu.table_name AS foreign_table,
                ccu.column_name AS foreign_column, rc.update_rule, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $2 AND tc.table_schema = $1`,
        [schema, name],
      );
      const foreignKeys: ForeignKeyIR[] = fkRows.map((r) => ({
        name: str(r.constraint_name),
        column: str(r.column_name),
        refTable: qualifiedName(str(r.foreign_table), str(r.foreign_schema)),
        refColumn: str(r.foreign_column),
        onUpdate: str(r.update_rule).toUpperCase(),
        onDelete: str(r.delete_rule).toUpperCase(),
      }));

      const s = schema === "public" ? undefined : schema;
      ir[qualifiedName(name, s)] = { name, schema: s, columns, indexes, foreignKeys };
    }
  }
  return ir;
}

// ─── MySQL ──────────────────────────────────────────────────────────────────

async function introspectMysql(db: QueryClient): Promise<DatabaseIR> {
  const ir: DatabaseIR = {};
  const tables = await db.query<Row>(
    `SELECT table_name AS table_name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`,
  );

  for (const tr of tables) {
    const name = str(tr.table_name);
    if (isInternal(name)) continue;

    const cols = await db.query<Row>(
      `SELECT column_name, data_type, is_nullable, column_default, column_key
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?
       ORDER BY ordinal_position`,
      [name],
    );
    const columns: ColumnIR[] = cols.map((c) => ({
      name: str(c.column_name),
      type: logicalType(str(c.data_type)),
      nullable: str(c.is_nullable) === "YES",
      primary: str(c.column_key) === "PRI",
      default: c.column_default == null ? undefined : str(c.column_default),
    }));

    const idxRows = await db.query<Row>(
      `SELECT index_name, column_name, non_unique
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ?
       ORDER BY index_name, seq_in_index`,
      [name],
    );
    const indexes = groupIndexes(
      idxRows
        .filter((r) => str(r.index_name) !== "PRIMARY")
        .map((r) => ({ index: str(r.index_name), column: str(r.column_name), unique: !truthy(r.non_unique) })),
    );

    const fkRows = await db.query<Row>(
      `SELECT kcu.constraint_name, kcu.column_name,
              kcu.referenced_table_name AS foreign_table, kcu.referenced_column_name AS foreign_column,
              rc.update_rule, rc.delete_rule
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema
       WHERE kcu.table_schema = DATABASE() AND kcu.table_name = ?
         AND kcu.referenced_table_name IS NOT NULL`,
      [name],
    );
    const foreignKeys: ForeignKeyIR[] = fkRows.map((r) => ({
      name: str(r.constraint_name),
      column: str(r.column_name),
      refTable: str(r.foreign_table),
      refColumn: str(r.foreign_column),
      onUpdate: str(r.update_rule).toUpperCase(),
      onDelete: str(r.delete_rule).toUpperCase(),
    }));

    ir[name] = { name, columns, indexes, foreignKeys };
  }
  return ir;
}

// ─── SQLite ─────────────────────────────────────────────────────────────────

async function introspectSqlite(db: QueryClient): Promise<DatabaseIR> {
  const ir: DatabaseIR = {};
  const tables = await db.query<Row>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );

  for (const tr of tables) {
    const name = str(tr.name);
    if (isInternal(name)) continue;
    const q = (s: string) => name.replace(/'/g, "''"); // guard, name only

    const cols = await db.query<Row>(`PRAGMA table_info('${q(name)}')`);
    const columns: ColumnIR[] = cols.map((c) => ({
      name: str(c.name),
      type: logicalType(str(c.type)),
      nullable: !truthy(c.notnull),
      primary: truthy(c.pk),
      default: c.dflt_value == null ? undefined : str(c.dflt_value),
    }));

    const idxList = await db.query<Row>(`PRAGMA index_list('${q(name)}')`);
    const indexes: IndexIR[] = [];
    for (const idx of idxList) {
      // Only user-created indexes (origin "c"); skip implicit PK ("pk") and
      // UNIQUE-constraint ("u") auto-indexes, which can't be dropped directly.
      if (str(idx.origin) !== "c") continue;
      const idxName = str(idx.name);
      const info = await db.query<Row>(`PRAGMA index_info('${idxName.replace(/'/g, "''")}')`);
      indexes.push({
        name: idxName,
        columns: info.map((i) => str(i.name)),
        unique: truthy(idx.unique),
      });
    }

    const fkList = await db.query<Row>(`PRAGMA foreign_key_list('${q(name)}')`);
    const foreignKeys: ForeignKeyIR[] = fkList.map((f) => ({
      name: `fk_${name}_${str(f.from)}`,
      column: str(f.from),
      refTable: str(f.table),
      refColumn: str(f.to),
      onUpdate: str(f.on_update).toUpperCase() || "NO ACTION",
      onDelete: str(f.on_delete).toUpperCase() || "NO ACTION",
    }));

    ir[name] = { name, columns, indexes, foreignKeys };
  }
  return ir;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function groupIndexes(
  rows: { index: string; column: string; unique: boolean }[],
): IndexIR[] {
  const map = new Map<string, IndexIR>();
  for (const r of rows) {
    const existing = map.get(r.index);
    if (existing) existing.columns.push(r.column);
    else map.set(r.index, { name: r.index, columns: [r.column], unique: r.unique });
  }
  return [...map.values()];
}
