import { applyPlan } from "../apply";
import type { AgnesConfig } from "../config";
import { openDb } from "../db";
import { diffSchemas } from "../diff";
import { schemaToIR } from "../ir";
import { normalizeIR } from "../normalize";
import { introspect } from "../introspect";
import { c } from "../prompt";

export interface PushArgs {
  yes?: boolean;
  dryRun?: boolean;
}

/** Sync the database to match schema.ts (create/alter/drop). */
export async function push(config: AgnesConfig, args: PushArgs): Promise<void> {
  console.log(c.cyan(`agnes push → ${config.driver}`));
  const db = await openDb(config);

  const desired = normalizeIR(schemaToIR(config.schema), config.driver);
  const current = normalizeIR(await introspect(db, config.driver), config.driver);
  const ops = diffSchemas(desired, current);

  await applyPlan(db, config.driver, ops, args);
}
