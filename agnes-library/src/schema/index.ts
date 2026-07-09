export type ColumnType = "int" | "bigint" | "text" | "bool" | "float" | "bytes" | "json";

export interface IndexDef {
  name: string;
  unique: boolean;
}

export interface ColumnFlags {
  primary?: boolean;
  nullable?: boolean;
  default?: unknown;
  /** Auto-incrementing column (Postgres serial/identity, MySQL AUTO_INCREMENT, SQLite AUTOINCREMENT). */
  autoincrement?: boolean;
  index?: IndexDef;
  /** Soft-delete marker: when set, deletes become `SET <col> = now` and reads filter `<col> IS NULL`. */
  softDelete?: boolean;
}

export class Column<TOut, TNullable extends boolean = false, TName extends string = string> {
  readonly _kind = "column" as const;
  readonly _phantomOut!: TOut;
  readonly _phantomNullable!: TNullable;

  constructor(
    public readonly name: TName,
    public readonly type: ColumnType,
    public readonly flags: ColumnFlags = {},
  ) {}

  primary(): Column<TOut, TNullable, TName> {
    return new Column(this.name, this.type, { ...this.flags, primary: true });
  }

  nullable(): Column<TOut, true, TName> {
    return new Column(this.name, this.type, { ...this.flags, nullable: true });
  }

  default(v: TOut): Column<TOut, TNullable, TName> {
    return new Column(this.name, this.type, { ...this.flags, default: v });
  }

  /** Mark the column as auto-incrementing (its value is assigned by the DB). */
  autoincrement(): Column<TOut, TNullable, TName> {
    return new Column(this.name, this.type, { ...this.flags, autoincrement: true });
  }

  index(name: string): Column<TOut, TNullable, TName> {
    return new Column(this.name, this.type, { ...this.flags, index: { name, unique: false } });
  }

  /**
   * Mark this column as the table's soft-delete marker. Deletes become an
   * `UPDATE` that stamps it (`.hardDelete()` forces a real `DELETE`); reads
   * auto-filter `<col> IS NULL` (`.withDeleted()` opts out). Implies nullable —
   * a null marker means "not deleted". Use a nullable timestamp/text column.
   */
  softDelete(): Column<TOut, true, TName> {
    return new Column(this.name, this.type, { ...this.flags, softDelete: true, nullable: true });
  }

  uniqueIndex(name: string): Column<TOut, TNullable, TName> {
    return new Column(this.name, this.type, { ...this.flags, index: { name, unique: true } });
  }
}

// ─── Relations ────────────────────────────────────────────────────────────────

export enum OnAction {
  None = "NO ACTION",
  Restrict = "RESTRICT",
  Cascade = "CASCADE",
  SetNull = "SET NULL",
  SetDefault = "SET DEFAULT",
}

export class ManyRelation<TTarget extends string, TFk extends string> {
  readonly _kind = "many" as const;
  constructor(
    public readonly target: TTarget,
    /** TS key in the target table that holds the FK pointing back to this table */
    public readonly foreignKey: TFk,
  ) {}
}

export class OneRelation<TTarget extends string, TLocalKey extends string, TTargetKey extends string> {
  readonly _kind = "one" as const;
  constructor(
    public readonly target: TTarget,
    /** TS key in THIS table that is the FK column */
    public readonly localKey: TLocalKey,
    /** TS key in the target table that is the referenced column (usually PK) */
    public readonly targetKey: TTargetKey,
    public readonly onUpdate: OnAction,
    public readonly onDelete: OnAction,
  ) {}
}

export function many<TTarget extends string, TFk extends string>(
  target: TTarget,
  foreignKey: TFk,
): ManyRelation<TTarget, TFk> {
  return new ManyRelation(target, foreignKey);
}

export function one<TTarget extends string, TLocal extends string, TTargetKey extends string>(
  target: TTarget,
  localKey: TLocal,
  targetKey: TTargetKey,
  onUpdate: OnAction = OnAction.None,
  onDelete: OnAction = OnAction.None,
): OneRelation<TTarget, TLocal, TTargetKey> {
  return new OneRelation(target, localKey, targetKey, onUpdate, onDelete);
}

// ─── Schema field types ───────────────────────────────────────────────────────

export type SchemaField =
  | Column<unknown, boolean>
  | ManyRelation<string, string>
  | OneRelation<string, string, string>;

export type TableDef = Record<string, SchemaField>;

export class TableEntry<T extends TableDef> {
  constructor(
    public readonly def: T,
    public readonly tableName: string,
  ) { }

  public toCol(): ColFields<T> {
    return columnsOf(this.def)
  }
}

export function table<T extends TableDef>(def: T, tableName: string): TableEntry<T> {
  return new TableEntry(def, tableName);
}

/** Flat schema: table key → entry. Relation targets reference these keys. */
export type Schema = Record<string, TableEntry<TableDef>>;

/**
 * What the user may pass to `AgnesClient.create` / `defineConfig`: entries may
 * sit at the top level (`users`) or be grouped one level deep by DB schema
 * (`legislativo: { etapas }`). Grouped entries flatten to dotted keys
 * (`legislativo.etapas`) that match their physical name and relation targets.
 */
export type NestedSchema = Record<string, TableEntry<TableDef> | Record<string, TableEntry<TableDef>>>;

export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never;

