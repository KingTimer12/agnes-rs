use agnes_core::types::{Rows, Value};

pub fn js_values_to_params(v: Vec<serde_json::Value>) -> Vec<Value> {
    v.into_iter().map(json_to_value).collect()
}

fn json_to_value(v: serde_json::Value) -> Value {
    match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Int(i)
            } else if let Some(f) = n.as_f64() {
                Value::Float(f)
            } else {
                Value::Null
            }
        }
        serde_json::Value::String(s) => Value::Text(s),
        serde_json::Value::Array(a) => {
            let all_u8 = a
                .iter()
                .all(|x| x.as_u64().map(|n| n <= 255).unwrap_or(false));
            if all_u8 {
                Value::Bytes(a.iter().map(|x| x.as_u64().unwrap() as u8).collect())
            } else {
                Value::Text(serde_json::Value::Array(a).to_string())
            }
        }
        other => Value::Text(other.to_string()),
    }
}

pub fn rows_to_json(rows: Rows) -> serde_json::Value {
    serde_json::Value::Array(rows.into_iter().map(serde_json::Value::Object).collect())
}
