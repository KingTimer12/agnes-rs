import {
  connectRust,
  type DatabaseConfig,
  type QueryOpts,
  type QueryRunner,
  type RustDatabase,
} from "./bridge";
import {
  flattenSchema,
  type FlattenSchema,
  type NestedSchema,
  type Schema,
  type TableDef,
  type InferRow,
  type TableEntry,
} from "./schema";
import type { Dialect } from "./query/builder";
import { SelectBuilder, InsertBuilder, UpdateBuilder, DeleteBuilder } from "./query/builder";
import { generateSchemaDdl } from "./query/ddl";

/** Query surface shared by the client and a transaction — builds against any runner. */
class ClientBase<S extends Schema> {
  constructor(
    protected readonly runner: QueryRunner,
    protected readonly schema: S,
    protected readonly dialect: Dialect,
  ) {}

  select<K extends keyof S & string>(table: K): SelectBuilder<S[K] extends TableEntry<infer D> ? D : never, S> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new SelectBuilder(
      this.runner,
      entry.tableName,
      entry.def,
      this.dialect,
      this.schema,
    ) as unknown as SelectBuilder<S[K] extends TableEntry<infer D> ? D : never, S>;
  }

  insertInto<K extends keyof S & string>(table: K): InsertBuilder<S[K] extends TableEntry<infer D> ? D : never> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new InsertBuilder(this.runner, entry.tableName, entry.def, this.dialect) as unknown as InsertBuilder<S[K] extends TableEntry<infer D> ? D : never>;
  }

  update<K extends keyof S & string>(table: K, patch: Partial<InferRow<S[K] extends TableEntry<infer D> ? D : never>>): UpdateBuilder<S[K] extends TableEntry<infer D> ? D : never> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new UpdateBuilder(this.runner, entry.tableName, entry.def, patch, this.dialect) as unknown as UpdateBuilder<S[K] extends TableEntry<infer D> ? D : never>;
  }

  deleteFrom<K extends keyof S & string>(table: K): DeleteBuilder<S[K] extends TableEntry<infer D> ? D : never> {
    const entry = this.schema[table] as TableEntry<TableDef>;
    return new DeleteBuilder(this.runner, entry.tableName, entry.def, this.dialect) as unknown as DeleteBuilder<S[K] extends TableEntry<infer D> ? D : never>;
  }

  async query<T = unknown>(sql: string, params?: unknown[], opts?: QueryOpts): Promise<T[]> {
    return (await this.runner.query(sql, params, opts)) as T[];
  }

  async mutate(sql: string, params?: unknown[]): Promise<number> {
    return this.runner.mutate(sql, params);
  }
}

/** The transaction handle passed to `db.transaction(async (tx) => …)`. */
export class TransactionClient<S extends Schema> extends ClientBase<S> {}

export class AgnesClient<S extends Schema> extends ClientBase<S> {
  private constructor(
    private readonly rust: RustDatabase,
    schema: S,
    dialect: Dialect,
  ) {
    super(rust, schema, dialect);
  }

  static async create<I extends NestedSchema>(
    config: DatabaseConfig,
    schema: I,
  ): Promise<AgnesClient<FlattenSchema<I>>> {
    const rust = await connectRust(config);
    return new AgnesClient(rust, flattenSchema(schema) as FlattenSchema<I>, config.driver);
  }

  /**
   * The DDL statements that {@link pushSchema} would run, for inspection or a
   * migration file. All use `IF NOT EXISTS`.
   */
  schemaDdl(): string[] {
    return generateSchemaDdl(this.dialect, this.schema);
  }

  /**
   * Create every table and index in the schema that doesn't already exist
   * (idempotent "schema push"). Does not alter or drop existing objects. Runs
   * the statements sequentially, dependency-ordered so foreign-key targets
   * exist first.
   */
  async pushSchema(): Promise<void> {
    for (const sql of this.schemaDdl()) {
      await this.mutate(sql);
    }
  }

  /**
   * Run `fn` inside a transaction. Commits when it resolves; rolls back and
   * rethrows if it throws (Prisma-style interactive transaction).
   */
  async transaction<T>(fn: (tx: TransactionClient<S>) => Promise<T>): Promise<T> {
    const rustTx = await this.rust.beginTransaction();
    const tx = new TransactionClient(rustTx, this.schema, this.dialect);
    try {
      const result = await fn(tx);
      await rustTx.commit();
      return result;
    } catch (err) {
      await rustTx.rollback();
      throw err;
    }
  }
}

export type { Schema, TableDef, TableEntry, DatabaseConfig, QueryOpts };
