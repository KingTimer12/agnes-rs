use agnes_core::{AgnesError, Result, adapter::RowRef};
use sqlx::types::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::{Column, Row, TypeInfo, mysql::MySqlRow};

// Newtype wrapper gives us a local type to impl traits on,
// bypassing the orphan rule (both MySqlRow and serde_json::Map are external).
pub struct MySqlRowRef<'a> {
    pub row: &'a MySqlRow,
    /// Reserved for parity with the other adapters; MySQL temporal values are
    /// naive (no offset), so the returned ISO string is already tz-free.
    pub strip_tz: bool,
}

/// ISO-8601 without offset, e.g. `2026-07-01T12:00:00.123456`.
const NAIVE_FMT: &str = "%Y-%m-%dT%H:%M:%S%.f";

impl<'a> RowRef<MySqlRowRef<'a>> for MySqlRowRef<'a> {
    fn decode(&self, i: usize, ty: &str) -> Result<serde_json::Value> {
        use serde_json::Value as J;
        let _ = self.strip_tz;
        let row = self.row;
        let v = match ty {
            "BOOLEAN" | "TINYINT(1)" => row
                .try_get::<Option<bool>, _>(i)
                .map(|v| v.map(J::Bool).unwrap_or(J::Null)),
            "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => row
                .try_get::<Option<i64>, _>(i)
                .map(|v| v.map(|n| J::Number(n.into())).unwrap_or(J::Null)),
            "FLOAT" | "DOUBLE" => row.try_get::<Option<f64>, _>(i).map(|v| {
                v.and_then(serde_json::Number::from_f64)
                    .map(J::Number)
                    .unwrap_or(J::Null)
            }),
            "JSON" => row
                .try_get::<Option<serde_json::Value>, _>(i)
                .map(|v| v.unwrap_or(J::Null)),
            "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" => {
                row.try_get::<Option<Vec<u8>>, _>(i).map(|v| {
                    v.map(|b| J::Array(b.into_iter().map(|x| J::Number(x.into())).collect()))
                        .unwrap_or(J::Null)
                })
            }
            "DATETIME" | "TIMESTAMP" => row.try_get::<Option<NaiveDateTime>, _>(i).map(|v| {
                v.map(|dt| J::String(dt.format(NAIVE_FMT).to_string()))
                    .unwrap_or(J::Null)
            }),
            "DATE" => row.try_get::<Option<NaiveDate>, _>(i).map(|v| {
                v.map(|d| J::String(d.format("%Y-%m-%d").to_string()))
                    .unwrap_or(J::Null)
            }),
            "TIME" => row.try_get::<Option<NaiveTime>, _>(i).map(|v| {
                v.map(|t| J::String(t.format("%H:%M:%S%.f").to_string()))
                    .unwrap_or(J::Null)
            }),
            _ => row
                .try_get::<Option<String>, _>(i)
                .map(|v| v.map(J::String).unwrap_or(J::Null)),
        };
        v.map_err(|e| AgnesError::Adapter(e.to_string()))
    }
}

impl<'a> TryFrom<MySqlRowRef<'a>> for serde_json::Map<String, serde_json::Value> {
    type Error = AgnesError;

    fn try_from(r: MySqlRowRef<'a>) -> Result<Self> {
        let row = r.row;
        let mut out = serde_json::Map::new();
        for (i, col) in row.columns().iter().enumerate() {
            let name = col.name().to_string();
            let ty = col.type_info().name();
            out.insert(name, r.decode(i, ty)?);
        }
        Ok(out)
    }
}
