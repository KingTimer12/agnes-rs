use agnes_core::adapter::{DatabaseAdapter, DatabaseBind, DbTransaction, Dialect, PoolConfig};
use agnes_core::error::{AgnesError, Result};
use agnes_core::stream::RowStream;
use agnes_core::types::{Rows, Value};
use async_trait::async_trait;
use futures_util::StreamExt;
use sqlx::MySql;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::pool::PoolConnection;

use crate::row_ref::MySqlRowRef;

/// Apply the shared pool tuning to a MySQL pool builder.
fn apply_pool_opts(mut o: MySqlPoolOptions, cfg: &PoolConfig) -> MySqlPoolOptions {
    o = o
        .max_connections(cfg.max_connections.max(1))
        .min_connections(cfg.min_connections);
    if let Some(d) = cfg.acquire_timeout {
        o = o.acquire_timeout(d);
    }
    if let Some(d) = cfg.idle_timeout {
        o = o.idle_timeout(d);
    }
    if let Some(d) = cfg.max_lifetime {
        o = o.max_lifetime(d);
    }
    o
}

fn adapter_err<E: std::fmt::Display>(e: E) -> AgnesError {
    AgnesError::Adapter(e.to_string())
}

/// Transaction bound to one pooled MySQL connection.
pub struct MySqlTx {
    conn: PoolConnection<MySql>,
    strip_tz: bool,
}

#[async_trait]
impl DbTransaction for MySqlTx {
    async fn query(&mut self, sql: &str, params: &[Value]) -> Result<Rows> {
        let q = MySqlAdapter::bind(sqlx::query(sql), params);
        let rows = q.fetch_all(&mut *self.conn).await.map_err(adapter_err)?;
        rows.iter()
            .map(|row| {
                MySqlRowRef {
                    row,
                    strip_tz: self.strip_tz,
                }
                .try_into()
            })
            .collect()
    }

    async fn execute(&mut self, sql: &str, params: &[Value]) -> Result<u64> {
        let q = MySqlAdapter::bind(sqlx::query(sql), params);
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

pub struct MySqlAdapter {
    pool: MySqlPool,
    strip_tz: bool,
}

impl MySqlAdapter {
    pub async fn connect(url: &str, cfg: &PoolConfig, strip_tz: bool) -> Result<Self> {
        let pool = apply_pool_opts(MySqlPoolOptions::new(), cfg)
            .connect(url)
            .await
            .map_err(|e| AgnesError::Adapter(e.to_string()))?;
        Ok(Self { pool, strip_tz })
    }

    pub fn from_pool(pool: MySqlPool) -> Self {
        Self {
            pool,
            strip_tz: false,
        }
    }
}

#[async_trait]
impl DatabaseAdapter for MySqlAdapter {
    async fn query(&self, sql: &str, params: &[Value]) -> Result<Rows> {
        let q = Self::bind(sqlx::query(sql), params);
        let rows = q
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AgnesError::Adapter(e.to_string()))?;
        rows.iter()
            .map(|row| {
                MySqlRowRef {
                    row,
                    strip_tz: self.strip_tz,
                }
                .try_into()
            })
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
        Dialect::MySql
    }

    fn stream(&self, sql: &str, params: &[Value]) -> RowStream {
        let pool = self.pool.clone();
        let sql = sql.to_string();
        let params = params.to_vec();
        let strip_tz = self.strip_tz;
        let (tx, stream) = RowStream::channel();
        tokio::spawn(async move {
            let q = MySqlAdapter::bind(sqlx::query(&sql), &params);
            let mut rows = q.fetch(&pool);
            while let Some(item) = rows.next().await {
                let msg = match item {
                    Ok(row) => MySqlRowRef {
                        row: &row,
                        strip_tz,
                    }
                    .try_into(),
                    Err(e) => Err(adapter_err(e)),
                };
                let is_err = msg.is_err();
                if tx.send(msg).await.is_err() || is_err {
                    break;
                }
            }
        });
        stream
    }

    async fn begin(&self) -> Result<Box<dyn DbTransaction>> {
        let mut conn = self.pool.acquire().await.map_err(adapter_err)?;
        sqlx::query("BEGIN")
            .execute(&mut *conn)
            .await
            .map_err(adapter_err)?;
        Ok(Box::new(MySqlTx {
            conn,
            strip_tz: self.strip_tz,
        }))
    }
}
