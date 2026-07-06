import type {
  Column,
  TableDef,
  TableEntry,
  InferRow,
  InferInsert,
  Schema,
  ManyRelation,
  OneRelation,
  RelationKeys,
  ResolveIncludes,
} from "../schema";
import type { QueryOpts, QueryRunner } from "../bridge";

type Dialect = "postgres" | "mysql" | "sqlite";

function placeholder(dialect: Dialect, n: number): string {
  return dialect === "postgres" ? `$${n}` : "?";
}

function ident(dialect: Dialect, name: string): string {
  const q = (p: string) => (dialect === "mysql" ? `\`${p}\`` : `"${p}"`);
  // Qualified table refs ("IBGE.tabela") quote each part separately.
  return name.includes(".") ? name.split(".").map(q).join(".") : q(name);
}

export type WhereOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "like" | "in";

export interface Condition {
  col: string;
  op: WhereOp;
  value: unknown;
}

export function eq<T>(col: Column<T, boolean>, value: T): Condition {
  return { col: col.name, op: "=", value };
}
export function neq<T>(col: Column<T, boolean>, value: T): Condition {
  return { col: col.name, op: "!=", value };
}
export function gt<T>(col: Column<T, boolean>, value: T): Condition {
  return { col: col.name, op: ">", value };
}
export function gte<T>(col: Column<T, boolean>, value: T): Condition {
  return { col: col.name, op: ">=", value };
}
export function lt<T>(col: Column<T, boolean>, value: T): Condition {
  return { col: col.name, op: "<", value };
}
export function lte<T>(col: Column<T, boolean>, value: T): Condition {
  return { col: col.name, op: "<=", value };
}
export function like(col: Column<string, boolean>, value: string): Condition {
  return { col: col.name, op: "like", value };
}

function buildWhere(dialect: Dialect, conds: Condition[], params: unknown[]): string {
  if (conds.length === 0) return "";
  const parts = conds.map((c) => {
    params.push(c.value);
    return `${ident(dialect, c.col)} ${c.op} ${placeholder(dialect, params.length)}`;
  });
  return ` WHERE ${parts.join(" AND ")}`;
}

// ─── RelationQuery ────────────────────────────────────────────────────────────
// Configures how a nested relation is fetched (subquery approach: 2 queries + in-memory merge).
// Use `.type("inner")` to exclude parents with no matching children.

export class RelationQuery {
  _joinType: "left" | "inner" = "left";
  _conds: Condition[] = [];
  _orderByCol?: string;
  _orderDir: "asc" | "desc" = "asc";
  _limitN?: number;
  _selectColNames?: string[];

  /** "left" = keep parent even if no children (default). "inner" = drop parent if no children. */
  type(t: "left" | "inner"): this {
    this._joinType = t;
    return this;
  }

  where(...cs: Condition[]): this {
    this._conds.push(...cs);
    return this;
  }

  orderBy(col: Column<unknown, boolean>, dir: "asc" | "desc" = "asc"): this {
    this._orderByCol = col.name;
    this._orderDir = dir;
    return this;
  }

  limit(n: number): this {
    this._limitN = n;
    return this;
  }

  /** Select only specific columns from the related table. */
  select(...cols: Column<unknown, boolean>[]): this {
    this._selectColNames = cols.map((c) => c.name);
    return this;
  }
}

/** Creates a RelationQuery for use inside `.include({ rel: query()... })`. */
export function query(): RelationQuery {
  return new RelationQuery();
}

export type IncludeValue = true | RelationQuery;
export type IncludeShape<T extends TableDef> = Partial<Record<RelationKeys<T>, IncludeValue>>;

// ─── SQL JOIN support ─────────────────────────────────────────────────────────
// For single-query SQL JOINs returning flat rows. Use `on(col1, col2)` to specify the ON clause.

export type JoinType = "left" | "inner" | "right" | "full";

interface SqlJoinClause {
  type: JoinType;
  table: string;
  leftCol: string;
  rightCol: string;
}

/** Specifies an equi-join condition: left column (main table) = right column (joined table). */
export function on(
  mainTableCol: Column<unknown, boolean>,
  joinedTableCol: Column<unknown, boolean>,
): readonly [Column<unknown, boolean>, Column<unknown, boolean>] {
  return [mainTableCol, joinedTableCol];
}

// ─── SelectBuilder ────────────────────────────────────────────────────────────

export class SelectBuilder<
  T extends TableDef,
  S extends Schema,
  Inc extends IncludeShape<T> = Record<never, never>,
