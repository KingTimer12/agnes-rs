use agnes_core::adapter::{DatabaseAdapter, DatabaseBind, Dialect};
use agnes_core::error::{AgnesError, Result};
use agnes_core::types::{Rows, Value};
use async_trait::async_trait;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};

use crate::row_ref::MySqlRowRef;

mod bind;
mod row_ref;

pub struct MySqlAdapter {
    pool: MySqlPool,
    strip_tz: bool,
}

impl MySqlAdapter {
    pub async fn connect(url: &str, max_connections: u32, strip_tz: bool) -> Result<Self> {
        let pool = MySqlPoolOptions::new()
            .max_connections(max_connections.max(1))
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
}
