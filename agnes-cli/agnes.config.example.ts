import { defineConfig } from "agnes-cli";
import {
  table,
  int,
  text,
  bool,
  many,
  one,
  OnAction,
} from "agnes-library";

// Your schema. Can live here or be imported from ./schema.ts.
export const schema = {
  user: table(
    {
      id: int("id").primary(),
      name: text("name").index("name_idx"),
      email: text("email").uniqueIndex("email_idx"),
      age: int("age"),
      active: bool("active").default(true),
      posts: many("post", "userId"),
    },
    "users",
  ),
  post: table(
    {
      id: int("id").primary(),
      userId: int("user_id"),
      content: text("content"),
      user: one("user", "userId", "id", OnAction.None, OnAction.Cascade),
    },
    "posts",
  ),
};

export default defineConfig({
  driver: "postgres",
  url: process.env.DATABASE_URL ?? "postgres://user:pass@localhost/db",
  schema,

  // Return timestamps as naive ISO (no offset) to avoid the JS Date tz shift.
  stripTimezone: false,

  // PostgreSQL schemas to introspect (default: ["public"]). Tables outside the
  // default schema get qualified physical names, e.g. table(def, "auth.users").
  schemas: ["public"],

  // How `agnes pull` writes the schema:
  //   "singlefile" (default) → one file at `out` (below).
  //   "multifile"            → one file per DB schema + an index re-exporting
  //                            them merged; `out` is then treated as a directory.
  pullMode: "singlefile",
  out: "./schema.ts",
  migrationsDir: "./migrations",

  // `agnes generate` writes the ready-to-import client here.
  // Extension picks the language: db.ts → TypeScript, db.js → JavaScript.
  output: "src/services/db.ts",
  // Env var holding the URL. When set, `agnes generate` emits
  // process.env[urlEnv] instead of inlining the URL — credentials stay in .env.
  urlEnv: "DATABASE_URL",
  // Module the generated client imports `schema` from (default: `out`).
  schemaPath: "./agnes.config.ts",
  // Cache baked into the generated client.
  cache: { enabled: true, walPath: ".agnes/cache.wal" },
});
