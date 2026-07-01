# agnes-cli

Schema toolkit for **agnes-rs**. Reads your TypeScript `schema.ts` DSL and keeps
your database in sync — `push`, `pull`, and `migrate`. Runs on [Bun](https://bun.sh)
and talks to the database through the same Rust bridge (`agnes-library`), so it
supports **PostgreSQL, MySQL and SQLite**.

## Install

Inside this workspace it's already linked. From a consumer project:

```bash
bun add agnes-cli agnes-library
```

## Configure

Run `bun agnes init` to scaffold `agnes.config.ts`, or create it yourself
(see `agnes.config.example.ts`):

```ts
import { defineConfig } from "agnes-cli";
import { schema } from "./schema"; // your `export const schema = { ... }`

export default defineConfig({
  driver: "postgres",
  url: process.env.DATABASE_URL!,
  schema,

  stripTimezone: false,        // return timestamps as naive ISO (no tz offset)
  schemas: ["public"],         // PostgreSQL schemas to introspect (default: public)
  pullMode: "singlefile",      // "singlefile" | "multifile"
  out: "./schema.ts",          // where `pull` writes (a directory in multifile mode)
  migrationsDir: "./migrations",

  // `generate` output — extension picks the language (.ts or .js)
  output: "src/services/db.ts",
  urlEnv: "DATABASE_URL",      // `generate` reads the URL from here (keeps it out of the file)
  schemaPath: "./schema.ts",   // module the generated client imports `schema` from
  cache: { enabled: true, walPath: ".agnes/cache.wal" },
});
```

## Commands

```bash
bun agnes init        # scaffold agnes.config.ts
bun agnes push        # make the DB match schema.ts (create/alter/DROP)
bun agnes pull        # regenerate schema.ts from the live DB
bun agnes migrate     # write a versioned .sql from drift, then apply pending
bun agnes generate    # emit a pre-wired AgnesClient module (db.ts / db.js)
```

(From the repo root: `bun run agnes push`.)

### `push` — schema.ts ➜ database

Diffs your schema against the live database and applies the difference. This is a
**full sync**: tables and columns that exist in the DB but not in your schema are
**dropped**. Destructive operations (`DROP TABLE` / `DROP COLUMN`) require an
interactive confirmation — pass `-y` / `--yes` to skip it in CI.

```bash
bun agnes push --dry-run   # print the plan + SQL, change nothing
bun agnes push --yes       # apply without prompting
```

### `pull` — database ➜ schema.ts

Introspects the live database and regenerates `schema.ts` to mirror it exactly
(tables/columns/indexes/foreign keys no longer present are removed from the file).
Prompts before overwriting an existing file unless `--yes`.

```bash
bun agnes pull --out src/schema.ts
```

**Multi-schema (PostgreSQL).** List the schemas you want in `schemas` — tables
outside `public` get qualified physical names (`table(def, "auth.users")`):

```ts
schemas: ["public", "auth", "billing"],
```

Non-`public` tables are grouped one level deep by schema; `public` tables stay
at the top level. The group flattens to a dotted key you select by:

```ts
export const schema = {
  users: table({ /* … */ }, "users"),          // public → top level
  legislativo: {                                // grouped by schema
    etapas: table({ /* … */ }, "legislativo.etapas"),
  },
};

db.select("users");
db.select("legislativo.etapas");   // dotted key = <schema>.<table>
```

With `pullMode: "multifile"`, `pull` writes one file per DB schema plus an
`index.ts` that merges them into a single `schema` export — `out` is then a
directory:

```
schema/
  public.ts
  auth.ts
  index.ts   ← import { schema } from "./schema"
```

**Defaults & auto-increment.** `pull` renders defaults in the column's type
(`bool("x").default(true)`, `int("n").default(1)` — not strings). Serial /
identity / `AUTO_INCREMENT` columns become `.autoincrement()`, and SQL
expressions that can't be a literal (e.g. `CURRENT_TIMESTAMP`) are omitted.

### `migrate` — versioned SQL files

1. Diffs schema vs DB and, if there's drift, writes a timestamped file to
   `migrationsDir` (e.g. `20260701123000_auto.sql`).
2. Applies every pending file (those not yet recorded in the `_agnes_migrations`
   tracking table) in order, recording each as it succeeds.

Destructive migrations prompt for confirmation unless `--yes`.

```bash
bun agnes migrate -n add_users     # name the generated migration
bun agnes migrate --dry-run        # show what would be generated/applied
```

### `generate` — pre-wired client module

Writes a ready-to-import `AgnesClient` module built from your config — driver,
url and cache all baked in. Point `output` anywhere (nested dirs are created):

```ts
// src/services/db.ts  ← generated
import { AgnesClient } from "agnes-library";
import { schema } from "../../schema";

export const db = await AgnesClient.create(
  {
    driver: "sqlite",
    url: process.env["DATABASE_URL"]!,
    cache: { enabled: true, walPath: ".agnes/cache.wal" },
  },
  schema,
);
```

- `output` (config) or `--output` picks the path. `.ts` → TypeScript, `.js` → JavaScript.
- The `import { schema }` path is made relative to the output file automatically.
- The `cache` block is emitted only if you set `cache` in the config.
- **Secrets stay out of the file:** set `urlEnv` (e.g. `"DATABASE_URL"`) and the
  client reads `process.env[urlEnv]` at runtime instead of inlining the URL.
  Without `urlEnv`, `generate` warns and inlines the literal `url`.

```bash
bun agnes generate                       # uses config.output
bun agnes generate --output src/db.js    # override; JS output
```

## Timezones

Set `stripTimezone: true` (config, or `stripTimezone` on `AgnesClient.create`)
to get temporal columns back as **naive ISO strings** with no offset —
`"2026-07-01T12:00:00"` instead of `"2026-07-01T12:00:00+00:00"`. This sidesteps
the classic footgun where `new Date(value)` shifts the wall-clock time by the
runtime's local offset. Postgres only; MySQL/SQLite values are already naive.

## Options

| Flag | Applies to | Meaning |
|------|-----------|---------|
| `-c, --config <path>` | all | Config file (default `agnes.config.ts`) |
| `-o, --out <path>` | init, pull | Config path (init) / output schema file or dir (pull) |
| `--output <path>` | generate | Output client module (.ts/.js) |
| `--dir <path>` | migrate | Migrations directory |
| `-n, --name <name>` | migrate | Name for the generated migration |
| `-y, --yes` | push, pull, migrate | Skip destructive confirmations |
| `--dry-run` | push, migrate | Show the plan/SQL without executing |

## Type mapping

| DSL | PostgreSQL | MySQL | SQLite |
|-----|-----------|-------|--------|
| `int` | integer | int | integer |
| `bigint` | bigint | bigint | integer |
| `text` | text | text | text |
| `bool` | boolean | tinyint(1) | integer |
| `float` | double precision | double | real |
| `bytes` | bytea | blob | blob |
| `json` | jsonb | json | text |

> **SQLite note:** SQLite can't `ALTER` column types or add/drop foreign keys after
> table creation. Those operations are emitted as `-- SKIPPED` comments; recreate
> the table manually if you need them.
