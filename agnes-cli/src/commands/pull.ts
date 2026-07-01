import { join, resolve } from "node:path";
import type { AgnesConfig } from "../config";
import { openDb } from "../db";
import { introspect } from "../introspect";
import { printSchema, printSchemaFiles } from "../print";
import { c, confirm } from "../prompt";

export interface PullArgs {
  out?: string;
  yes?: boolean;
}

/** Introspect the database and (re)generate schema.ts to mirror it. */
export async function pull(config: AgnesConfig, args: PullArgs): Promise<void> {
  console.log(c.cyan(`agnes pull ← ${config.driver}`));
  const db = await openDb(config);

  const schemas = config.schemas?.length ? config.schemas : ["public"];
  if (config.driver === "postgres" && schemas.length > 1) {
    console.log(c.dim(`  schemas: ${schemas.join(", ")}`));
  }

  const current = await introspect(db, config.driver, schemas);
  const tableCount = Object.keys(current).length;
  console.log(c.green(`\n✓ Introspected ${tableCount} table(s).`));

  const multifile = config.pullMode === "multifile";
  if (multifile) {
    await writeMultifile(config, args, current);
  } else {
    await writeSinglefile(config, args, current);
  }
}

async function writeSinglefile(config: AgnesConfig, args: PullArgs, ir: import("../ir").DatabaseIR) {
  const outPath = resolve(process.cwd(), args.out ?? config.out ?? "schema.ts");
  const source = printSchema(ir);

  if ((await Bun.file(outPath).exists()) && !args.yes) {
    console.log(c.yellow(`\n⚠ ${outPath} already exists and will be overwritten.`));
    if (!(await confirm("Overwrite it?"))) {
      console.log(c.dim("Aborted. File left unchanged."));
      return;
    }
  }

  await Bun.write(outPath, source);
  console.log(c.green(`✓ Wrote ${outPath}`));
}

async function writeMultifile(config: AgnesConfig, args: PullArgs, ir: import("../ir").DatabaseIR) {
  // In multifile mode `out` names a directory (default ./schema).
  const dir = resolve(process.cwd(), args.out ?? config.out ?? "schema");
  const { files, index } = printSchemaFiles(ir);
  const targets = [
    ...files.map((f) => ({ path: join(dir, `${f.name}.ts`), source: f.source })),
    { path: join(dir, "index.ts"), source: index },
  ];

  const existing = (await Promise.all(targets.map((t) => Bun.file(t.path).exists()))).some(Boolean);
  if (existing && !args.yes) {
    console.log(c.yellow(`\n⚠ Files under ${dir} already exist and will be overwritten.`));
    if (!(await confirm("Overwrite them?"))) {
      console.log(c.dim("Aborted. Files left unchanged."));
      return;
    }
  }

  for (const t of targets) await Bun.write(t.path, t.source);
  console.log(c.green(`✓ Wrote ${files.length} schema file(s) + index → ${dir}`));
  console.log(c.dim(`  point config.schemaPath / config.out at ${join(dir, "index.ts")}`));
}
