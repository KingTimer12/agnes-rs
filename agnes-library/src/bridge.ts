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
  /** Max open connections in the pool (default 10). */
  maxConnections?: number;
  /** Connections kept warm even while idle (default 0). */
  minConnections?: number;
  /** Seconds `acquire` waits for a free connection before erroring. */
  acquireTimeoutSecs?: number;
  /** Close a connection after it has been idle this many seconds. */
  idleTimeoutSecs?: number;
  /** Recycle a connection after it has lived this many seconds. */
  maxLifetimeSecs?: number;
  cache?: CacheConfig;
  /**
   * Return temporal values (timestamp/date/time) without a timezone offset —
   * naive wall-clock ISO strings like `2026-07-01T12:00:00`. Avoids the JS
   * `Date` timezone-shift footgun (the classic Prisma problem). Postgres only;
   * defaults to false. SQLite/MySQL values are already naive.
   */
  stripTimezone?: boolean;
  /**
   * Read replicas (master/slave mode). When set, `url` is the write **master**
   * and these are read-only **replicas**: writes and transactions go to the
   * master, while reads are load-balanced to the least-busy node. One master,
   * any number of replicas. Omit for a single-node setup.
   */
  replicas?: string[];
  /**
   * Extra load penalty applied to the master when choosing a read node
   * (default 100). Higher biases reads toward replicas; the master still serves
   * reads when it's the least-loaded node. Only used with `replicas`.
   */
  masterReadPenalty?: number;
  /** Seconds a replica is skipped for reads after it errors (default 5). */
  replicaCooldownSecs?: number;
}

export interface QueryOpts {
  ttl?: number;
  cacheKey?: string;
  bypassCache?: boolean;
}

/** A pull-based row stream: `nextBatch(n)` resolves to up to `n` rows; `[]` = done. */
export interface RustRowStream {
  nextBatch(n: number): Promise<unknown>;
}

/** Shared surface of the DB handle and a transaction — what the builders call. */
export interface QueryRunner {
  query(sql: string, params?: unknown[], opts?: QueryOpts): Promise<unknown>;
  mutate(sql: string, params?: unknown[]): Promise<number>;
  /** Only present on the database handle, not on a transaction. */
  stream?(sql: string, params?: unknown[]): Promise<RustRowStream>;
}

export interface RustTransaction extends QueryRunner {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface RustDatabase extends QueryRunner {
  stream(sql: string, params?: unknown[]): Promise<RustRowStream>;
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
