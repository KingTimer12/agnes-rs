use std::collections::HashMap;
use std::sync::Mutex;

use sqlparser::ast::{Delete, FromTable, Insert, SetExpr, Statement, TableFactor, TableWithJoins};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

use crate::error::{AgnesError, Result};
use crate::types::{ParsedQuery, QueryKind};

/// Memoizes `parse()` results keyed by the exact SQL string. The same SQL is
/// parsed once and reused — a big win on repeated queries and, especially, on
/// cache hits (where parsing was otherwise the dominant cost since the DB round
/// trip is skipped).
///
/// Bounded via two generations: when the `young` map fills, it ages into `old`
/// (dropping the previous `old`), so memory stays ~`2 * cap` and a churn of
/// one-off statements can't evict a stable working set on its own. Parsing runs
/// outside the lock, so a first-time miss never blocks other queries.
pub struct ParseCache {
    inner: Mutex<Segments>,
    cap: usize,
}

#[derive(Default)]
struct Segments {
    young: HashMap<String, ParsedQuery>,
    old: HashMap<String, ParsedQuery>,
}

impl ParseCache {
    pub fn new(cap: usize) -> Self {
        Self {
            inner: Mutex::new(Segments::default()),
            cap: cap.max(1),
        }
    }

    pub fn get_or_parse(&self, sql: &str) -> Result<ParsedQuery> {
        {
            let mut g = self.inner.lock().unwrap();
            if let Some(p) = g.young.get(sql) {
                return Ok(p.clone());
            }
            if let Some(p) = g.old.get(sql).cloned() {
                g.young.insert(sql.to_string(), p.clone()); // promote to young
                return Ok(p);
            }
        }
        // Parse outside the lock: concurrent first-time misses just parse twice,
        // which is harmless and cheaper than serializing every parse.
        let parsed = parse(sql)?;
        let mut g = self.inner.lock().unwrap();
        if g.young.len() >= self.cap {
            let full = std::mem::take(&mut g.young);
            g.old = full;
        }
        g.young.insert(sql.to_string(), parsed.clone());
        Ok(parsed)
    }
}

impl Default for ParseCache {
    fn default() -> Self {
        Self::new(1024)
    }
}

pub fn parse(sql: &str) -> Result<ParsedQuery> {
    let stmts =
        Parser::parse_sql(&GenericDialect, sql).map_err(|e| AgnesError::Parse(e.to_string()))?;
    let stmt = stmts
        .first()
        .ok_or_else(|| AgnesError::Parse("empty statement".into()))?;

    let (kind, tables) = match stmt {
        Statement::Query(q) => (QueryKind::Select, collect_from_set_expr(&q.body)),
        Statement::Insert(i) => (QueryKind::Insert, collect_from_insert(i)),
        Statement::Update { table, .. } => (QueryKind::Update, collect_from_twj(table)),
        Statement::Delete(d) => (QueryKind::Delete, collect_from_delete(d)),
        _ => (QueryKind::Other, Vec::new()),
    };
    Ok(ParsedQuery { kind, tables })
}

fn collect_from_set_expr(body: &SetExpr) -> Vec<String> {
    let mut out = Vec::new();
    match body {
        SetExpr::Select(s) => {
            for twj in &s.from {
                collect_from_twj_into(twj, &mut out);
            }
        }
        SetExpr::Query(q) => out.extend(collect_from_set_expr(&q.body)),
        SetExpr::SetOperation { left, right, .. } => {
            out.extend(collect_from_set_expr(left));
            out.extend(collect_from_set_expr(right));
        }
        _ => {}
    }
    out
}

fn collect_from_twj(twj: &TableWithJoins) -> Vec<String> {
    let mut out = Vec::new();
    collect_from_twj_into(twj, &mut out);
    out
}

fn collect_from_twj_into(twj: &TableWithJoins, out: &mut Vec<String>) {
    collect_from_factor(&twj.relation, out);
    for j in &twj.joins {
        collect_from_factor(&j.relation, out);
    }
}

fn collect_from_factor(f: &TableFactor, out: &mut Vec<String>) {
    if let TableFactor::Table { name, .. } = f {
        out.push(last_ident(name));
    }
}

fn collect_from_insert(i: &Insert) -> Vec<String> {
    vec![last_ident(&i.table_name)]
}

fn collect_from_delete(d: &Delete) -> Vec<String> {
    let mut out = Vec::new();
    match &d.from {
        FromTable::WithFromKeyword(v) | FromTable::WithoutKeyword(v) => {
            for twj in v {
                collect_from_twj_into(twj, &mut out);
            }
        }
    }
    out
}

fn last_ident(name: &sqlparser::ast::ObjectName) -> String {
    name.0
        .last()
        .map(|p| p.value.to_ascii_lowercase())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_tables() {
        let p =
            parse("SELECT * FROM users u JOIN posts p ON p.uid = u.id WHERE u.age > $1").unwrap();
        assert_eq!(p.kind, QueryKind::Select);
        assert!(p.tables.contains(&"users".to_string()));
        assert!(p.tables.contains(&"posts".to_string()));
    }

    #[test]
    fn update_tables() {
        let p = parse("UPDATE users SET age = $1 WHERE id = $2").unwrap();
        assert_eq!(p.kind, QueryKind::Update);
        assert_eq!(p.tables, vec!["users"]);
    }

    #[test]
    fn delete_tables() {
        let p = parse("DELETE FROM users WHERE id = $1").unwrap();
        assert_eq!(p.kind, QueryKind::Delete);
        assert_eq!(p.tables, vec!["users"]);
    }

    #[test]
    fn insert_tables() {
        let p = parse("INSERT INTO users (id, name) VALUES ($1, $2)").unwrap();
        assert_eq!(p.kind, QueryKind::Insert);
        assert_eq!(p.tables, vec!["users"]);
    }

    #[test]
    fn parse_cache_hits_are_equivalent_to_parse() {
        let cache = ParseCache::new(8);
        let sql = "SELECT * FROM users WHERE id = $1";
        let a = cache.get_or_parse(sql).unwrap();
        let b = cache.get_or_parse(sql).unwrap(); // served from cache
        assert_eq!(a.kind, b.kind);
        assert_eq!(a.tables, b.tables);
        assert_eq!(a.kind, parse(sql).unwrap().kind);
    }

    #[test]
    fn parse_cache_survives_generational_eviction() {
        let cache = ParseCache::new(2);
        let stable = "SELECT * FROM users";
        cache.get_or_parse(stable).unwrap();
        // Churn well past capacity to force young→old aging twice.
        for i in 0..10 {
            let sql = format!("INSERT INTO logs (n) VALUES ({i})");
            cache.get_or_parse(&sql).unwrap();
        }
        // Still resolves correctly (from cache or a fresh parse — same result).
        let p = cache.get_or_parse(stable).unwrap();
        assert_eq!(p.kind, QueryKind::Select);
        assert_eq!(p.tables, vec!["users"]);
    }

    #[test]
    fn parse_cache_propagates_parse_errors() {
        let cache = ParseCache::new(4);
        assert!(cache.get_or_parse("NOT VALID SQL @@@").is_err());
    }
}
