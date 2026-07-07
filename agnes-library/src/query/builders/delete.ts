import type { QueryRunner } from "../../bridge";
import type { Column, InferRow, TableDef } from "../../schema";
import type { Condition, Dialect } from "../builder";
import { buildWhere } from "../conditions";
import { ident, returningClause } from "../utils";

export class DeleteBuilder<T extends TableDef, R = number> {
  private conds: Condition[] = [];
  private _returning?: string[] | "*";

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

  /**
   * Return the deleted rows instead of an affected-row count (Postgres/SQLite
   * `RETURNING`). No args returns every column. Throws on MySQL.
   */
  returning(...cols: Column<unknown, boolean>[]): DeleteBuilder<T, InferRow<T>[]> {
    this._returning = cols.length > 0 ? cols.map((c) => c.name) : "*";
    return this as unknown as DeleteBuilder<T, InferRow<T>[]>;
  }

  async run(): Promise<R> {
    const params: unknown[] = [];
    let sql = `DELETE FROM ${ident(this.dialect, this.tableName)}`;
    sql += buildWhere(this.dialect, this.conds, params);
    sql += returningClause(this.dialect, this._returning);
    if (this._returning) return (await this.db.query(sql, params)) as R;
    return (await this.db.mutate(sql, params)) as R;
  }
}