/** TS value type of a single column, widened to `| null` when nullable. */
export type ColValue<C> = C extends Column<infer O, infer Nu, string>
  ? Nu extends true
    ? O | null
    : O
  : never;

/**
 * Map a tuple of column handles (as passed to `.groupBy(...)`) to a record
 * keyed by each column's **physical** name with its inferred value type.
 */
export type GroupColumns<C extends readonly Column<unknown, boolean, string>[]> = UnionToIntersection<
  {
    [I in keyof C]: C[I] extends Column<unknown, boolean, infer Nm>
      ? { [P in Nm]: ColValue<C[I]> }
      : never;
  }[number]
> & {};

/** Type-level flatten of a NestedSchema into a flat {@link Schema}. */
export type FlattenSchema<S> = UnionToIntersection<
  {
    [K in keyof S]: S[K] extends TableEntry<TableDef>
      ? Record<K & string, S[K]>
      : S[K] extends Record<string, TableEntry<TableDef>>
        ? { [P in keyof S[K] as `${K & string}.${P & string}`]: S[K][P] }
        : never;
  }[keyof S]
> & {};

/** Runtime counterpart of {@link FlattenSchema}: collapse groups to dotted keys. */
export function flattenSchema(schema: NestedSchema): Schema {
  const out: Record<string, TableEntry<TableDef>> = {};
  for (const k in schema) {
    const v = schema[k];
    if (v instanceof TableEntry) {
      out[k] = v;
    } else if (v) {
      for (const p in v) {
        const entry = (v as Record<string, TableEntry<TableDef>>)[p];
        if (entry) out[`${k}.${p}`] = entry;
      }
    }
  }
  return out;
}

// ─── Column helpers ───────────────────────────────────────────────────────────

export const int = <N extends string>(name: N) => new Column<number, false, N>(name, "int");
export const bigint = <N extends string>(name: N) => new Column<bigint, false, N>(name, "bigint");
export const text = <N extends string>(name: N) => new Column<string, false, N>(name, "text");
export const bool = <N extends string>(name: N) => new Column<boolean, false, N>(name, "bool");
export const float = <N extends string>(name: N) => new Column<number, false, N>(name, "float");
export const bytes = <N extends string>(name: N) => new Column<Uint8Array, false, N>(name, "bytes");
export const json = <T = unknown, N extends string = string>(name: N) => new Column<T, false, N>(name, "json");

// ─── Type inference ───────────────────────────────────────────────────────────

type ColFields<T extends TableDef> = {
  [K in keyof T as T[K] extends Column<unknown, boolean> ? K : never]: T[K];
};

export type InferRow<T extends TableDef> = {
  [K in keyof ColFields<T>]: ColFields<T>[K] extends Column<infer O, infer N>
    ? N extends true
      ? O | null
      : O
    : never;
};

export type InferInsert<T extends TableDef> = Partial<InferRow<T>>;
export type Columns<T extends TableDef> = ColFields<T>;

/**
 * Row shape after a `.select(...)` projection and/or `.omit(...)`:
 * - `Sel` empty (`never`) → every column, minus `Om`.
 * - `Sel` non-empty → only those columns, minus `Om`.
 */
export type ProjectRow<T extends TableDef, Sel extends string, Om extends string> =
  [Sel] extends [never]
    ? Omit<InferRow<T>, Om>
    : Omit<Pick<InferRow<T>, Extract<Sel, keyof InferRow<T>>>, Om>;

// ─── Relation key helpers ─────────────────────────────────────────────────────

export type RelationKeys<T extends TableDef> = {
  [K in keyof T]: T[K] extends ManyRelation<string, string> | OneRelation<string, string, string>
    ? K
    : never;
}[keyof T] &
  string;

/**
 * Resolve included relations into their output types.
 * Inc values can be `true` or a `RelationQuery` — both are non-falsy objects.
 */
export type ResolveIncludes<T extends TableDef, S extends Schema, Inc extends object> = {
  [K in keyof Inc & string & keyof T as Inc[K] extends false | null | undefined
    ? never
    : K]: T[K] extends ManyRelation<infer Tgt, string>
    ? Tgt extends keyof S
      ? InferRow<S[Tgt]["def"]>[]
      : never
    : T[K] extends OneRelation<infer Tgt, string, string>
      ? Tgt extends keyof S
        ? InferRow<S[Tgt]["def"]> | null
        : never
      : never;
};

// ─── Runtime helpers ──────────────────────────────────────────────────────────

export function columnsOf<T extends TableDef>(def: T): ColFields<T> {
  const out: Record<string, Column<unknown, boolean>> = {};
  for (const key in def) {
    if (def[key]?._kind === "column") {
      out[key] = def[key] as Column<unknown, boolean>;
    }
  }
  return out as ColFields<T>;
}

/** Physical name of the table's soft-delete marker column, if one is declared. */
export function softDeleteName(def: TableDef): string | undefined {
  for (const key in def) {
    const f = def[key];
    if (f?._kind === "column" && (f as Column<unknown, boolean>).flags.softDelete) {
      return (f as Column<unknown, boolean>).name;
    }
  }
  return undefined;
}

export function relationsOf(
  def: TableDef,
): (ManyRelation<string, string> | OneRelation<string, string, string>)[] {
  return Object.values(def).filter(
    (f): f is ManyRelation<string, string> | OneRelation<string, string, string> =>
      f._kind === "many" || f._kind === "one",
  );
}
