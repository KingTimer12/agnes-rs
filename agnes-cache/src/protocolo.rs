use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WalRecord {
    Set {
        key: String,
        value: Vec<u8>,
        tags: Vec<String>,
        expires_at: Option<u64>,
        written_at: u64,
    },
    Delete {
        key: String,
    },
    InvalidateTag {
        tag: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredEntry {
    pub value: Vec<u8>,
    pub tags: Vec<String>,
    pub expires_at: Option<u64>,
    pub written_at: u64,
}

impl StoredEntry {
    pub fn is_expired(&self, now_secs: u64) -> bool {
        self.expires_at.is_some_and(|exp| exp <= now_secs)
    }
}
