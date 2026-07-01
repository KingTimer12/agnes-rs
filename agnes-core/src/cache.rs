use async_trait::async_trait;

use crate::error::Result;

#[async_trait]
pub trait CacheBackend: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    async fn set(
        &self,
        key: &str,
        value: Vec<u8>,
        ttl_secs: Option<u64>,
        tags: &[String],
    ) -> Result<()>;
    async fn invalidate_tags(&self, tags: &[String]) -> Result<()>;
    async fn delete(&self, key: &str) -> Result<()>;
}
