use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use agnes_core::cache::CacheBackend;
use agnes_core::error::{AgnesError, Result};
use async_trait::async_trait;
use parking_lot::Mutex;

use crate::protocolo::{StoredEntry, WalRecord};
use crate::wal::Wal;

#[derive(Debug, Clone)]
pub struct KvConfig {
    pub wal_path: Option<PathBuf>,
    pub compaction_threshold: u64,
}

impl Default for KvConfig {
    fn default() -> Self {
        Self {
            wal_path: None,
            compaction_threshold: 1024,
        }
    }
}

struct Inner {
    map: HashMap<String, StoredEntry>,
    tags: HashMap<String, HashSet<String>>,
    wal: Option<Wal>,
    config: KvConfig,
}

pub struct KvMotor {
    inner: Arc<Mutex<Inner>>,
}

impl KvMotor {
    pub fn new(config: KvConfig) -> Result<Self> {
        let wal = match &config.wal_path {
            Some(p) => Some(Wal::open(p)?),
            None => None,
        };

        let mut inner = Inner {
            map: HashMap::new(),
            tags: HashMap::new(),
            wal,
            config,
        };

        if let Some(w) = &inner.wal {
            let records = w.replay()?;
            for r in records {
                inner.apply(&r, false);
            }
        }

        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
        })
    }

    pub fn in_memory() -> Result<Self> {
        Self::new(KvConfig::default())
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

impl Inner {
    fn apply(&mut self, rec: &WalRecord, log: bool) {
        match rec {
            WalRecord::Set {
                key,
                value,
                tags,
                expires_at,
                written_at,
            } => {
                self.remove_key_from_tags(key);
                for t in tags {
                    self.tags.entry(t.clone()).or_default().insert(key.clone());
                }
                self.map.insert(
                    key.clone(),
                    StoredEntry {
                        value: value.clone(),
                        tags: tags.clone(),
                        expires_at: *expires_at,
                        written_at: *written_at,
                    },
                );
            }
            WalRecord::Delete { key } => {
                self.remove_key_from_tags(key);
                self.map.remove(key);
            }
            WalRecord::InvalidateTag { tag } => {
                if let Some(keys) = self.tags.remove(tag) {
                    for k in keys {
                        self.map.remove(&k);
                    }
                }
            }
        }

        if log && let Some(w) = &mut self.wal {
            let _ = w.append(rec);
            self.maybe_compact();
        }
    }

    fn remove_key_from_tags(&mut self, key: &str) {
        if let Some(entry) = self.map.get(key) {
            for t in &entry.tags {
                if let Some(set) = self.tags.get_mut(t) {
                    set.remove(key);
                    if set.is_empty() {
                        self.tags.remove(t);
                    }
                }
            }
        }
    }

    fn maybe_compact(&mut self) {
        let Some(w) = &mut self.wal else { return };
        if w.entries_written() < self.config.compaction_threshold {
            return;
        }
        let now = KvMotor::now();
        let records: Vec<WalRecord> = self
            .map
            .iter()
            .filter(|(_, e)| !e.is_expired(now))
            .map(|(k, e)| WalRecord::Set {
                key: k.clone(),
                value: e.value.clone(),
                tags: e.tags.clone(),
                expires_at: e.expires_at,
                written_at: e.written_at,
            })
            .collect();
        let _ = w.rewrite(&records);
    }
}

#[async_trait]
impl CacheBackend for KvMotor {
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let inner = self.inner.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || {
            let now = KvMotor::now();
            let mut g = inner.lock();
            let expired = g.map.get(&key).map(|e| e.is_expired(now)).unwrap_or(false);
            if expired {
                g.apply(&WalRecord::Delete { key: key.clone() }, true);
                return Ok(None);
            }
            Ok(g.map.get(&key).map(|e| e.value.clone()))
        })
        .await
        .map_err(|e| AgnesError::Cache(e.to_string()))?
    }

    async fn set(
        &self,
        key: &str,
        value: Vec<u8>,
        ttl_secs: Option<u64>,
        tags: &[String],
    ) -> Result<()> {
        let inner = self.inner.clone();
        let key = key.to_string();
        let tags = tags.to_vec();
        tokio::task::spawn_blocking(move || {
            let now = KvMotor::now();
            let expires_at = ttl_secs.map(|t| now + t);
            let rec = WalRecord::Set {
                key,
                value,
                tags,
                expires_at,
                written_at: now,
            };
            inner.lock().apply(&rec, true);
            Ok::<_, AgnesError>(())
        })
        .await
        .map_err(|e| AgnesError::Cache(e.to_string()))?
    }

    async fn invalidate_tags(&self, tags: &[String]) -> Result<()> {
        let inner = self.inner.clone();
        let tags = tags.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut g = inner.lock();
            for t in tags {
                g.apply(&WalRecord::InvalidateTag { tag: t }, true);
            }
            Ok::<_, AgnesError>(())
        })
        .await
        .map_err(|e| AgnesError::Cache(e.to_string()))?
    }

    async fn delete(&self, key: &str) -> Result<()> {
        let inner = self.inner.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || {
            inner.lock().apply(&WalRecord::Delete { key }, true);
            Ok::<_, AgnesError>(())
        })
        .await
        .map_err(|e| AgnesError::Cache(e.to_string()))?
    }
}
