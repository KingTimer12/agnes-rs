use sqlparser::ast::{Delete, FromTable, Insert, SetExpr, Statement, TableFactor, TableWithJoins};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

use crate::error::{AgnesError, Result};
use crate::types::{ParsedQuery, QueryKind};

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
}
