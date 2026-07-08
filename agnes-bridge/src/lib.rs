#![deny(clippy::all)]

mod convert;

use std::sync::Arc;

use agnes_adapter_mysql::MySqlAdapter;
use agnes_adapter_postgres::PostgresAdapter;
use agnes_adapter_sqlite::SqliteAdapter;
use agnes_cache::{KvConfig, KvMotor};
use agnes_core::adapter::{DatabaseAdapter, PoolConfig};
use agnes_core::cache::CacheBackend;
use agnes_core::executor::Executor;
use agnes_core::replicated::{ReplicatedAdapter, ReplicationOptions};
use agnes_core::types::QueryOptions;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::convert::{js_values_to_params, rows_to_json};

#[napi(object)]
pub struct DatabaseConfig {
  pub driver: String,
  pub url: String,
  /// Max open connections in the pool (default 10).
  pub max_connections: Option<u32>,
  /// Connections kept warm even while idle (default 0).
  pub min_connections: Option<u32>,
  /// Seconds `acquire` waits for a free connection before erroring.
  pub acquire_timeout_secs: Option<u32>,
  /// Close a connection after it has been idle this many seconds.
  pub idle_timeout_secs: Option<u32>,
  /// Recycle a connection after it has lived this many seconds.
  pub max_lifetime_secs: Option<u32>,
  pub cache: Option<CacheConfig>,
  /// Return temporal values without a timezone offset (naive wall-clock ISO).
  /// Avoids the JS `Date` tz-shift footgun. Postgres only; defaults to false.
  pub strip_timezone: Option<bool>,
  /// Read replicas (master/slave mode). When set, `url` is the write master and
  /// these are read-only replicas: writes and transactions go to the master;
  /// reads are load-balanced across the least-busy node.
  pub replicas: Option<Vec<String>>,
  /// Extra load penalty on the master when picking a read node (default 100).
  /// Higher = replicas preferred more strongly. Only used with `replicas`.
  pub master_read_penalty: Option<u32>,
  /// Seconds a replica is skipped for reads after it errors (default 5).
  pub replica_cooldown_secs: Option<u32>,
}

#[napi(object)]
pub struct CacheConfig {
  pub enabled: bool,
  pub wal_path: Option<String>,
  pub compaction_threshold: Option<u32>,
}

#[napi(object)]
pub struct QueryOpts {
  pub ttl: Option<u32>,
  pub cache_key: Option<String>,
  pub bypass_cache: Option<bool>,
  /// Read-your-writes: run this read on the write master (skips replicas).
  pub read_primary: Option<bool>,
}

#[napi]
pub struct Database {
  executor: Arc<Executor>,
}

#[napi]
impl Database {
  #[napi(factory)]
  pub async fn connect(config: DatabaseConfig) -> Result<Database> {
    let strip_tz = config.strip_timezone.unwrap_or(false);
    let secs = |v: Option<u32>| v.map(|s| std::time::Duration::from_secs(s as u64));
    let pool = PoolConfig {
      max_connections: config.max_connections.unwrap_or(10),
      min_connections: config.min_connections.unwrap_or(0),
      acquire_timeout: secs(config.acquire_timeout_secs),
      idle_timeout: secs(config.idle_timeout_secs),
      max_lifetime: secs(config.max_lifetime_secs),
    };

    let driver = config.driver.to_ascii_lowercase();
    let master = connect_adapter(&driver, &config.url, &pool, strip_tz).await?;

    let adapter: Arc<dyn DatabaseAdapter> = match &config.replicas {
      Some(urls) if !urls.is_empty() => {
        let mut replicas = Vec::with_capacity(urls.len());
        for url in urls {
          replicas.push(connect_adapter(&driver, url, &pool, strip_tz).await?);
        }
        let opts = ReplicationOptions {
          master_read_penalty: config.master_read_penalty.unwrap_or(100) as i64,
          cooldown: std::time::Duration::from_secs(
            config.replica_cooldown_secs.unwrap_or(5) as u64,
          ),
        };
        Arc::new(ReplicatedAdapter::new(master, replicas, opts))
      }
      _ => master,
    };

    let cache: Option<Arc<dyn CacheBackend>> = match config.cache {
      Some(c) if c.enabled => {
        let wal_path: Option<std::path::PathBuf> = c.wal_path.map(Into::into);
        if let Some(p) = &wal_path
          && let Some(dir) = p.parent()
        {
          std::fs::create_dir_all(dir).map_err(to_napi)?;
        }
        let kv = KvMotor::new(KvConfig {
          wal_path,
          compaction_threshold: c.compaction_threshold.unwrap_or(1024) as u64,
        })
        .map_err(to_napi)?;
        Some(Arc::new(kv))
      }
      _ => None,
    };

    Ok(Database {
      executor: Arc::new(Executor::new(adapter, cache)),
    })
  }

  #[napi]
  pub async fn query(
    &self,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
    opts: Option<QueryOpts>,
  ) -> Result<serde_json::Value> {
    let params = js_values_to_params(params.unwrap_or_default());
    let opts = to_query_options(opts);
    let rows = self
      .executor
      .query(&sql, &params, &opts)
      .await
      .map_err(to_napi)?;
    Ok(rows_to_json(rows))
  }

