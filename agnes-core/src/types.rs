use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

impl Value {
    pub fn stable_hash_bytes(&self) -> Vec<u8> {
        match self {
            Value::Null => vec![0],
            Value::Bool(b) => vec![1, u8::from(*b)],
            Value::Int(i) => {
                let mut v = vec![2];
                v.extend_from_slice(&i.to_le_bytes());
                v
            }
            Value::Float(f) => {
                let mut v = vec![3];
                v.extend_from_slice(&f.to_le_bytes());
                v
            }
            Value::Text(s) => {
                let mut v = vec![4];
                v.extend_from_slice(s.as_bytes());
                v
            }
            Value::Bytes(b) => {
                let mut v = vec![5];
                v.extend_from_slice(b);
                v
            }
        }
    }
}

pub type Row = serde_json::Map<String, serde_json::Value>;
pub type Rows = Vec<Row>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryKind {
    Select,
    Insert,
    Update,
    Delete,
    Other,
}

impl QueryKind {
    pub fn is_mutation(&self) -> bool {
        matches!(
            self,
            QueryKind::Insert | QueryKind::Update | QueryKind::Delete
        )
    }
}

#[derive(Debug, Clone)]
pub struct ParsedQuery {
    pub kind: QueryKind,
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct QueryOptions {
    pub ttl_secs: Option<u64>,
    pub cache_key: Option<String>,
    pub bypass_cache: bool,
}
