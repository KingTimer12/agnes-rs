import { loadConfig } from "./config";
import { init } from "./commands/init";
import { push } from "./commands/push";
import { pull } from "./commands/pull";
import { migrate } from "./commands/migrate";
import { generate } from "./commands/generate";
import { c } from "./prompt";

interface Flags {
  _: string[];
  config?: string;
  out?: string;
  output?: string;
  dir?: string;
  name?: string;
  yes: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [], yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-y":
      case "--yes":
        flags.yes = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "-c":
      case "--config":
        flags.config = argv[++i];
        break;
      case "-o":
      case "--out":
        flags.out = argv[++i];
        break;
      case "--output":
        flags.output = argv[++i];
        break;
      case "--dir":
        flags.dir = argv[++i];
        break;
      case "-n":
      case "--name":
        flags.name = argv[++i];
        break;
      default:
        flags._.push(a);
    }
  }
  return flags;
}

const HELP = `${c.bold("agnes")} — schema toolkit for agnes-rs

${c.bold("Usage:")}
  agnes <command> [options]

${c.bold("Commands:")}
  init       Scaffold an agnes.config.ts in the current directory
  push       Sync the database to match schema.ts (create/alter/drop)
  pull       Introspect the database and (re)generate schema.ts
  migrate    Generate a versioned SQL migration from drift, then apply pending
  generate   Emit a pre-wired AgnesClient module (db.ts/db.js) from the config

${c.bold("Options:")}
  -c, --config <path>   Config file (default: agnes.config.ts)
  -o, --out <path>      [pull] Output schema file (default: config.out or schema.ts)
      --output <path>   [generate] Output client module (default: config.output)
      --dir <path>      [migrate] Migrations directory (default: migrations)
  -n, --name <name>     [migrate] Name for the generated migration
  -y, --yes             Skip confirmation for destructive operations
      --dry-run         Show the plan/SQL without executing
  -h, --help            Show this help
`;

export async function run(argv: string[]): Promise<void> {
  const flags = parseArgs(argv);
  const command = flags._[0];

  if (!command || flags._.includes("help") || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }

  try {
    // `init` runs without an existing config.
    if (command === "init") {
      await init({ out: flags.out, yes: flags.yes });
      return;
    }

    const config = await loadConfig(flags.config);
    switch (command) {
      case "push":
        await push(config, { yes: flags.yes, dryRun: flags.dryRun });
        break;
      case "pull":
        await pull(config, { out: flags.out, yes: flags.yes });
        break;
      case "migrate":
        await migrate(config, {
          yes: flags.yes,
          dryRun: flags.dryRun,
          dir: flags.dir,
          name: flags.name,
        });
        break;
      case "generate":
        await generate(config, { output: flags.output, yes: flags.yes });
        break;
      default:
        console.error(c.red(`Unknown command: ${command}`));
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(c.red(`\n✗ ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  }
}
