import { schema } from "./src/schema"
import { defineConfig } from "agnes-cli";

export default defineConfig({
  driver: "sqlite",
  url: "sqlite:./demo.db",
  schema,
  out: "./schema.ts",
  migrationsDir: "./migrations",
  output: "./src/db.ts",
  schemaPath: "./src/schema.ts",
  cache: { enabled: true, walPath: ".agnes/cache.wal" },
});
