import type { QueryRunner } from "../../bridge";
import type { Schema, TableDef, TableEntry } from "../../schema";
import type { Dialect } from "../builder";
import { SelectBuilder } from "./select";

/**
 * Intermediate returned by `db.select(...fields)` / `db.select()` — you must
 * call `.from(table)` to pick the table. Field names passed to `select(...)`
 * become the projection (empty = every column). Pair with `.omit(...)` on the
 * resulting builder to drop columns instead of listing them all.
 *
 * ```ts
 * db.select().from("user").all();               // all columns
 * db.select("name", "email").from("user").all(); // only these
 * db.select().from("user").omit("password").all();
 * ```
 */
export class SelectStart<S extends Schema, Sel extends string = never> {
  constructor(
    private readonly db: QueryRunner,
    private readonly dialect: Dialect,
    private readonly schema: S,
    private readonly fields: string[],
  ) {}

  from<K extends keyof S & string>(
    table: K,
  ): SelectBuilder<S[K] extends TableEntry<infer D> ? D : never, S, Record<never, never>, Record<never, never>, Sel> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new SelectBuilder(
      this.db,
      entry.tableName,
      entry.def,
      this.dialect,
      this.schema,
      this.fields,
    ) as unknown as SelectBuilder<
      S[K] extends TableEntry<infer D> ? D : never,
      S,
      Record<never, never>,
      Record<never, never>,
      Sel
    >;
  }
}
