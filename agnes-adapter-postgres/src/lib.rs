use agnes_core::adapter::{DatabaseAdapter, DatabaseBind, Dialect};
use agnes_core::error::{AgnesError, Result};
use agnes_core::types::{Rows, Value};
use async_trait::async_trait;
use sqlx::postgres::{PgPool, PgPoolOptions};

use crate::row_ref::PostgresRowRef;

mod bind;
mod row_ref;

pub struct PostgresAdapter {
    pool: PgPool,
}

impl PostgresAdapter {
    pub async fn connect(url: &str, max_connections: u32) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections.max(1))
            .connect(url)
            .await
            .map_err(|e| AgnesError::Adapter(e.to_string()))?;
        Ok(Self { pool })
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DatabaseAdapter for PostgresAdapter {
    async fn query(&self, sql: &str, params: &[Value]) -> Result<Rows> {
        let q = Self::bind(sqlx::query(sql), params);
        let rows = q
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AgnesError::Adapter(e.to_string()))?;
        rows.iter()
            .map(|row| PostgresRowRef(row).try_into())
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
        Dialect::Postgres
    }
}
