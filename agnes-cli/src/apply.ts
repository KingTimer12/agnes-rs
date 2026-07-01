import type { Dialect } from "./dialect";
import type { CliDb } from "./db";
import { isDestructive, type Operation } from "./diff";
import { describeOperation, renderPlan } from "./generate";
import { c, confirm } from "./prompt";

export interface ApplyOpts {
  yes?: boolean;
  dryRun?: boolean;
}

/**
 * Print the diff plan, confirm destructive operations, then execute the SQL.
 * Returns the SQL statements that were (or would be) run.
 */
export async function applyPlan(
  db: CliDb,
  dialect: Dialect,
  ops: Operation[],
  opts: ApplyOpts = {},
): Promise<string[]> {
  if (ops.length === 0) {
    console.log(c.green("✓ Database is up to date. Nothing to apply."));
    return [];
  }

  console.log(c.bold("\nPlan:"));
  for (const op of ops) {
    const line = describeOperation(op);
    console.log("  " + (isDestructive(op) ? c.red(line) : c.green(line)));
  }

  const statements = renderPlan(dialect, ops);

  if (opts.dryRun) {
    console.log(c.bold("\nSQL (dry run):"));
    for (const s of statements) console.log(c.dim(s));
    return statements;
  }

  const destructive = ops.filter(isDestructive);
  if (destructive.length > 0 && !opts.yes) {
    console.log(
      c.yellow(`\n⚠ ${destructive.length} destructive operation(s) will delete data or objects.`),
    );
    const ok = await confirm("Apply these changes?");
    if (!ok) {
      console.log(c.dim("Aborted. No changes made."));
      return [];
    }
  }

  console.log(c.bold("\nApplying..."));
  for (const sql of statements) {
    if (sql.startsWith("--")) {
      console.log(c.yellow("  " + sql));
      continue;
    }
    await db.mutate(sql);
    console.log(c.dim("  ✓ " + sql.split("\n")[0]));
  }
  console.log(c.green(`\n✓ Applied ${statements.filter((s) => !s.startsWith("--")).length} statement(s).`));
  return statements;
}
