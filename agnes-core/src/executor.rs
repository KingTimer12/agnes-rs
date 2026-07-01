use std::sync::Arc;

use crate::adapter::DatabaseAdapter;
use crate::cache::CacheBackend;
use crate::error::Result;
use crate::key::{cache_key, tag_for_table};
use crate::parser::parse;
use crate::types::{QueryKind, QueryOptions, Rows, Value};

pub struct Executor {
    adapter: Arc<dyn DatabaseAdapter>,
    cache: Option<Arc<dyn CacheBackend>>,
}

impl Executor {
    pub fn new(adapter: Arc<dyn DatabaseAdapter>, cache: Option<Arc<dyn CacheBackend>>) -> Self {
        Self { adapter, cache }
    }

    pub async fn query(&self, sql: &str, params: &[Value], opts: &QueryOptions) -> Result<Rows> {
        let parsed = parse(sql)?;
        let key = opts
            .cache_key
            .clone()
            .unwrap_or_else(|| cache_key(sql, params));

        if let Some(cache) = &self.cache {
            if !opts.bypass_cache && parsed.kind == QueryKind::Select {
                if let Some(bytes) = cache.get(&key).await? {
                    if let Ok(rows) = serde_json::from_slice::<Rows>(&bytes) {
                        return Ok(rows);
                    }
                }
            }
        }

        let rows = self.adapter.query(sql, params).await?;

        if let Some(cache) = &self.cache {
            if !opts.bypass_cache && parsed.kind == QueryKind::Select {
                let tags: Vec<String> = parsed.tables.iter().map(|t| tag_for_table(t)).collect();
                let bytes = serde_json::to_vec(&rows)?;
                cache.set(&key, bytes, opts.ttl_secs, &tags).await?;
            }
        }

        Ok(rows)
    }

    pub async fn mutate(&self, sql: &str, params: &[Value]) -> Result<u64> {
        let parsed = parse(sql)?;
        let affected = self.adapter.execute(sql, params).await?;

        if let Some(cache) = &self.cache {
            if parsed.kind.is_mutation() && !parsed.tables.is_empty() {
                let tags: Vec<String> =
                    parsed.tables.iter().map(|t| tag_for_table(t)).collect();
                cache.invalidate_tags(&tags).await?;
            }
        }
        Ok(affected)
    }
}
