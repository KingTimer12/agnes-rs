import type { QueryOpts, QueryRunner } from "../../bridge";
import type { Column, Columns, GroupColumns, ManyRelation, OneRelation, ProjectRow, ResolveIncludes, Schema, TableDef, TableEntry } from "../../schema";
import { softDeleteName } from "../../schema";
import { renderAgg, type Aggregate, type HavingClause } from "../aggregate";
import type { AggregateRow, Condition, Dialect, IncludeShape, IncludeValue, WhereOp } from "../builder";
import { buildWhere, renderCondition } from "../conditions";
import type { SqlJoinClause } from "../join";
import { RelationQuery } from "../relations";
import { ident, placeholder } from "../utils";

export class SelectBuilder<
  T extends TableDef,
  S extends Schema,
  Inc extends IncludeShape<T> = Record<never, never>,
  G = Record<never, never>,
  Sel extends string = never,
  Om extends string = never,
> {
  private conds: Condition[] = [];
  private limitN?: number;
  private offsetN?: number;
  private orderByCol?: string;
  private orderDir: "asc" | "desc" = "asc";
  private opts: QueryOpts = {};
  private _includes: Partial<Record<string, IncludeValue>> = {};
  private _joins: SqlJoinClause[] = [];
  private _groupBy: string[] = [];
  private _having: HavingClause[] = [];
  /** TS column keys to project (empty = all). Set by `db.select(...fields).from()`. */
  private _selectKeys: string[];
  /** TS column keys to exclude. Set by `.omit(...)`. */
  private _omitKeys: string[] = [];
  /** Include soft-deleted rows (skip the `<marker> IS NULL` filter). */
  private _withDeleted = false;

  constructor(
    private readonly db: QueryRunner,
    private readonly tableName: string,
    private readonly def: T,
    private readonly dialect: Dialect,
    private readonly schema: S,
    selectKeys: string[] = [],
  ) {
    this._selectKeys = [...selectKeys];
  }

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

  /** Skip the first `n` rows (pair with `.limit()` / `.orderBy()`). */
  offset(n: number): this {
    this.offsetN = n;
    return this;
  }

  /**
   * Page through results: `page` is 1-based, `perPage` rows each. Sets both
   * `limit` and `offset`. Use with `.orderBy()` for stable ordering.
   *
   * ```ts
   * db.select("user").orderBy(u.id).page(3, 20).all(); // rows 41–60
   * ```
   */
  page(page: number, perPage: number): this {
    const p = Math.max(1, Math.floor(page));
    this.limitN = perPage;
    this.offsetN = (p - 1) * perPage;
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
   * Read-your-writes: run this read on the write **master**, skipping replicas,
   * so replica lag can't return stale data just after a write. No-op without
   * `replicas` configured.
   */
  freshRead(): this {
    this.opts.readPrimary = true;
    return this;
  }

  /**
   * Include related records as nested JSON.
   * Pass `true` for defaults or a `query()` builder for filtering/ordering/limiting the relation.
   * Uses a 2-query subquery approach (no N+1: one IN query per relation).
   */
  include<NewInc extends IncludeShape<T>>(rels: NewInc): SelectBuilder<T, S, Inc & NewInc, G, Sel, Om> {
    Object.assign(this._includes, rels);
    return this as unknown as SelectBuilder<T, S, Inc & NewInc, G, Sel, Om>;
  }

  /**
   * Exclude columns from the result — returns everything **except** these,
   * so you don't have to list every column just to drop one (e.g. a password).
   * Typed against the table's columns; combines with a `.select(...)` projection.
   *
   * ```ts
   * db.select().from("user").omit("password").all();
   * ```
   */
  omit<O extends keyof Columns<T> & string>(
    ...cols: O[]
  ): SelectBuilder<T, S, Inc, G, Sel, Om | O> {
    this._omitKeys.push(...cols);
    return this as unknown as SelectBuilder<T, S, Inc, G, Sel, Om | O>;
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

  /**
   * Group aggregate results by these columns (used with `.aggregate()`).
   * The grouped columns flow into the `.aggregate()` result type, keyed by
   * their physical column name.
   */
  groupBy<C extends Column<unknown, boolean, string>[]>(
    ...cols: C
  ): SelectBuilder<T, S, Inc, G & GroupColumns<C>> {
    this._groupBy.push(...cols.map((c) => c.name));
    return this as unknown as SelectBuilder<T, S, Inc, G & GroupColumns<C>>;
  }

  /** Filter grouped rows by an aggregate, e.g. `.having(sum(o.total), ">", 100)`. */
  having(agg: Aggregate, op: WhereOp, value: unknown): this {
    this._having.push({ agg, op, value });
    return this;
  }

  /**
   * Include soft-deleted rows in the result. No-op unless the table declares a
   * `.softDelete()` marker column.
   */
  withDeleted(): this {
    this._withDeleted = true;
    return this;
  }

  /**
   * WHERE clause including the soft-delete `<marker> IS NULL` filter (unless
   * `.withDeleted()` was called or the table has no marker). Appends to any
   * user conditions with `AND`, or emits a fresh `WHERE`.
   */
  private whereClause(params: unknown[]): string {
    let sql = buildWhere(this.dialect, this.conds, params);
    const marker = this._withDeleted ? undefined : softDeleteName(this.def);
    if (marker) {
      const pred = `${ident(this.dialect, this.tableName)}.${ident(this.dialect, marker)} IS NULL`;
      sql += sql ? ` AND ${pred}` : ` WHERE ${pred}`;
    }
    return sql;
  }

  private buildJoins(): string {
    let sql = "";
    for (const j of this._joins) {
      const keyword = j.type === "full" ? "FULL OUTER" : j.type.toUpperCase();
      const joinTableName = (this.schema[j.table] as TableEntry<TableDef> | undefined)?.tableName ?? j.table;
      sql += ` ${keyword} JOIN ${ident(this.dialect, joinTableName)}`;
      sql += ` ON ${ident(this.dialect, this.tableName)}.${ident(this.dialect, j.leftCol)}`;
      sql += ` = ${ident(this.dialect, joinTableName)}.${ident(this.dialect, j.rightCol)}`;
    }
    return sql;
  }

  /** All TS column keys declared on the table, in definition order. */
  private columnKeys(): string[] {
    return Object.keys(this.def).filter((k) => this.def[k]?._kind === "column");
  }

  /** Physical name for a TS column key (falls back to the key itself). */
  private physical(key: string): string {
    const col = this.def[key] as Column<unknown, boolean> | undefined;
    return col?.name ?? key;
  }

  /**
   * The SELECT column list: explicit projection from `.select(...)`, or all
   * columns minus `.omit(...)`, or `*` when neither is set. When relations are
   * included, the parent PK is force-added so children can be grouped.
   */
  private selectClause(): string {
    let keys: string[];
    if (this._selectKeys.length > 0) {
      keys = [...this._selectKeys];
    } else if (this._omitKeys.length > 0) {
      keys = this.columnKeys().filter((k) => !this._omitKeys.includes(k));
    } else {
      return "*";
    }
    if (Object.keys(this._includes).length > 0) {
      const pkKey = this.columnKeys().find(
        (k) => (this.def[k] as Column<unknown, boolean>).flags.primary,
      );
      if (pkKey && !keys.includes(pkKey)) keys.push(pkKey);
    }
    return keys.map((k) => ident(this.dialect, this.physical(k))).join(", ");
  }

  /**
   * `LIMIT`/`OFFSET` tail. `OFFSET` needs a `LIMIT` on MySQL and SQLite, so when
   * an offset is set without a limit we emit a dialect "all rows" sentinel.
   */
  private limitOffset(): string {
    const { limitN, offsetN, dialect } = this;
    if (limitN === undefined && offsetN === undefined) return "";
    if (offsetN === undefined) return ` LIMIT ${limitN}`;
    if (limitN !== undefined) return ` LIMIT ${limitN} OFFSET ${offsetN}`;
    // offset without limit
    switch (dialect) {
      case "postgres":
        return ` OFFSET ${offsetN}`;
      case "mysql":
        return ` LIMIT 18446744073709551615 OFFSET ${offsetN}`;
      default: // sqlite
        return ` LIMIT -1 OFFSET ${offsetN}`;
    }
  }

  build(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    let sql = `SELECT ${this.selectClause()} FROM ${ident(this.dialect, this.tableName)}`;
    sql += this.buildJoins();
    sql += this.whereClause(params);
    if (this.orderByCol) {
      sql += ` ORDER BY ${ident(this.dialect, this.orderByCol)} ${this.orderDir.toUpperCase()}`;
    }
    sql += this.limitOffset();
    return { sql, params };
  }

  /**
   * Run an aggregate query. Selects the grouped columns (from `.groupBy()`)
   * plus one column per alias in `aggs`. Honors `.where()`, `.having()`,
   * `.orderBy()` and `.limit()`.
   *
   * ```ts
   * await db.select("order")
   *   .where(gt(o.total, 0))
   *   .groupBy(o.userId)
   *   .having(sum(o.total), ">", 100)
   *   .aggregate({ spent: sum(o.total), orders: count() });
   * // → { user_id: number; spent: number | null; orders: number | null }[]
   * ```
   */
  async aggregate<A extends Record<string, Aggregate>>(aggs: A): Promise<(AggregateRow<A> & G)[]> {
    const params: unknown[] = [];
    const d = this.dialect;
    const selectParts = [
      ...this._groupBy.map((g) => ident(d, g)),
      ...Object.entries(aggs).map(([alias, a]) => `${renderAgg(d, a)} AS ${ident(d, alias)}`),
    ];
    let sql = `SELECT ${selectParts.join(", ")} FROM ${ident(d, this.tableName)}`;
    sql += this.buildJoins();
    sql += this.whereClause(params);
    if (this._groupBy.length > 0) {
      sql += ` GROUP BY ${this._groupBy.map((g) => ident(d, g)).join(", ")}`;
    }
    if (this._having.length > 0) {
      const parts = this._having.map((h) => {
        params.push(h.value);
        return `${renderAgg(d, h.agg)} ${h.op} ${placeholder(d, params.length)}`;
      });
      sql += ` HAVING ${parts.join(" AND ")}`;
    }
    if (this.orderByCol) {
      sql += ` ORDER BY ${ident(d, this.orderByCol)} ${this.orderDir.toUpperCase()}`;
    }
    sql += this.limitOffset();
    return (await this.db.query(sql, params, this.opts)) as (AggregateRow<A> & G)[];
  }

  async all(): Promise<(ProjectRow<T, Sel, Om> & ResolveIncludes<T, S, Inc>)[]> {
    const { sql, params } = this.build();
    let rows = (await this.db.query(sql, params, this.opts)) as Record<string, unknown>[];
    rows = await this._resolveIncludes(rows);
    return rows as unknown as (ProjectRow<T, Sel, Om> & ResolveIncludes<T, S, Inc>)[];
  }

  async first(): Promise<(ProjectRow<T, Sel, Om> & ResolveIncludes<T, S, Inc>) | null> {
    this.limit(1);
    const rows = await this.all();
    return rows[0] ?? null;
  }

  /**
   * Count matching rows — `SELECT COUNT(*)` honoring `.where()` and joins
   * (ignores projection, limit/offset and ordering).
   *
   * ```ts
   * const n = await db.select("user").where(gt(u.age, 18)).count();
   * ```
   */
  async count(): Promise<number> {
    const params: unknown[] = [];
    let sql = `SELECT COUNT(*) AS ${ident(this.dialect, "n")} FROM ${ident(this.dialect, this.tableName)}`;
    sql += this.buildJoins();
    sql += this.whereClause(params);
    const rows = (await this.db.query(sql, params, this.opts)) as Record<string, unknown>[];
    return Number(rows[0]?.["n"] ?? 0);
  }

  /** Whether any row matches — `SELECT 1 … LIMIT 1`, honoring `.where()`/joins. */
  async exists(): Promise<boolean> {
    const params: unknown[] = [];
    let sql = `SELECT 1 FROM ${ident(this.dialect, this.tableName)}`;
    sql += this.buildJoins();
    sql += this.whereClause(params);
    sql += " LIMIT 1";
    const rows = (await this.db.query(sql, params, this.opts)) as unknown[];
    return rows.length > 0;
  }

  /**
   * Stream the result row-by-row instead of buffering it all — for scanning
   * large tables without exhausting memory. The Rust core fetches in batches of
   * `batchSize` behind a bounded channel (server-side cursor on Postgres).
   *
   * ```ts
   * for await (const user of db.select("user").where(gt(u.age, 18)).stream()) {
   *   process(user);
   * }
   * ```
   *
   * Not available inside a transaction, and incompatible with `.include()`
   * (relations need the full result set). `.where()`/`.orderBy()`/joins work.
   */
  async *stream(batchSize = 500): AsyncGenerator<ProjectRow<T, Sel, Om>, void, unknown> {
    if (!this.db.stream) {
      throw new Error("streaming is only available on the database, not inside a transaction");
    }
    if (Object.keys(this._includes).length > 0) {
      throw new Error("cannot stream a query with .include(); relations need the full result set");
    }
    const { sql, params } = this.build();
    const handle = await this.db.stream(sql, params);
    for (;;) {
      const batch = (await handle.nextBatch(batchSize)) as ProjectRow<T, Sel, Om>[];
      if (batch.length === 0) break;
      for (const row of batch) yield row;
    }
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
      baseWhere += ` AND ${renderCondition(this.dialect, cond, params)}`;
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
      sql += ` AND ${renderCondition(this.dialect, cond, params)}`;
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
