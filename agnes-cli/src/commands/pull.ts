import { resolve } from "node:path";
import type { AgnesConfig } from "../config";
import { openDb } from "../db";
import { introspect } from "../introspect";
import { printSchema } from "../print";
import { c, confirm } from "../prompt";

export interface PullArgs {
  out?: string;
  yes?: boolean;
}

/** Introspect the database and (re)generate schema.ts to mirror it. */
export async function pull(config: AgnesConfig, args: PullArgs): Promise<void> {
  console.log(c.cyan(`agnes pull ← ${config.driver}`));
  const db = await openDb(config);

  const current = await introspect(db, config.driver);
  const tableCount = Object.keys(current).length;
  const source = printSchema(current);

  const outPath = resolve(process.cwd(), args.out ?? config.out ?? "schema.ts");
  const exists = await Bun.file(outPath).exists();

  console.log(c.green(`\n✓ Introspected ${tableCount} table(s).`));

  if (exists && !args.yes) {
    console.log(c.yellow(`\n⚠ ${outPath} already exists and will be overwritten.`));
    const ok = await confirm("Overwrite it?");
    if (!ok) {
      console.log(c.dim("Aborted. File left unchanged."));
      return;
    }
  }

  await Bun.write(outPath, source);
  console.log(c.green(`✓ Wrote ${outPath}`));
}
