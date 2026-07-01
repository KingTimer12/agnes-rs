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
}

export class Column<TOut, TNullable extends boolean = false> {
  readonly _kind = "column" as const;
  readonly _phantomOut!: TOut;
  readonly _phantomNullable!: TNullable;

  constructor(
    public readonly name: string,
    public readonly type: ColumnType,
    public readonly flags: ColumnFlags = {},
  ) {}

  primary(): Column<TOut, TNullable> {
    return new Column(this.name, this.type, { ...this.flags, primary: true });
  }

  nullable(): Column<TOut, true> {
    return new Column(this.name, this.type, { ...this.flags, nullable: true });
  }

  default(v: TOut): Column<TOut, TNullable> {
    return new Column(this.name, this.type, { ...this.flags, default: v });
  }

  /** Mark the column as auto-incrementing (its value is assigned by the DB). */
  autoincrement(): Column<TOut, TNullable> {
    return new Column(this.name, this.type, { ...this.flags, autoincrement: true });
  }

  index(name: string): Column<TOut, TNullable> {
    return new Column(this.name, this.type, { ...this.flags, index: { name, unique: false } });
  }

  uniqueIndex(name: string): Column<TOut, TNullable> {
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

export type Schema = Record<string, TableEntry<TableDef>>;

// ─── Column helpers ───────────────────────────────────────────────────────────

export const int = (name: string) => new Column<number>(name, "int");
export const bigint = (name: string) => new Column<bigint>(name, "bigint");
export const text = (name: string) => new Column<string>(name, "text");
export const bool = (name: string) => new Column<boolean>(name, "bool");
export const float = (name: string) => new Column<number>(name, "float");
export const bytes = (name: string) => new Column<Uint8Array>(name, "bytes");
export const json = <T = unknown>(name: string) => new Column<T>(name, "json");

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

export function relationsOf(
  def: TableDef,
): (ManyRelation<string, string> | OneRelation<string, string, string>)[] {
  return Object.values(def).filter(
    (f): f is ManyRelation<string, string> | OneRelation<string, string, string> =>
      f._kind === "many" || f._kind === "one",
  );
}
