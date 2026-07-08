use crate::types::Value;

pub fn cache_key(sql: &str, params: &[Value]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"agnes:v1\n");
    hasher.update(normalize_sql(sql).as_bytes());
    hasher.update(b"\n");
    for (i, p) in params.iter().enumerate() {
        hasher.update(&(i as u32).to_le_bytes());
        hash_value_into(p, &mut hasher);
    }
    let hash = hasher.finalize();
    format!("q:{}", &hash.to_hex()[..32])
}

/// Feed a param's stable byte encoding straight into the hasher — same bytes as
/// the old `stable_hash_bytes()` but without allocating a `Vec` per param.
fn hash_value_into(v: &Value, h: &mut blake3::Hasher) {
    match v {
        Value::Null => {
            h.update(&[0]);
        }
        Value::Bool(b) => {
            h.update(&[1, u8::from(*b)]);
        }
        Value::Int(i) => {
            h.update(&[2]);
            h.update(&i.to_le_bytes());
        }
        Value::Float(f) => {
            h.update(&[3]);
            h.update(&f.to_le_bytes());
        }
        Value::Text(s) => {
            h.update(&[4]);
            h.update(s.as_bytes());
        }
        Value::Bytes(b) => {
            h.update(&[5]);
            h.update(b);
        }
    }
}

pub fn tag_for_table(table: &str) -> String {
    format!("tbl:{}", table.to_ascii_lowercase())
}

fn normalize_sql(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut prev_space = false;
    for c in sql.trim().chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c.to_ascii_lowercase());
            prev_space = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_sql_params_same_key() {
        let a = cache_key("SELECT * FROM users WHERE age > $1", &[Value::Int(18)]);
        let b = cache_key("select  *  from users where age > $1", &[Value::Int(18)]);
        assert_eq!(a, b);
    }

    #[test]
    fn different_params_different_key() {
        let a = cache_key("SELECT 1 WHERE x = $1", &[Value::Int(1)]);
        let b = cache_key("SELECT 1 WHERE x = $1", &[Value::Int(2)]);
        assert_ne!(a, b);
    }
}
