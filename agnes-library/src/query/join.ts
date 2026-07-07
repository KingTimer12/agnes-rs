// For single-query SQL JOINs returning flat rows. Use `on(col1, col2)` to specify the ON clause.

import type { Column } from "../schema";
import type { JoinType } from "./builder";

export interface SqlJoinClause {
  type: JoinType;
  table: string;
  leftCol: string;
  rightCol: string;
}

/** Specifies an equi-join condition: left column (main table) = right column (joined table). */
export function on(
  mainTableCol: Column<unknown, boolean>,
  joinedTableCol: Column<unknown, boolean>,
): readonly [Column<unknown, boolean>, Column<unknown, boolean>] {
  return [mainTableCol, joinedTableCol];
}
