use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgnesError {
    #[error("adapter error: {0}")]
    Adapter(String),
    #[error("cache error: {0}")]
    Cache(String),
    #[error("parse error: {0}")]
    Parse(String),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, AgnesError>;
