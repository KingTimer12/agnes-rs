// Configures how a nested relation is fetched (subquery approach: 2 queries + in-memory merge).
// Use `.type("inner")` to exclude parents with no matching children.

import type { Column } from "../schema";
import type { Condition } from "./builder";

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
