import { connectRust, type DatabaseConfig, type QueryOpts, type RustDatabase } from "./bridge";
import type { Schema, TableDef, InferRow, TableEntry } from "./schema";
import type { Dialect } from "./query/builder";
import { SelectBuilder, InsertBuilder, UpdateBuilder, DeleteBuilder } from "./query/builder";

export class AgnesClient<S extends Schema> {
  private constructor(
    private readonly rust: RustDatabase,
    private readonly schema: S,
    private readonly dialect: Dialect,
  ) {}

  static async create<S extends Schema>(config: DatabaseConfig, schema: S): Promise<AgnesClient<S>> {
    const rust = await connectRust(config);
    return new AgnesClient(rust, schema, config.driver);
  }

  select<K extends keyof S & string>(table: K): SelectBuilder<S[K] extends TableEntry<infer D> ? D : never, S> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new SelectBuilder(
      this.rust,
      entry.tableName,
      entry.def,
      this.dialect,
      this.schema,
    ) as unknown as SelectBuilder<S[K] extends TableEntry<infer D> ? D : never, S>;
  }

  insertInto<K extends keyof S & string>(table: K): InsertBuilder<S[K] extends TableEntry<infer D> ? D : never> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new InsertBuilder(this.rust, entry.tableName, entry.def, this.dialect) as unknown as InsertBuilder<S[K] extends TableEntry<infer D> ? D : never>;
  }

  update<K extends keyof S & string>(table: K, patch: Partial<InferRow<S[K] extends TableEntry<infer D> ? D : never>>): UpdateBuilder<S[K] extends TableEntry<infer D> ? D : never> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new UpdateBuilder(this.rust, entry.tableName, entry.def, patch, this.dialect) as unknown as UpdateBuilder<S[K] extends TableEntry<infer D> ? D : never>;
  }

  deleteFrom<K extends keyof S & string>(table: K): DeleteBuilder<S[K] extends TableEntry<infer D> ? D : never> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new DeleteBuilder(this.rust, entry.tableName, entry.def, this.dialect) as unknown as DeleteBuilder<S[K] extends TableEntry<infer D> ? D : never>;
  }

  async query<T = unknown>(sql: string, params?: unknown[], opts?: QueryOpts): Promise<T[]> {
    return (await this.rust.query(sql, params, opts)) as T[];
  }

  async mutate(sql: string, params?: unknown[]): Promise<number> {
    return this.rust.mutate(sql, params);
  }
}

export type { Schema, TableDef, TableEntry, DatabaseConfig, QueryOpts };