> {
  private conds: Condition[] = [];
  private limitN?: number;
  private orderByCol?: string;
  private orderDir: "asc" | "desc" = "asc";
  private opts: QueryOpts = {};
  private _includes: Partial<Record<string, IncludeValue>> = {};
  private _joins: SqlJoinClause[] = [];

  constructor(
    private readonly db: QueryRunner,
    private readonly tableName: string,
    private readonly def: T,
    private readonly dialect: Dialect,
    private readonly schema: S,
  ) {}

  where(...cs: Condition[]): this {
    this.conds.push(...cs);
    return this;
  }

  orderBy(col: Column<unknown, boolean>, dir: "asc" | "desc" = "asc"): this {
    this.orderByCol = col.name;
    this.orderDir = dir;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  ttl(secs: number): this {
    this.opts.ttl = secs;
    return this;
  }

  bypassCache(): this {
    this.opts.bypassCache = true;
    return this;
  }

  /**
   * Include related records as nested JSON.
   * Pass `true` for defaults or a `query()` builder for filtering/ordering/limiting the relation.
   * Uses a 2-query subquery approach (no N+1: one IN query per relation).
   */
  include<NewInc extends IncludeShape<T>>(rels: NewInc): SelectBuilder<T, S, Inc & NewInc> {
    Object.assign(this._includes, rels);
    return this as unknown as SelectBuilder<T, S, Inc & NewInc>;
  }

  /**
   * SQL LEFT JOIN — flat rows, all columns from both tables in result.
   * Use `on(mainCol, joinedCol)` to define the equi-join condition.
   */
  leftJoin<K extends keyof S & string>(
    table: K,
    condition: readonly [Column<unknown, boolean>, Column<unknown, boolean>],
  ): this {
    this._joins.push({ type: "left", table, leftCol: condition[0].name, rightCol: condition[1].name });
    return this;
  }

  /** SQL INNER JOIN — flat rows, only matching records from both tables. */
  innerJoin<K extends keyof S & string>(
    table: K,
    condition: readonly [Column<unknown, boolean>, Column<unknown, boolean>],
  ): this {
    this._joins.push({ type: "inner", table, leftCol: condition[0].name, rightCol: condition[1].name });
    return this;
  }

  /** SQL RIGHT JOIN — flat rows, all records from joined table. */
  rightJoin<K extends keyof S & string>(
    table: K,
    condition: readonly [Column<unknown, boolean>, Column<unknown, boolean>],
  ): this {
    this._joins.push({ type: "right", table, leftCol: condition[0].name, rightCol: condition[1].name });
    return this;
  }

  /** SQL FULL OUTER JOIN — flat rows, all records from both tables. */
  fullJoin<K extends keyof S & string>(
    table: K,
    condition: readonly [Column<unknown, boolean>, Column<unknown, boolean>],
  ): this {
    this._joins.push({ type: "full", table, leftCol: condition[0].name, rightCol: condition[1].name });
    return this;
  }

  build(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    let sql = `SELECT * FROM ${ident(this.dialect, this.tableName)}`;

    for (const j of this._joins) {
      const keyword = j.type === "full" ? "FULL OUTER" : j.type.toUpperCase();
      const joinTableName = (this.schema[j.table] as TableEntry<TableDef> | undefined)?.tableName ?? j.table;
      sql += ` ${keyword} JOIN ${ident(this.dialect, joinTableName)}`;
      sql += ` ON ${ident(this.dialect, this.tableName)}.${ident(this.dialect, j.leftCol)}`;
      sql += ` = ${ident(this.dialect, joinTableName)}.${ident(this.dialect, j.rightCol)}`;
    }

    sql += buildWhere(this.dialect, this.conds, params);
    if (this.orderByCol) {
      sql += ` ORDER BY ${ident(this.dialect, this.orderByCol)} ${this.orderDir.toUpperCase()}`;
    }
    if (this.limitN !== undefined) {
      sql += ` LIMIT ${this.limitN}`;
    }
    return { sql, params };
  }

  async all(): Promise<(InferRow<T> & ResolveIncludes<T, S, Inc>)[]> {
    const { sql, params } = this.build();
    let rows = (await this.db.query(sql, params, this.opts)) as Record<string, unknown>[];
    rows = await this._resolveIncludes(rows);
    return rows as unknown as (InferRow<T> & ResolveIncludes<T, S, Inc>)[];
  }

  async first(): Promise<(InferRow<T> & ResolveIncludes<T, S, Inc>) | null> {
    this.limit(1);
    const rows = await this.all();
    return rows[0] ?? null;
  }

  // ─── Include resolution ───────────────────────────────────────────────────

  private async _resolveIncludes(
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const active = Object.entries(this._includes).filter(([, v]) => v != null);
    if (rows.length === 0 || active.length === 0) return rows;

    const parentPkEntry = Object.entries(this.def).find(
      ([, v]) => v._kind === "column" && (v as Column<unknown, boolean>).flags.primary,
    );
    const parentPkColName = parentPkEntry
      ? (parentPkEntry[1] as Column<unknown, boolean>).name
      : "id";

    let result = rows;
    for (const [relTsKey, incVal] of active) {
      const relDef = this.def[relTsKey];
      if (!relDef) continue;
      const rq = incVal === true ? new RelationQuery() : (incVal as RelationQuery);

      if (relDef._kind === "many") {
        result = await this._resolveManyRelation(
          result,
          relTsKey,
          relDef as ManyRelation<string, string>,
          parentPkColName,
          rq,
        );
      } else if (relDef._kind === "one") {
        result = await this._resolveOneRelation(
          result,
          relTsKey,
          relDef as OneRelation<string, string, string>,
          rq,
        );
      }
    }
    return result;
  }

  private async _resolveManyRelation(
    rows: Record<string, unknown>[],
    relTsKey: string,
    rel: ManyRelation<string, string>,
    parentPkColName: string,
    rq: RelationQuery,
  ): Promise<Record<string, unknown>[]> {
    const targetEntry = this.schema[rel.target] as TableEntry<TableDef> | undefined;
    if (!targetEntry) return rows;
    const targetDef = targetEntry.def;
    const targetTableName = targetEntry.tableName;

    const fkField = targetDef[rel.foreignKey] as Column<unknown, boolean> | undefined;
    if (!fkField) return rows;
    const fkColName = fkField.name;

    const parentIds = [...new Set(rows.map((r) => r[parentPkColName]))].filter((v) => v != null);

    if (parentIds.length === 0) {
      if (rq._joinType === "inner") return [];
      return rows.map((r) => ({ ...r, [relTsKey]: [] }));
    }

    const params: unknown[] = [...parentIds];
    const ph = parentIds.map((_, i) => placeholder(this.dialect, i + 1)).join(", ");

    // fkColName must always be present so we can group children by parent after fetch.
    // When the user called .select(), ensure fkColName is included.
    const selectList = rq._selectColNames
      ? [...new Set([...rq._selectColNames, fkColName])].map((c) => ident(this.dialect, c)).join(", ")
      : "*";

    // Build WHERE clause: FK IN (...) + extra conditions from RelationQuery
    let baseWhere = `${ident(this.dialect, fkColName)} IN (${ph})`;
    for (const cond of rq._conds) {
      params.push(cond.value);
      baseWhere += ` AND ${ident(this.dialect, cond.col)} ${cond.op} ${placeholder(this.dialect, params.length)}`;
    }

    let sql: string;

    if (rq._limitN !== undefined) {
      // Per-parent limit via ROW_NUMBER() OVER (PARTITION BY fkCol ORDER BY ...)
      // This is supported on SQLite ≥ 3.25 (2018), MySQL 8+, PostgreSQL all versions.
      const orderInWindow = rq._orderByCol
        ? `ORDER BY ${ident(this.dialect, rq._orderByCol)} ${rq._orderDir.toUpperCase()}`
        : "";
      const innerSql =
        `SELECT ${selectList}, ROW_NUMBER() OVER ` +
        `(PARTITION BY ${ident(this.dialect, fkColName)} ${orderInWindow}) AS _agnes_rn ` +
        `FROM ${ident(this.dialect, targetTableName)} WHERE ${baseWhere}`;
      sql = `SELECT * FROM (${innerSql}) WHERE _agnes_rn <= ${rq._limitN}`;
    } else {
      sql = `SELECT ${selectList} FROM ${ident(this.dialect, targetTableName)} WHERE ${baseWhere}`;
      if (rq._orderByCol) {
        sql += ` ORDER BY ${ident(this.dialect, rq._orderByCol)} ${rq._orderDir.toUpperCase()}`;
      }
    }

    const childRows = (await this.db.query(sql, params, {})) as Record<string, unknown>[];

    // Remove internal window-function column
    if (rq._limitN !== undefined) {
      for (const row of childRows) delete row["_agnes_rn"];
    }

    const grouped = new Map<unknown, Record<string, unknown>[]>();
    for (const child of childRows) {
      const fkVal = child[fkColName];
      if (!grouped.has(fkVal)) grouped.set(fkVal, []);
      grouped.get(fkVal)!.push(child);
    }

    return rows
      .map((row) => ({ ...row, [relTsKey]: grouped.get(row[parentPkColName]) ?? [] }))
      .filter((row) =>
        rq._joinType === "inner" ? (row[relTsKey] as unknown[]).length > 0 : true,
      );
  }

  private async _resolveOneRelation(
    rows: Record<string, unknown>[],
    relTsKey: string,
    rel: OneRelation<string, string, string>,
    rq: RelationQuery,
  ): Promise<Record<string, unknown>[]> {
    const localField = this.def[rel.localKey] as Column<unknown, boolean> | undefined;
    if (!localField) return rows;
    const localColName = localField.name;

    const targetEntry = this.schema[rel.target] as TableEntry<TableDef> | undefined;
    if (!targetEntry) return rows;
    const targetDef = targetEntry.def;
    const targetTableName = targetEntry.tableName;

    const targetField = targetDef[rel.targetKey] as Column<unknown, boolean> | undefined;
    if (!targetField) return rows;
    const targetColName = targetField.name;

    const fkValues = [...new Set(rows.map((r) => r[localColName]))].filter((v) => v != null);

    if (fkValues.length === 0) {
      if (rq._joinType === "inner") return [];
      return rows.map((r) => ({ ...r, [relTsKey]: null }));
    }

    const params: unknown[] = [...fkValues];
    const ph = fkValues.map((_, i) => placeholder(this.dialect, i + 1)).join(", ");
    const selectList = rq._selectColNames
      ? rq._selectColNames.map((c) => ident(this.dialect, c)).join(", ")
      : "*";

    let sql = `SELECT ${selectList} FROM ${ident(this.dialect, targetTableName)}`;
    sql += ` WHERE ${ident(this.dialect, targetColName)} IN (${ph})`;

    for (const cond of rq._conds) {
      params.push(cond.value);
      sql += ` AND ${ident(this.dialect, cond.col)} ${cond.op} ${placeholder(this.dialect, params.length)}`;
    }
    if (rq._orderByCol) {
      sql += ` ORDER BY ${ident(this.dialect, rq._orderByCol)} ${rq._orderDir.toUpperCase()}`;
    }

    const targetRows = (await this.db.query(sql, params, {})) as Record<string, unknown>[];

    const targetMap = new Map<unknown, Record<string, unknown>>();
    for (const tr of targetRows) targetMap.set(tr[targetColName], tr);

    return rows
      .map((row) => ({ ...row, [relTsKey]: targetMap.get(row[localColName]) ?? null }))
      .filter((row) => (rq._joinType === "inner" ? row[relTsKey] !== null : true));
  }
}

// ─── InsertBuilder ────────────────────────────────────────────────────────────

export class InsertBuilder<T extends TableDef> {
  constructor(
    private readonly db: QueryRunner,
    private readonly tableName: string,
    private readonly def: T,
    private readonly dialect: Dialect,
  ) {}

  async values(row: InferInsert<T>): Promise<number> {
    const rec = row as Record<string, unknown>;
    const def = this.def as Record<string, { _kind: string; name: string }>;
    const entries = Object.keys(rec).map((k) => ({ col: def[k]?.name ?? k, val: rec[k] }));
    const params = entries.map((e) => e.val);
    const placeholders = entries.map((_, i) => placeholder(this.dialect, i + 1));
    const sql =
      `INSERT INTO ${ident(this.dialect, this.tableName)} ` +
      `(${entries.map((e) => ident(this.dialect, e.col)).join(", ")}) ` +
      `VALUES (${placeholders.join(", ")})`;
    return this.db.mutate(sql, params);
  }
}

// ─── UpdateBuilder ────────────────────────────────────────────────────────────

export class UpdateBuilder<T extends TableDef> {
  private conds: Condition[] = [];

  constructor(
    private readonly db: QueryRunner,
    private readonly tableName: string,
    private readonly def: T,
    private readonly patch: Partial<InferRow<T>>,
    private readonly dialect: Dialect,
  ) {}

  where(...cs: Condition[]): this {
    this.conds.push(...cs);
    return this;
  }

  async run(): Promise<number> {
    const params: unknown[] = [];
    const def = this.def as Record<string, { _kind: string; name: string }>;
    const setParts = Object.entries(this.patch as Record<string, unknown>).map(([k, v]) => {
      params.push(v);
      const colName = def[k]?.name ?? k;
      return `${ident(this.dialect, colName)} = ${placeholder(this.dialect, params.length)}`;
    });
    let sql = `UPDATE ${ident(this.dialect, this.tableName)} SET ${setParts.join(", ")}`;
    sql += buildWhere(this.dialect, this.conds, params);
    return this.db.mutate(sql, params);
  }
}

// ─── DeleteBuilder ────────────────────────────────────────────────────────────

export class DeleteBuilder<T extends TableDef> {
  private conds: Condition[] = [];

  constructor(
    private readonly db: QueryRunner,
    private readonly tableName: string,
    private readonly def: T,
    private readonly dialect: Dialect,
  ) {}

  where(...cs: Condition[]): this {
    this.conds.push(...cs);
    return this;
  }

  async run(): Promise<number> {
    const params: unknown[] = [];
    let sql = `DELETE FROM ${ident(this.dialect, this.tableName)}`;
    sql += buildWhere(this.dialect, this.conds, params);
    return this.db.mutate(sql, params);
  }
}

export type { Dialect };
