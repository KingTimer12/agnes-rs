use std::collections::HashSet;
use std::sync::Arc;

use crate::adapter::{DatabaseAdapter, DbTransaction};
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

        if let Some(cache) = &self.cache
            && !opts.bypass_cache
            && parsed.kind == QueryKind::Select
            && let Some(bytes) = cache.get(&key).await?
            && let Ok(rows) = serde_json::from_slice::<Rows>(&bytes)
        {
            return Ok(rows);
        }

        let rows = self.adapter.query(sql, params).await?;

        if let Some(cache) = &self.cache
            && !opts.bypass_cache
            && parsed.kind == QueryKind::Select
        {
            let tags: Vec<String> = parsed.tables.iter().map(|t| tag_for_table(t)).collect();
            let bytes = serde_json::to_vec(&rows)?;
            cache.set(&key, bytes, opts.ttl_secs, &tags).await?;
        }

        Ok(rows)
    }

    pub async fn mutate(&self, sql: &str, params: &[Value]) -> Result<u64> {
        let parsed = parse(sql)?;
        let affected = self.adapter.execute(sql, params).await?;

        if let Some(cache) = &self.cache
            && parsed.kind.is_mutation()
            && !parsed.tables.is_empty()
        {
            let tags: Vec<String> = parsed.tables.iter().map(|t| tag_for_table(t)).collect();
            cache.invalidate_tags(&tags).await?;
        }
        Ok(affected)
    }

    /// Stream a query row-by-row (constant memory). Bypasses the cache — a
    /// streamed result is never cached or served from cache.
    pub fn stream(&self, sql: &str, params: &[Value]) -> crate::stream::RowStream {
        self.adapter.stream(sql, params)
    }

    /// Open an interactive transaction on a dedicated connection.
    pub async fn begin(&self) -> Result<Transaction> {
        Ok(Transaction {
            inner: self.adapter.begin().await?,
            cache: self.cache.clone(),
            tags: HashSet::new(),
        })
    }
}

/// An interactive transaction. Reads always hit the DB (never the cache) for
/// read-your-writes consistency; mutations accumulate cache tags that are
/// invalidated once — on `commit`.
pub struct Transaction {
    inner: Box<dyn DbTransaction>,
    cache: Option<Arc<dyn CacheBackend>>,
    tags: HashSet<String>,
}

impl Transaction {
    pub async fn query(&mut self, sql: &str, params: &[Value]) -> Result<Rows> {
        self.inner.query(sql, params).await
    }

    pub async fn mutate(&mut self, sql: &str, params: &[Value]) -> Result<u64> {
        let parsed = parse(sql)?;
        let affected = self.inner.execute(sql, params).await?;
        if parsed.kind.is_mutation() {
            for t in &parsed.tables {
                self.tags.insert(tag_for_table(t));
            }
        }
        Ok(affected)
    }

    pub async fn commit(self) -> Result<()> {
        let Transaction { inner, cache, tags } = self;
        inner.commit().await?;
        if let Some(cache) = &cache
            && !tags.is_empty()
        {
            let tags: Vec<String> = tags.into_iter().collect();
            cache.invalidate_tags(&tags).await?;
        }
        Ok(())
    }

    pub async fn rollback(self) -> Result<()> {
        self.inner.rollback().await
    }
}
