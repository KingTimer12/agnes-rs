// Thin wrapper around the NAPI addon. All heavy lifting runs in Rust.
// The `agnes-bridge` package is linked from ../agnes-bridge after `napi build`.

type Driver = "postgres" | "mysql" | "sqlite";

export interface CacheConfig {
  enabled: boolean;
  walPath?: string;
  compactionThreshold?: number;
}

export interface DatabaseConfig {
  driver: Driver;
  url: string;
  maxConnections?: number;
  cache?: CacheConfig;
  /**
   * Return temporal values (timestamp/date/time) without a timezone offset —
   * naive wall-clock ISO strings like `2026-07-01T12:00:00`. Avoids the JS
   * `Date` timezone-shift footgun (the classic Prisma problem). Postgres only;
   * defaults to false. SQLite/MySQL values are already naive.
   */
  stripTimezone?: boolean;
}

export interface QueryOpts {
  ttl?: number;
  cacheKey?: string;
  bypassCache?: boolean;
}

/** Shared surface of the DB handle and a transaction — what the builders call. */
export interface QueryRunner {
  query(sql: string, params?: unknown[], opts?: QueryOpts): Promise<unknown>;
  mutate(sql: string, params?: unknown[]): Promise<number>;
}

export interface RustTransaction extends QueryRunner {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface RustDatabase extends QueryRunner {
  beginTransaction(): Promise<RustTransaction>;
}

interface RustBridge {
  Database: {
    connect(config: DatabaseConfig): Promise<RustDatabase>;
  };
}

let cached: RustBridge | undefined;

async function loadBridge(): Promise<RustBridge> {
  if (cached) return cached;
  const moduleName = "agnes-bridge";
  cached = (await import(moduleName)) as unknown as RustBridge;
  return cached;
}

export async function connectRust(config: DatabaseConfig): Promise<RustDatabase> {
  const bridge = await loadBridge();
  return bridge.Database.connect(config);
}
