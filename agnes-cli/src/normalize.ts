import { logicalType, physicalType, type Dialect } from "./dialect";
import type { DatabaseIR } from "./ir";

/**
 * Project an IR into the lossy type space a given dialect actually stores, so a
 * schema round-trips cleanly against introspection. Without this, e.g. SQLite
 * (which stores `bool`/`bigint` as `integer`) would report a spurious diff on
 * every `push`. Also enforces PK ⇒ NOT NULL on both sides.
 */
export function normalizeIR(ir: DatabaseIR, dialect: Dialect): DatabaseIR {
  const out: DatabaseIR = {};
  for (const name in ir) {
    const t = ir[name]!;
    out[name] = {
      ...t,
      columns: t.columns.map((c) => ({
        ...c,
        type: logicalType(physicalType(dialect, c.type)),
        nullable: c.primary ? false : c.nullable,
      })),
    };
  }
  return out;
}
