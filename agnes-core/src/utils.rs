use sqlx::{Database, pool};

use crate::PoolConfig;

/// Apply the shared pool tuning to a MySQL pool builder.
pub fn apply_pool_opts<DB: Database>(
    mut options: pool::PoolOptions<DB>,
    cfg: &PoolConfig,
) -> pool::PoolOptions<DB> {
    options = options
        .max_connections(cfg.max_connections.max(1))
        .min_connections(cfg.min_connections);
    if let Some(d) = cfg.acquire_timeout {
        options = options.acquire_timeout(d);
    }
    if let Some(d) = cfg.idle_timeout {
        options = options.idle_timeout(d);
    }
    if let Some(d) = cfg.max_lifetime {
        options = options.max_lifetime(d);
    }
    options
}
