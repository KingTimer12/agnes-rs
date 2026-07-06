#![deny(clippy::all)]

mod convert;

use std::sync::Arc;

use agnes_adapter_mysql::MySqlAdapter;
use agnes_adapter_postgres::PostgresAdapter;
use agnes_adapter_sqlite::SqliteAdapter;
use agnes_cache::{KvConfig, KvMotor};
use agnes_core::adapter::DatabaseAdapter;
use agnes_core::cache::CacheBackend;
use agnes_core::executor::Executor;
use agnes_core::types::QueryOptions;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::convert::{js_values_to_params, rows_to_json};

#[napi(object)]
pub struct DatabaseConfig {
  pub driver: String,
  pub url: String,
  pub max_connections: Option<u32>,
  pub cache: Option<CacheConfig>,
  /// Return temporal values without a timezone offset (naive wall-clock ISO).
  /// Avoids the JS `Date` tz-shift footgun. Postgres only; defaults to false.
  pub strip_timezone: Option<bool>,
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
}

#[napi]
pub struct Database {
  executor: Arc<Executor>,
}

#[napi]
impl Database {
  #[napi(factory)]
  pub async fn connect(config: DatabaseConfig) -> Result<Database> {
    let max = config.max_connections.unwrap_or(10);
    let strip_tz = config.strip_timezone.unwrap_or(false);

    let adapter: Arc<dyn DatabaseAdapter> = match config.driver.to_ascii_lowercase().as_str() {
      "postgres" | "postgresql" | "pg" => Arc::new(
        PostgresAdapter::connect(&config.url, max, strip_tz)
          .await
          .map_err(to_napi)?,
      ),
      "mysql" | "mariadb" => Arc::new(
        MySqlAdapter::connect(&config.url, max, strip_tz)
          .await
          .map_err(to_napi)?,
      ),
      "sqlite" => Arc::new(
        SqliteAdapter::connect(&config.url, max, strip_tz)
          .await
          .map_err(to_napi)?,
      ),
      other => {
        return Err(Error::from_reason(format!("unknown driver: {other}")));
      }
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

  /// Open an interactive transaction on a dedicated connection.
  #[napi]
  pub async fn begin_transaction(&self) -> Result<Transaction> {
    let tx = self.executor.begin().await.map_err(to_napi)?;
    Ok(Transaction {
      inner: Arc::new(tokio::sync::Mutex::new(Some(tx))),
    })
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
    },
  }
}

fn to_napi<E: std::fmt::Display>(e: E) -> Error {
  Error::from_reason(e.to_string())
}
