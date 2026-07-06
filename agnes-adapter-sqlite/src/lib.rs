use agnes_core::adapter::{DatabaseAdapter, DatabaseBind, DbTransaction, Dialect};
use agnes_core::error::{AgnesError, Result};
use agnes_core::types::{Rows, Value};
use async_trait::async_trait;
use sqlx::Sqlite;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::str::FromStr;

use crate::row_ref::SqliteRowRef;

fn adapter_err<E: std::fmt::Display>(e: E) -> AgnesError {
    AgnesError::Adapter(e.to_string())
}

/// Transaction bound to one pooled SQLite connection.
pub struct SqliteTx {
    conn: PoolConnection<Sqlite>,
}

#[async_trait]
impl DbTransaction for SqliteTx {
    async fn query(&mut self, sql: &str, params: &[Value]) -> Result<Rows> {
        let q = SqliteAdapter::bind(sqlx::query(sql), params);
        let rows = q.fetch_all(&mut *self.conn).await.map_err(adapter_err)?;
        rows.iter()
            .map(|row| SqliteRowRef(row).try_into())
            .collect()
    }

    async fn execute(&mut self, sql: &str, params: &[Value]) -> Result<u64> {
        let q = SqliteAdapter::bind(sqlx::query(sql), params);
        Ok(q.execute(&mut *self.conn)
            .await
            .map_err(adapter_err)?
            .rows_affected())
    }

    async fn commit(mut self: Box<Self>) -> Result<()> {
        sqlx::query("COMMIT")
            .execute(&mut *self.conn)
            .await
            .map_err(adapter_err)?;
        Ok(())
    }

    async fn rollback(mut self: Box<Self>) -> Result<()> {
        sqlx::query("ROLLBACK")
            .execute(&mut *self.conn)
            .await
            .map_err(adapter_err)?;
        Ok(())
    }
}

mod bind;
mod row_ref;

pub struct SqliteAdapter {
    pool: SqlitePool,
}

impl SqliteAdapter {
    // `_strip_tz` is accepted for a uniform adapter API; SQLite stores temporal
    // values as TEXT/INTEGER with no timezone, so there is nothing to strip.
    pub async fn connect(url: &str, max_connections: u32, _strip_tz: bool) -> Result<Self> {
        let opts = SqliteConnectOptions::from_str(url)
            .map_err(|e| AgnesError::Adapter(e.to_string()))?
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(max_connections.max(1))
            .connect_with(opts)
            .await
            .map_err(|e| AgnesError::Adapter(e.to_string()))?;
        Ok(Self { pool })
    }

    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DatabaseAdapter for SqliteAdapter {
    async fn query(&self, sql: &str, params: &[Value]) -> Result<Rows> {
        let q = Self::bind(sqlx::query(sql), params);
        let rows = q
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AgnesError::Adapter(e.to_string()))?;
        rows.iter()
            .map(|row| SqliteRowRef(row).try_into())
            .collect()
    }

    async fn execute(&self, sql: &str, params: &[Value]) -> Result<u64> {
        let q = Self::bind(sqlx::query(sql), params);
        let r = q
            .execute(&self.pool)
            .await
            .map_err(|e| AgnesError::Adapter(e.to_string()))?;
        Ok(r.rows_affected())
    }

    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    async fn begin(&self) -> Result<Box<dyn DbTransaction>> {
        let mut conn = self.pool.acquire().await.map_err(adapter_err)?;
        sqlx::query("BEGIN")
            .execute(&mut *conn)
            .await
            .map_err(adapter_err)?;
        Ok(Box::new(SqliteTx { conn }))
    }
}
