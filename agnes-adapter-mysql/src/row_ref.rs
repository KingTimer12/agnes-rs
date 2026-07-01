use agnes_core::{AgnesError, Result, adapter::RowRef};
use sqlx::{Column, Row, TypeInfo, mysql::MySqlRow};

// Newtype wrapper gives us a local type to impl traits on,
// bypassing the orphan rule (both MySqlRow and serde_json::Map are external).
pub struct MySqlRowRef<'a>(pub &'a MySqlRow);

impl<'a> RowRef<MySqlRowRef<'a>> for MySqlRowRef<'a> {
    fn decode(&self, i: usize, ty: &str) -> Result<serde_json::Value> {
        use serde_json::Value as J;
        let row = self.0;
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
