use agnes_core::{AgnesError, Result, adapter::RowRef};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::{Column, Row, TypeInfo, postgres::PgRow};

// Newtype wrapper gives us a local type to impl traits on,
// bypassing the orphan rule (both PostgresRow and serde_json::Map are external).
pub struct PostgresRowRef<'a> {
    pub row: &'a PgRow,
    /// When true, temporal values are returned without a timezone offset
    /// (naive wall-clock ISO-8601) — sidesteps the JS `Date` tz-shift footgun.
    pub strip_tz: bool,
}

/// ISO-8601 without offset, e.g. `2026-07-01T12:00:00.123456`.
const NAIVE_FMT: &str = "%Y-%m-%dT%H:%M:%S%.f";

impl<'a> RowRef<PostgresRowRef<'a>> for PostgresRowRef<'a> {
    fn decode(&self, i: usize, ty: &str) -> Result<serde_json::Value> {
        use serde_json::Value as J;
        let row = self.row;
        let v = match ty {
            "BOOL" => row
                .try_get::<Option<bool>, _>(i)
                .map(|v| v.map(J::Bool).unwrap_or(J::Null)),
            "INT2" => row
                .try_get::<Option<i16>, _>(i)
                .map(|v| v.map(|n| J::Number(n.into())).unwrap_or(J::Null)),
            "INT4" => row
                .try_get::<Option<i32>, _>(i)
                .map(|v| v.map(|n| J::Number(n.into())).unwrap_or(J::Null)),
            "INT8" => row
                .try_get::<Option<i64>, _>(i)
                .map(|v| v.map(|n| J::Number(n.into())).unwrap_or(J::Null)),
            "FLOAT4" => row.try_get::<Option<f32>, _>(i).map(|v| {
                v.and_then(|n| serde_json::Number::from_f64(n as f64))
                    .map(J::Number)
                    .unwrap_or(J::Null)
            }),
            "FLOAT8" => row.try_get::<Option<f64>, _>(i).map(|v| {
                v.and_then(serde_json::Number::from_f64)
                    .map(J::Number)
                    .unwrap_or(J::Null)
            }),
            "JSON" | "JSONB" => row
                .try_get::<Option<serde_json::Value>, _>(i)
                .map(|v| v.unwrap_or(J::Null)),
            "BYTEA" => row.try_get::<Option<Vec<u8>>, _>(i).map(|v| {
                v.map(|b| J::String(B64.encode(b))).unwrap_or(J::Null)
            }),
            "TIMESTAMPTZ" => row.try_get::<Option<DateTime<Utc>>, _>(i).map(|v| {
                v.map(|dt| {
                    J::String(if self.strip_tz {
                        dt.naive_utc().format(NAIVE_FMT).to_string()
                    } else {
                        dt.to_rfc3339()
                    })
                })
                .unwrap_or(J::Null)
            }),
            "TIMESTAMP" => row.try_get::<Option<NaiveDateTime>, _>(i).map(|v| {
                v.map(|dt| J::String(dt.format(NAIVE_FMT).to_string()))
                    .unwrap_or(J::Null)
            }),
            "DATE" => row.try_get::<Option<NaiveDate>, _>(i).map(|v| {
                v.map(|d| J::String(d.format("%Y-%m-%d").to_string()))
                    .unwrap_or(J::Null)
            }),
            "TIME" | "TIMETZ" => row.try_get::<Option<NaiveTime>, _>(i).map(|v| {
                v.map(|t| J::String(t.format("%H:%M:%S%.f").to_string()))
                    .unwrap_or(J::Null)
            }),
            // Unknown type (PostGIS geometry, enums, arrays, NUMERIC, …).
            // Try text first; if the type isn't text-compatible, fall back to
            // raw bytes instead of hard-failing the whole row.
            _ => match row.try_get::<Option<String>, _>(i) {
                Ok(v) => Ok(v.map(J::String).unwrap_or(J::Null)),
                Err(_) => match row.try_get_raw(i) {
                    Ok(raw) => {
                        use sqlx::ValueRef;
                        if raw.is_null() {
                            Ok(J::Null)
                        } else {
                            let bytes = raw.as_bytes().unwrap_or(&[]);
                            // Many custom types arrive text-encoded on the wire
                            // (PostGIS geometry as WKT, citext, unknown enums…).
                            // Prefer a UTF-8 string; fall back to a byte array
                            // only for genuinely binary payloads.
                            match std::str::from_utf8(bytes) {
                                Ok(s) => Ok(J::String(s.to_string())),
                                Err(_) => Ok(J::String(B64.encode(bytes))),
                            }
                        }
                    }
                    Err(e) => Err(e),
                },
            },
        };
        v.map_err(|e| AgnesError::Adapter(e.to_string()))
    }
}

impl<'a> TryFrom<PostgresRowRef<'a>> for serde_json::Map<String, serde_json::Value> {
    type Error = AgnesError;

    fn try_from(r: PostgresRowRef<'a>) -> Result<Self> {
        let row = r.row;
        let cols = row.columns();
        let mut out = serde_json::Map::with_capacity(cols.len());
        for (i, col) in cols.iter().enumerate() {
            let name = col.name().to_string();
            let ty = col.type_info().name();
            out.insert(name, r.decode(i, ty)?);
        }
        Ok(out)
    }
}
