"""DDL generation — mirrors agnes-library/src/query/ddl.ts.

Idempotent "schema push" (CREATE ... IF NOT EXISTS): creates what's missing but
never alters or drops. Full diff migrations (needing live-DB introspection) are
a later feature.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .schema import Column, OneRelation, TableEntry

Dialect = str  # "postgres" | "mysql" | "sqlite"


def _ident(dialect: Dialect, name: str) -> str:
    def q(part: str) -> str:
        return f"`{part}`" if dialect == "mysql" else f'"{part}"'

    return ".".join(q(p) for p in name.split(".")) if "." in name else q(name)


def _base_type(dialect: Dialect, t: str) -> str:
    if t == "int":
        return "INT" if dialect == "mysql" else "INTEGER"
    if t == "bigint":
        return "INTEGER" if dialect == "sqlite" else "BIGINT"
    if t == "text":
        return "TEXT"
    if t == "bool":
        if dialect == "postgres":
            return "BOOLEAN"
        return "TINYINT(1)" if dialect == "mysql" else "INTEGER"
    if t == "float":
        if dialect == "postgres":
            return "DOUBLE PRECISION"
        return "DOUBLE" if dialect == "mysql" else "REAL"
    if t == "bytes":
        return "BYTEA" if dialect == "postgres" else "BLOB"
    if t == "json":
        if dialect == "postgres":
            return "JSONB"
        return "JSON" if dialect == "mysql" else "TEXT"
    raise ValueError(f"unknown column type: {t!r}")


def _default_literal(dialect: Dialect, v: Any) -> Optional[str]:
    # bool before int/float (Python bool is a subclass of int).
    if isinstance(v, bool):
        if dialect == "postgres":
            return "TRUE" if v else "FALSE"
        return "1" if v else "0"
    if isinstance(v, str):
        escaped = v.replace("'", "''")
        return f"'{escaped}'"
    if isinstance(v, (int, float)):
        return str(v)
    return None


def _column_line(dialect: Dialect, col: Column) -> Dict[str, Any]:
    name = _ident(dialect, col.name)
    auto = col.flags.get("autoincrement") is True
    primary = col.flags.get("primary") is True

    if dialect == "sqlite" and auto and primary:
        return {"sql": f"{name} INTEGER PRIMARY KEY AUTOINCREMENT", "inline_pk": True}

    if auto and dialect == "postgres":
        type_ = "BIGSERIAL" if col.type == "bigint" else "SERIAL"
    elif auto and dialect == "mysql":
        type_ = f"{_base_type(dialect, col.type)} AUTO_INCREMENT"
    else:
        type_ = _base_type(dialect, col.type)

    sql = f"{name} {type_}"
    if not col.flags.get("nullable") and not primary:
        sql += " NOT NULL"
    if "default" in col.flags:
        lit = _default_literal(dialect, col.flags["default"])
        if lit is not None:
            sql += f" DEFAULT {lit}"
    return {"sql": sql, "inline_pk": False}


def create_table_sql(dialect: Dialect, entry: TableEntry, schema: Dict[str, TableEntry]) -> str:
    """CREATE TABLE IF NOT EXISTS for one entry (columns, PK, FKs)."""
    cols: List[str] = []
    pk_cols: List[str] = []
    has_inline_pk = False

    for field in entry.definition.values():
        if isinstance(field, Column):
            line = _column_line(dialect, field)
            cols.append(line["sql"])
            if line["inline_pk"]:
                has_inline_pk = True
            elif field.flags.get("primary"):
                pk_cols.append(_ident(dialect, field.name))

    constraints: List[str] = []
    if not has_inline_pk and pk_cols:
        constraints.append(f"PRIMARY KEY ({', '.join(pk_cols)})")

    for field in entry.definition.values():
        if not isinstance(field, OneRelation):
            continue
        local_col = entry.definition.get(field.local_key)
        target = schema.get(field.target)
        if not isinstance(local_col, Column) or not isinstance(target, TableEntry):
            continue
        target_col = target.definition.get(field.target_key)
        if not isinstance(target_col, Column):
            continue
        on_update = field.on_update.value if hasattr(field.on_update, "value") else field.on_update
        on_delete = field.on_delete.value if hasattr(field.on_delete, "value") else field.on_delete
        constraints.append(
            f"FOREIGN KEY ({_ident(dialect, local_col.name)}) "
            f"REFERENCES {_ident(dialect, target.table_name)} ({_ident(dialect, target_col.name)}) "
            f"ON UPDATE {on_update} ON DELETE {on_delete}"
        )

    body = ", ".join([*cols, *constraints])
    return f"CREATE TABLE IF NOT EXISTS {_ident(dialect, entry.table_name)} ({body})"


def _index_statements(dialect: Dialect, entry: TableEntry) -> List[str]:
    out: List[str] = []
    for field in entry.definition.values():
        if isinstance(field, Column) and field.flags.get("index"):
            idx = field.flags["index"]
            unique = "UNIQUE " if idx["unique"] else ""
            out.append(
                f"CREATE {unique}INDEX IF NOT EXISTS {_ident(dialect, idx['name'])} "
                f"ON {_ident(dialect, entry.table_name)} ({_ident(dialect, field.name)})"
            )
    return out


def _topo_sort(schema: Dict[str, TableEntry]) -> List[str]:
    """Referenced tables (FK targets) before the tables that reference them.
    Best-effort: cycles fall back to declaration order."""
    visited: set = set()
    visiting: set = set()
    order: List[str] = []

    def visit(key: str) -> None:
        if key in visited or key in visiting:
            return
        visiting.add(key)
        entry = schema.get(key)
        if entry is not None:
            for field in entry.definition.values():
                if isinstance(field, OneRelation) and field.target != key and field.target in schema:
                    visit(field.target)
        visiting.discard(key)
        visited.add(key)
        order.append(key)

    for key in schema:
        visit(key)
    return order


def generate_schema_ddl(dialect: Dialect, schema: Dict[str, TableEntry]) -> List[str]:
    """Every CREATE TABLE (dependency-ordered) then every CREATE INDEX. Safe to
    run repeatedly — all use IF NOT EXISTS."""
    tables: List[str] = []
    indexes: List[str] = []
    for key in _topo_sort(schema):
        entry = schema.get(key)
        if entry is None:
            continue
        tables.append(create_table_sql(dialect, entry, schema))
        indexes.extend(_index_statements(dialect, entry))
    return [*tables, *indexes]
