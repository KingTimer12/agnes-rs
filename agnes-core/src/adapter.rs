use std::time::Duration;

use async_trait::async_trait;

use crate::error::Result;
use crate::types::{Rows, Value};

/// Connection-pool tuning shared by every adapter. `None` timeouts fall back to
/// the sqlx defaults. Durations are seconds at the config surface.
#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// Hard cap on open connections.
    pub max_connections: u32,
    /// Connections kept warm even while idle.
    pub min_connections: u32,
    /// How long `acquire` waits for a free connection before erroring.
    pub acquire_timeout: Option<Duration>,
    /// Close a connection after it has been idle this long.
    pub idle_timeout: Option<Duration>,
    /// Recycle a connection after it has lived this long.
    pub max_lifetime: Option<Duration>,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            max_connections: 10,
            min_connections: 0,
            acquire_timeout: None,
            idle_timeout: None,
            max_lifetime: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    MySql,
    Sqlite,
}

pub trait RowRef<T>: TryFrom<T> {
    fn decode(&self, i: usize, ty: &str) -> Result<serde_json::Value>;
}

#[async_trait]
pub trait DatabaseAdapter: Send + Sync {
    async fn query(&self, sql: &str, params: &[Value]) -> Result<Rows>;
    async fn execute(&self, sql: &str, params: &[Value]) -> Result<u64>;
    fn dialect(&self) -> Dialect;

    /// Check out a dedicated connection and open a transaction on it (BEGIN).
    async fn begin(&self) -> Result<Box<dyn DbTransaction>>;
}

/// A transaction bound to a single connection. Queries run on that connection
/// until `commit`/`rollback` consumes it.
#[async_trait]
pub trait DbTransaction: Send {
    async fn query(&mut self, sql: &str, params: &[Value]) -> Result<Rows>;
    async fn execute(&mut self, sql: &str, params: &[Value]) -> Result<u64>;
    async fn commit(self: Box<Self>) -> Result<()>;
    async fn rollback(self: Box<Self>) -> Result<()>;
}

pub trait DatabaseBind {
    fn bind<'q, D>(
        mut q: sqlx::query::Query<'q, D, <D as sqlx::Database>::Arguments<'q>>,
        params: &'q [Value],
    ) -> sqlx::query::Query<'q, D, <D as sqlx::Database>::Arguments<'q>>
    where
        D: sqlx::Database,
        bool: sqlx::Encode<'q, D> + sqlx::Type<D>,
        i64: sqlx::Encode<'q, D> + sqlx::Type<D>,
        Option<i64>: sqlx::Encode<'q, D> + sqlx::Type<D>,
        f64: sqlx::Encode<'q, D> + sqlx::Type<D>,
        String: sqlx::Encode<'q, D> + sqlx::Type<D>,
        Vec<u8>: sqlx::Encode<'q, D> + sqlx::Type<D>,
    {
        for p in params {
            q = match p {
                Value::Null => q.bind::<Option<i64>>(None),
                Value::Bool(b) => q.bind(*b),
                Value::Int(i) => q.bind(*i),
                Value::Float(f) => q.bind(*f),
                Value::Text(s) => q.bind(s.clone()),
                Value::Bytes(b) => q.bind(b.clone()),
            };
        }
        q
    }
}
