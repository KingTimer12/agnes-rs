// Public API — import `defineConfig` in your agnes.config.ts.
export { defineConfig, type AgnesConfig, type CacheConfig } from "./config";
export { run } from "./cli";
export { push } from "./commands/push";
export { pull } from "./commands/pull";
export { migrate } from "./commands/migrate";
export { generate } from "./commands/generate";
export { schemaToIR } from "./ir";
export { diffSchemas } from "./diff";
export { introspect } from "./introspect";
export type { DatabaseIR, TableIR, ColumnIR, IndexIR, ForeignKeyIR } from "./ir";