  #[napi]
  pub async fn mutate(&self, sql: String, params: Option<Vec<serde_json::Value>>) -> Result<u32> {
    let params = js_values_to_params(params.unwrap_or_default());
    let affected = self.executor.mutate(&sql, &params).await.map_err(to_napi)?;
    Ok(affected as u32)
  }

  /// Stream a read query row-by-row (constant memory). Pull batches from the
  /// returned handle with `nextBatch(n)`; an empty batch means end of stream.
  #[napi]
  pub async fn stream(
    &self,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
  ) -> Result<RowStream> {
    let params = js_values_to_params(params.unwrap_or_default());
    let inner = self.executor.stream(&sql, &params);
    Ok(RowStream {
      inner: Arc::new(tokio::sync::Mutex::new(inner)),
    })
  }

  /// Open an interactive transaction on a dedicated connection.
  #[napi]
  pub async fn begin_transaction(&self) -> Result<Transaction> {
    let tx = self.executor.begin().await.map_err(to_napi)?;
    Ok(Transaction {
      inner: Arc::new(tokio::sync::Mutex::new(Some(tx))),
    })
  }
}

/// A pull-based row stream. `nextBatch(n)` resolves to up to `n` rows; an empty
/// array means the stream is exhausted.
#[napi]
pub struct RowStream {
  inner: Arc<tokio::sync::Mutex<agnes_core::stream::RowStream>>,
}

#[napi]
impl RowStream {
  #[napi]
  pub async fn next_batch(&self, n: u32) -> Result<serde_json::Value> {
    let mut guard = self.inner.lock().await;
    let rows = guard.next_batch(n as usize).await.map_err(to_napi)?;
    Ok(rows_to_json(rows))
  }
}

/// A live transaction handle. `query`/`mutate` run on the transaction's
/// connection; `commit`/`rollback` finish it (further calls error).
#[napi]
pub struct Transaction {
  inner: Arc<tokio::sync::Mutex<Option<agnes_core::executor::Transaction>>>,
}

#[napi]
impl Transaction {
  #[napi]
  pub async fn query(
    &self,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
    opts: Option<QueryOpts>,
  ) -> Result<serde_json::Value> {
    let _ = opts; // reads inside a transaction always hit the DB (no cache)
    let params = js_values_to_params(params.unwrap_or_default());
    let mut guard = self.inner.lock().await;
    let tx = guard
      .as_mut()
      .ok_or_else(|| Error::from_reason("transaction already finished"))?;
    let rows = tx.query(&sql, &params).await.map_err(to_napi)?;
    Ok(rows_to_json(rows))
  }

  #[napi]
  pub async fn mutate(&self, sql: String, params: Option<Vec<serde_json::Value>>) -> Result<u32> {
    let params = js_values_to_params(params.unwrap_or_default());
    let mut guard = self.inner.lock().await;
    let tx = guard
      .as_mut()
      .ok_or_else(|| Error::from_reason("transaction already finished"))?;
    let affected = tx.mutate(&sql, &params).await.map_err(to_napi)?;
    Ok(affected as u32)
  }

  #[napi]
  pub async fn commit(&self) -> Result<()> {
    let tx = self
      .inner
      .lock()
      .await
      .take()
      .ok_or_else(|| Error::from_reason("transaction already finished"))?;
    tx.commit().await.map_err(to_napi)
  }

  #[napi]
  pub async fn rollback(&self) -> Result<()> {
    let tx = self
      .inner
      .lock()
      .await
      .take()
      .ok_or_else(|| Error::from_reason("transaction already finished"))?;
    tx.rollback().await.map_err(to_napi)
  }
}

fn to_query_options(opts: Option<QueryOpts>) -> QueryOptions {
  match opts {
    None => QueryOptions::default(),
    Some(o) => QueryOptions {
      ttl_secs: o.ttl.map(|t| t as u64),
      cache_key: o.cache_key,
      bypass_cache: o.bypass_cache.unwrap_or(false),
      read_primary: o.read_primary.unwrap_or(false),
    },
  }
}

/// Connect a single node's adapter for the given driver.
async fn connect_adapter(
  driver: &str,
  url: &str,
  pool: &PoolConfig,
  strip_tz: bool,
) -> Result<Arc<dyn DatabaseAdapter>> {
  let adapter: Arc<dyn DatabaseAdapter> = match driver {
    "postgres" | "postgresql" | "pg" => {
      Arc::new(PostgresAdapter::connect(url, pool, strip_tz).await.map_err(to_napi)?)
    }
    "mysql" | "mariadb" => {
      Arc::new(MySqlAdapter::connect(url, pool, strip_tz).await.map_err(to_napi)?)
    }
    "sqlite" => Arc::new(SqliteAdapter::connect(url, pool, strip_tz).await.map_err(to_napi)?),
    other => return Err(Error::from_reason(format!("unknown driver: {other}"))),
  };
  Ok(adapter)
}

fn to_napi<E: std::fmt::Display>(e: E) -> Error {
  Error::from_reason(e.to_string())
}
