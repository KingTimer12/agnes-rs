import { resolve } from "node:path";
import { c, confirm } from "../prompt";

export interface InitArgs {
  /** Target config path (default: agnes.config.ts). */
  out?: string;
  yes?: boolean;
}

const TEMPLATE = `import { defineConfig } from "agnes-cli";
import { schema } from "./schema";

export default defineConfig({
  // Target database dialect: "postgres" | "mysql" | "sqlite".
  driver: "postgres",

  // Connection URL. Keep credentials in your .env — see urlEnv below.
  url: process.env.DATABASE_URL!,

  // The schema object exported from your schema.ts.
  schema,

  // ── pull / push ──────────────────────────────────────────────────────────
  // PostgreSQL schemas to introspect. "public" is the default; add more to
  // pull/push tables that live outside it (they get qualified names, "auth.users").
  schemas: ["public"],

  // How \`agnes pull\` lays out the generated schema:
  //   "singlefile" — every table in one file (config.out, default ./schema.ts)
  //   "multifile"  — one file per DB schema + an index re-exporting them merged
  //                  (config.out is then a directory, default ./schema)
  pullMode: "singlefile",
  out: "./schema.ts",

  // Directory for versioned migration files.
  migrationsDir: "./migrations",

  // ── generate ──────────────────────────────────────────────────────────────
  // Env var holding the URL. When set, \`agnes generate\` emits
  // process.env[urlEnv] in the client so no credentials land in the output file.
  urlEnv: "DATABASE_URL",

  // Where \`agnes generate\` writes the pre-wired AgnesClient module (.ts or .js).
  output: "./src/db.ts",

  // Cache baked into the generated client.
  cache: { enabled: false },
});
`;

/** Scaffold an agnes.config.ts in the current directory. */
export async function init(args: InitArgs): Promise<void> {
  const outRel = args.out ?? "agnes.config.ts";
  const outPath = resolve(process.cwd(), outRel);

  if ((await Bun.file(outPath).exists()) && !args.yes) {
    console.log(c.yellow(`⚠ ${outPath} already exists and will be overwritten.`));
    if (!(await confirm("Overwrite it?"))) {
      console.log(c.dim("Aborted. File left unchanged."));
      return;
    }
  }

  await Bun.write(outPath, TEMPLATE);
  console.log(c.green(`✓ Created ${outPath}`));
  console.log(c.dim(`  Edit driver/url, then run \`agnes pull\` to generate schema.ts.`));
}
