use agnes_core::{AgnesError, Result, adapter::RowRef};
use sqlx::{Column, Row, TypeInfo, ValueRef, sqlite::SqliteRow};

// Newtype wrapper gives us a local type to impl traits on,
// bypassing the orphan rule (both SqliteRow and serde_json::Map are external).
pub struct SqliteRowRef<'a>(pub &'a SqliteRow);

impl<'a> RowRef<SqliteRowRef<'a>> for SqliteRowRef<'a> {
    fn decode(&self, i: usize, _ty: &str) -> Result<serde_json::Value> {
        use serde_json::Value as J;
        let row = self.0;

        let raw = row
            .try_get_raw(i)
            .map_err(|e| AgnesError::Adapter(e.to_string()))?;

        if raw.is_null() {
            return Ok(J::Null);
        }

        // type_info() on the raw value reflects the ACTUAL SQLite storage class of the datum,
        // not the column's declared affinity. This is correct for computed expressions.
        match raw.type_info().name() {
            "INTEGER" | "INT" | "BIGINT" => row
                .try_get::<i64, _>(i)
                .map(|n| J::Number(n.into()))
                .map_err(|e| AgnesError::Adapter(e.to_string())),

            "BOOLEAN" => row
                .try_get::<bool, _>(i)
                .map(|n| J::Bool(n.into()))
                .map_err(|e| AgnesError::Adapter(e.to_string())),

            "REAL" | "FLOAT" | "DOUBLE" => row
                .try_get::<f64, _>(i)
                .map(|f| {
                    serde_json::Number::from_f64(f)
                        .map(J::Number)
                        .unwrap_or(J::Null)
                })
                .map_err(|e| AgnesError::Adapter(e.to_string())),

            "BLOB" => row
                .try_get::<Vec<u8>, _>(i)
                .map(|b| J::Array(b.into_iter().map(|x| J::Number(x.into())).collect()))
                .map_err(|e| AgnesError::Adapter(e.to_string())),

            // TEXT or any unrecognised affinity (e.g. empty string for computed columns)
            _ => row
                .try_get::<String, _>(i)
                .map(J::String)
                .map_err(|e| AgnesError::Adapter(e.to_string())),
        }
    }
}

impl<'a> TryFrom<SqliteRowRef<'a>> for serde_json::Map<String, serde_json::Value> {
    type Error = AgnesError;

    fn try_from(r: SqliteRowRef<'a>) -> Result<Self> {
        let row = r.0;
        let mut out = serde_json::Map::new();
        for (i, col) in row.columns().iter().enumerate() {
            let name = col.name().to_string();
            let ty = col.type_info().name();
            out.insert(name, r.decode(i, ty)?);
        }
        Ok(out)
    }
}
