import type { QueryRunner } from "../../bridge";
import type { Column, InferRow, TableDef } from "../../schema";
import { softDeleteName } from "../../schema";
import type { Condition, Dialect } from "../builder";
import { buildWhere } from "../conditions";
import { ident, returningClause } from "../utils";

export class DeleteBuilder<T extends TableDef, R = number> {
  private conds: Condition[] = [];
  private _returning?: string[] | "*";
  private _hard = false;

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

  /**
   * Force a real `DELETE` even when the table declares a `.softDelete()` marker.
   * No-op for tables without one.
   */
  hardDelete(): this {
    this._hard = true;
    return this;
  }

  async run(): Promise<R> {
    const params: unknown[] = [];
    const marker = this._hard ? undefined : softDeleteName(this.def);
    const table = ident(this.dialect, this.tableName);
    // Soft delete: stamp the marker instead of removing the row. Only touch
    // rows not already deleted so the affected-count reflects real changes.
    let sql = marker
      ? `UPDATE ${table} SET ${ident(this.dialect, marker)} = CURRENT_TIMESTAMP`
      : `DELETE FROM ${table}`;
    sql += buildWhere(this.dialect, this.conds, params);
    if (marker) {
      const pred = `${ident(this.dialect, marker)} IS NULL`;
      sql += this.conds.length ? ` AND ${pred}` : ` WHERE ${pred}`;
    }
    sql += returningClause(this.dialect, this._returning);
    if (this._returning) return (await this.db.query(sql, params)) as R;
    return (await this.db.mutate(sql, params)) as R;
  }
}
