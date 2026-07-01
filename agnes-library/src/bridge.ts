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
}

export interface QueryOpts {
  ttl?: number;
  cacheKey?: string;
  bypassCache?: boolean;
}

export interface RustDatabase {
  query(sql: string, params?: unknown[], opts?: QueryOpts): Promise<unknown>;
  mutate(sql: string, params?: unknown[]): Promise<number>;
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
