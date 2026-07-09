import type { QueryRunner } from "../../bridge";
import type { Column, InferInsert, InferRow, TableDef } from "../../schema";
import type { ConflictMode, Dialect } from "../builder";
import { ident, maxVars, placeholder, returningClause } from "../utils";

export class InsertBuilder<T extends TableDef, R = number> {
  private _conflictCols?: string[];
  private _mode: ConflictMode = "none";
  private _mergeCols?: string[];
  private _returning?: string[] | "*";

  constructor(
    private readonly db: QueryRunner,
    private readonly tableName: string,
    private readonly def: T,
    private readonly dialect: Dialect,
  ) {}

  /**
   * Conflict target columns (Postgres/SQLite `ON CONFLICT (...)`). MySQL ignores
   * the target and uses its unique keys automatically. Pair with `.merge()` or
   * `.ignore()`.
   */
  onConflict(...cols: Column<unknown, boolean>[]): this {
    this._conflictCols = cols.map((c) => c.name);
    return this;
  }

  /** On conflict, skip the row (`DO NOTHING` / `INSERT IGNORE`). */
  ignore(): this {
    this._mode = "ignore";
    return this;
  }

  /**
   * On conflict, update the row (upsert). With no args, updates every inserted
   * column except the conflict target; otherwise only the given columns.
   */
  merge(...cols: Column<unknown, boolean>[]): this {
    this._mode = "merge";
    if (cols.length > 0) this._mergeCols = cols.map((c) => c.name);
    return this;
  }

  /**
   * Return the inserted rows instead of an affected-row count (Postgres/SQLite
   * `RETURNING`). No args returns every column; otherwise only the given ones.
   * After this, `.values()` resolves to the row array. Throws on MySQL.
   */
  returning(...cols: Column<unknown, boolean>[]): InsertBuilder<T, InferRow<T>[]> {
    this._returning = cols.length > 0 ? cols.map((c) => c.name) : "*";
    return this as unknown as InsertBuilder<T, InferRow<T>[]>;
  }

  private conflictClause(insertedCols: string[]): string {
    if (this._mode === "none") return "";
    const d = this.dialect;
    const conflictSet = new Set(this._conflictCols ?? []);
    const updateCols = this._mergeCols ?? insertedCols.filter((c) => !conflictSet.has(c));

    if (d === "mysql") {
      if (this._mode === "ignore") return ""; // handled by the INSERT IGNORE prefix
      const sets = updateCols.map((c) => `${ident(d, c)} = VALUES(${ident(d, c)})`);
      return ` ON DUPLICATE KEY UPDATE ${sets.join(", ")}`;
    }

    // postgres / sqlite
    const target = this._conflictCols?.length
      ? ` (${this._conflictCols.map((c) => ident(d, c)).join(", ")})`
      : "";
    if (this._mode === "ignore") return ` ON CONFLICT${target} DO NOTHING`;
    const sets = updateCols.map((c) => `${ident(d, c)} = EXCLUDED.${ident(d, c)}`);
    return ` ON CONFLICT${target} DO UPDATE SET ${sets.join(", ")}`;
  }

  private buildStatement(chunk: Record<string, unknown>[], colKeys: string[]): {
    sql: string;
    params: unknown[];
  } {
    const d = this.dialect;
    const def = this.def as Record<string, { _kind: string; name: string }>;
    const physCols = colKeys.map((k) => def[k]?.name ?? k);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const phs = colKeys.map((k) => {
        params.push(row[k] ?? null);
        return placeholder(d, params.length);
      });
      return `(${phs.join(", ")})`;
    });
    const keyword = d === "mysql" && this._mode === "ignore" ? "INSERT IGNORE INTO" : "INSERT INTO";
    let sql =
      `${keyword} ${ident(d, this.tableName)} ` +
      `(${physCols.map((c) => ident(d, c)).join(", ")}) VALUES ${tuples.join(", ")}`;
    sql += this.conflictClause(physCols);
    sql += returningClause(d, this._returning);
    return { sql, params };
  }

  /**
   * Insert one row or many. Multi-row inserts go in a single statement, split
   * into chunks that respect the driver's bound-parameter limit. Chunks are
   * separate statements — wrap in `db.transaction` for all-or-nothing. Returns
   * the total affected-row count.
   */
  /** Column keys carrying a client-side `.default(fn)` generator. */
  private defaultFns(): { key: string; fn: () => unknown }[] {
    const out: { key: string; fn: () => unknown }[] = [];
    for (const key in this.def) {
      const f = this.def[key] as Column<unknown, boolean> | undefined;
      if (f?._kind === "column" && f.flags.defaultFn) out.push({ key, fn: f.flags.defaultFn });
    }
    return out;
  }

  async values(rowOrRows: InferInsert<T> | InferInsert<T>[]): Promise<R> {
    const input = (Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]) as Record<string, unknown>[];
    if (input.length === 0) return (this._returning ? [] : 0) as R;

    // Fill client-side defaults per row where the key is absent (undefined). An
    // explicit null is respected. Clone so the caller's objects aren't mutated.
    const gens = this.defaultFns();
    const rows = gens.length
      ? input.map((row) => {
          const copy = { ...row };
          for (const { key, fn } of gens) if (copy[key] === undefined) copy[key] = fn();
          return copy;
        })
      : input;

    // Union of keys across rows, preserving first-seen order. Missing keys in a
    // given row insert as NULL so every tuple has the same arity.
    const colKeys: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) {
          seen.add(k);
          colKeys.push(k);
        }
      }
    }
    if (colKeys.length === 0) return (this._returning ? [] : 0) as R;

    const rowsPerChunk = Math.max(1, Math.floor(maxVars(this.dialect) / colKeys.length));

    if (this._returning) {
      const out: unknown[] = [];
      for (let i = 0; i < rows.length; i += rowsPerChunk) {
        const { sql, params } = this.buildStatement(rows.slice(i, i + rowsPerChunk), colKeys);
        out.push(...((await this.db.query(sql, params)) as unknown[]));
      }
      return out as R;
    }

    let affected = 0;
    for (let i = 0; i < rows.length; i += rowsPerChunk) {
      const chunk = rows.slice(i, i + rowsPerChunk);
      const { sql, params } = this.buildStatement(chunk, colKeys);
      affected += await this.db.mutate(sql, params);
    }
    return affected as R;
  }
}
