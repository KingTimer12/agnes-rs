import type { ColumnIR, DatabaseIR, ForeignKeyIR, IndexIR, TableIR } from "./ir";

// A single schema-change operation. `destructive` ops delete data or objects
// and require confirmation before execution.
export type Operation =
  | { kind: "createTable"; table: TableIR }
  | { kind: "dropTable"; table: string; destructive: true }
  | { kind: "addColumn"; table: string; column: ColumnIR }
  | { kind: "dropColumn"; table: string; column: string; destructive: true }
  | { kind: "alterColumn"; table: string; from: ColumnIR; to: ColumnIR }
  | { kind: "createIndex"; table: string; index: IndexIR }
  | { kind: "dropIndex"; table: string; index: string }
  | { kind: "addForeignKey"; table: string; fk: ForeignKeyIR }
  | { kind: "dropForeignKey"; table: string; fk: string };

export function isDestructive(op: Operation): boolean {
  return op.kind === "dropTable" || op.kind === "dropColumn";
}

function byName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.name, i]));
}

function columnChanged(a: ColumnIR, b: ColumnIR): boolean {
  return (
    a.type !== b.type ||
    a.nullable !== b.nullable ||
    a.primary !== b.primary ||
    !!a.autoincrement !== !!b.autoincrement
  );
}

/**
 * Diff `desired` (from schema.ts) against `current` (from the DB).
 * Returns ordered operations: creates first, then column/index/fk changes,
 * then drops last (so dependents go before the tables they reference).
 */
export function diffSchemas(desired: DatabaseIR, current: DatabaseIR): Operation[] {
  const creates: Operation[] = [];
  const alters: Operation[] = [];
  const drops: Operation[] = [];

  // Tables present in desired.
  for (const tableName in desired) {
    const want = desired[tableName]!;
    const have = current[tableName];

    if (!have) {
      creates.push({ kind: "createTable", table: want });
      continue;
    }

    const wantCols = byName(want.columns);
    const haveCols = byName(have.columns);

    for (const [name, col] of wantCols) {
      const existing = haveCols.get(name);
      if (!existing) alters.push({ kind: "addColumn", table: tableName, column: col });
      else if (columnChanged(existing, col))
        alters.push({ kind: "alterColumn", table: tableName, from: existing, to: col });
    }
    for (const [name] of haveCols) {
      if (!wantCols.has(name))
        drops.push({ kind: "dropColumn", table: tableName, column: name, destructive: true });
    }

    // Indexes.
    const wantIdx = byName(want.indexes);
    const haveIdx = byName(have.indexes);
    for (const [name, idx] of wantIdx) {
      const existing = haveIdx.get(name);
      if (!existing) alters.push({ kind: "createIndex", table: tableName, index: idx });
      else if (existing.unique !== idx.unique || existing.columns.join() !== idx.columns.join()) {
        alters.push({ kind: "dropIndex", table: tableName, index: name });
        alters.push({ kind: "createIndex", table: tableName, index: idx });
      }
    }
    for (const [name] of haveIdx) {
      if (!wantIdx.has(name)) alters.push({ kind: "dropIndex", table: tableName, index: name });
    }

    // Foreign keys.
    const wantFk = byName(want.foreignKeys);
    const haveFk = byName(have.foreignKeys);
    for (const [name, fk] of wantFk) {
      if (!haveFk.has(name)) alters.push({ kind: "addForeignKey", table: tableName, fk });
    }
    for (const [name] of haveFk) {
      if (!wantFk.has(name)) alters.push({ kind: "dropForeignKey", table: tableName, fk: name });
    }
  }

  // Tables present only in the DB → drop (full sync).
  for (const tableName in current) {
    if (!desired[tableName]) drops.push({ kind: "dropTable", table: tableName, destructive: true });
  }

  // Order creates so referenced tables come first; drops in the reverse order
  // (dependents before the tables they reference) to respect FK constraints.
  const createOrder = topoSort(desired);
  creates.sort((a, b) => {
    const an = a.kind === "createTable" ? a.table.name : "";
    const bn = b.kind === "createTable" ? b.table.name : "";
    return (createOrder.get(an) ?? 0) - (createOrder.get(bn) ?? 0);
  });
  const dropOrder = topoSort(current);
  drops.sort((a, b) => {
    const an = a.kind === "dropTable" ? a.table : "";
    const bn = b.kind === "dropTable" ? b.table : "";
    return (dropOrder.get(bn) ?? 0) - (dropOrder.get(an) ?? 0);
  });

  return [...creates, ...alters, ...drops];
}

/** Assign each table a rank so that a table always ranks after tables it references. */
function topoSort(ir: DatabaseIR): Map<string, number> {
  const rank = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (name: string): number => {
    if (rank.has(name)) return rank.get(name)!;
    if (visiting.has(name)) return 0; // cycle guard
    visiting.add(name);
    let r = 0;
    for (const fk of ir[name]?.foreignKeys ?? []) {
      if (fk.refTable !== name && ir[fk.refTable]) r = Math.max(r, visit(fk.refTable) + 1);
    }
    visiting.delete(name);
    rank.set(name, r);
    return r;
  };

  for (const name in ir) visit(name);
  return rank;
}
