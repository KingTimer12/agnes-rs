"""Query builders and operators — mirrors agnes-library/src/query/builder.ts."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .schema import Column, ManyRelation, OneRelation, TableEntry

Dialect = str  # "postgres" | "mysql" | "sqlite"


def placeholder(dialect: Dialect, n: int) -> str:
    return f"${n}" if dialect == "postgres" else "?"


def ident(dialect: Dialect, name: str) -> str:
    def q(part: str) -> str:
        return f"`{part}`" if dialect == "mysql" else f'"{part}"'

    # Qualified table refs ("schema.table") quote each part separately.
    return ".".join(q(p) for p in name.split(".")) if "." in name else q(name)


Condition = Dict[str, Any]  # {"col": str, "op": str, "value": Any}


def eq(col: Column, value: Any) -> Condition:
    return {"col": col.name, "op": "=", "value": value}


def neq(col: Column, value: Any) -> Condition:
    return {"col": col.name, "op": "!=", "value": value}


def gt(col: Column, value: Any) -> Condition:
    return {"col": col.name, "op": ">", "value": value}


def gte(col: Column, value: Any) -> Condition:
    return {"col": col.name, "op": ">=", "value": value}


def lt(col: Column, value: Any) -> Condition:
    return {"col": col.name, "op": "<", "value": value}


def lte(col: Column, value: Any) -> Condition:
    return {"col": col.name, "op": "<=", "value": value}


def like(col: Column, value: str) -> Condition:
    return {"col": col.name, "op": "like", "value": value}


def _build_where(dialect: Dialect, conds: List[Condition], params: List[Any]) -> str:
    if not conds:
        return ""
    parts = []
    for c in conds:
        params.append(c["value"])
        parts.append(f"{ident(dialect, c['col'])} {c['op']} {placeholder(dialect, len(params))}")
    return " WHERE " + " AND ".join(parts)


# ── RelationQuery (nested include: 2 queries + in-memory merge) ─────────────────
class RelationQuery:
    def __init__(self) -> None:
        self._join_type = "left"  # "left" | "inner"
        self._conds: List[Condition] = []
        self._order_by_col: Optional[str] = None
        self._order_dir = "asc"
        self._limit_n: Optional[int] = None
        self._select_cols: Optional[List[str]] = None

    def type(self, t: str) -> "RelationQuery":
        self._join_type = t
        return self

    def where(self, *cs: Condition) -> "RelationQuery":
        self._conds.extend(cs)
        return self

    def order_by(self, col: Column, direction: str = "asc") -> "RelationQuery":
        self._order_by_col = col.name
        self._order_dir = direction
        return self

    def limit(self, n: int) -> "RelationQuery":
        self._limit_n = n
        return self

    def select(self, *cols: Column) -> "RelationQuery":
        self._select_cols = [c.name for c in cols]
        return self


def query() -> RelationQuery:
    return RelationQuery()


def on(main_col: Column, joined_col: Column) -> Tuple[Column, Column]:
    return (main_col, joined_col)


# ── SelectBuilder ────────────────────────────────────────────────────────────
class SelectBuilder:
    def __init__(self, db, table_name: str, definition, dialect: Dialect, schema) -> None:
        self._db = db
        self._table_name = table_name
        self._def = definition
        self._dialect = dialect
        self._schema = schema
        self._conds: List[Condition] = []
        self._limit_n: Optional[int] = None
        self._order_by_col: Optional[str] = None
        self._order_dir = "asc"
        self._opts: Dict[str, Any] = {}
        self._includes: Dict[str, Any] = {}
        self._joins: List[Dict[str, Any]] = []

    def where(self, *cs: Condition) -> "SelectBuilder":
        self._conds.extend(cs)
        return self

    def order_by(self, col: Column, direction: str = "asc") -> "SelectBuilder":
        self._order_by_col = col.name
        self._order_dir = direction
        return self

    def limit(self, n: int) -> "SelectBuilder":
        self._limit_n = n
        return self

    def ttl(self, secs: int) -> "SelectBuilder":
        self._opts["ttl"] = secs
        return self

    def bypass_cache(self) -> "SelectBuilder":
        self._opts["bypass_cache"] = True
        return self

    def include(self, rels: Dict[str, Any]) -> "SelectBuilder":
        self._includes.update(rels)
        return self

    def _join(self, kind: str, tbl: str, condition: Tuple[Column, Column]) -> "SelectBuilder":
        self._joins.append(
            {"type": kind, "table": tbl, "left": condition[0].name, "right": condition[1].name}
        )
        return self

    def left_join(self, tbl: str, condition: Tuple[Column, Column]) -> "SelectBuilder":
        return self._join("left", tbl, condition)

    def inner_join(self, tbl: str, condition: Tuple[Column, Column]) -> "SelectBuilder":
        return self._join("inner", tbl, condition)

    def right_join(self, tbl: str, condition: Tuple[Column, Column]) -> "SelectBuilder":
        return self._join("right", tbl, condition)

    def full_join(self, tbl: str, condition: Tuple[Column, Column]) -> "SelectBuilder":
        return self._join("full", tbl, condition)

    def build(self) -> Tuple[str, List[Any]]:
        params: List[Any] = []
        d = self._dialect
        sql = f"SELECT * FROM {ident(d, self._table_name)}"
        for j in self._joins:
            keyword = "FULL OUTER" if j["type"] == "full" else j["type"].upper()
            entry = self._schema.get(j["table"])
            join_table = entry.table_name if isinstance(entry, TableEntry) else j["table"]
            sql += f" {keyword} JOIN {ident(d, join_table)}"
            sql += f" ON {ident(d, self._table_name)}.{ident(d, j['left'])}"
            sql += f" = {ident(d, join_table)}.{ident(d, j['right'])}"
        sql += _build_where(d, self._conds, params)
        if self._order_by_col:
            sql += f" ORDER BY {ident(d, self._order_by_col)} {self._order_dir.upper()}"
        if self._limit_n is not None:
            sql += f" LIMIT {self._limit_n}"
        return sql, params

    def all(self) -> List[Dict[str, Any]]:
        sql, params = self.build()
        rows = self._db.query(sql, params, self._opts or None)
        return self._resolve_includes(rows)

    def first(self) -> Optional[Dict[str, Any]]:
        self.limit(1)
        rows = self.all()
        return rows[0] if rows else None

    # ── include resolution ────────────────────────────────────────────────────
    def _resolve_includes(self, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        active = [(k, v) for k, v in self._includes.items() if v is not None and v is not False]
        if not rows or not active:
            return rows

        parent_pk = "id"
        for key, field in self._def.items():
            if isinstance(field, Column) and field.flags.get("primary"):
                parent_pk = field.name
                break

        result = rows
        for rel_key, inc in active:
            rel = self._def.get(rel_key)
            rq = inc if isinstance(inc, RelationQuery) else RelationQuery()
            if isinstance(rel, ManyRelation):
                result = self._resolve_many(result, rel_key, rel, parent_pk, rq)
            elif isinstance(rel, OneRelation):
                result = self._resolve_one(result, rel_key, rel, rq)
        return result

    def _resolve_many(self, rows, rel_key, rel: ManyRelation, parent_pk, rq: RelationQuery):
        d = self._dialect
        target = self._schema.get(rel.target)
        if not isinstance(target, TableEntry):
            return rows
        fk_field = target.definition.get(rel.foreign_key)
        if not isinstance(fk_field, Column):
            return rows
        fk_col = fk_field.name

        parent_ids = list({r[parent_pk] for r in rows if r.get(parent_pk) is not None})
        if not parent_ids:
            if rq._join_type == "inner":
                return []
            return [{**r, rel_key: []} for r in rows]

        params: List[Any] = list(parent_ids)
        ph = ", ".join(placeholder(d, i + 1) for i in range(len(parent_ids)))
        if rq._select_cols:
            cols = list(dict.fromkeys([*rq._select_cols, fk_col]))
            select_list = ", ".join(ident(d, c) for c in cols)
        else:
            select_list = "*"

        base_where = f"{ident(d, fk_col)} IN ({ph})"
        for cond in rq._conds:
            params.append(cond["value"])
            base_where += f" AND {ident(d, cond['col'])} {cond['op']} {placeholder(d, len(params))}"

        if rq._limit_n is not None:
            order_win = (
                f"ORDER BY {ident(d, rq._order_by_col)} {rq._order_dir.upper()}"
                if rq._order_by_col
                else ""
            )
            inner = (
                f"SELECT {select_list}, ROW_NUMBER() OVER "
                f"(PARTITION BY {ident(d, fk_col)} {order_win}) AS _agnes_rn "
                f"FROM {ident(d, target.table_name)} WHERE {base_where}"
            )
            sql = f"SELECT * FROM ({inner}) WHERE _agnes_rn <= {rq._limit_n}"
        else:
            sql = f"SELECT {select_list} FROM {ident(d, target.table_name)} WHERE {base_where}"
            if rq._order_by_col:
                sql += f" ORDER BY {ident(d, rq._order_by_col)} {rq._order_dir.upper()}"

        children = self._db.query(sql, params, None)
        if rq._limit_n is not None:
            for row in children:
                row.pop("_agnes_rn", None)

        grouped: Dict[Any, List[Dict[str, Any]]] = {}
        for child in children:
            grouped.setdefault(child[fk_col], []).append(child)

        out = [{**r, rel_key: grouped.get(r[parent_pk], [])} for r in rows]
        if rq._join_type == "inner":
            out = [r for r in out if len(r[rel_key]) > 0]
        return out

    def _resolve_one(self, rows, rel_key, rel: OneRelation, rq: RelationQuery):
        d = self._dialect
        local_field = self._def.get(rel.local_key)
        if not isinstance(local_field, Column):
            return rows
        local_col = local_field.name

        target = self._schema.get(rel.target)
        if not isinstance(target, TableEntry):
            return rows
        target_field = target.definition.get(rel.target_key)
        if not isinstance(target_field, Column):
            return rows
        target_col = target_field.name

        fk_values = list({r[local_col] for r in rows if r.get(local_col) is not None})
        if not fk_values:
            if rq._join_type == "inner":
                return []
            return [{**r, rel_key: None} for r in rows]

        params: List[Any] = list(fk_values)
        ph = ", ".join(placeholder(d, i + 1) for i in range(len(fk_values)))
        select_list = ", ".join(ident(d, c) for c in rq._select_cols) if rq._select_cols else "*"
        sql = f"SELECT {select_list} FROM {ident(d, target.table_name)}"
        sql += f" WHERE {ident(d, target_col)} IN ({ph})"
        for cond in rq._conds:
            params.append(cond["value"])
            sql += f" AND {ident(d, cond['col'])} {cond['op']} {placeholder(d, len(params))}"
        if rq._order_by_col:
            sql += f" ORDER BY {ident(d, rq._order_by_col)} {rq._order_dir.upper()}"

        target_rows = self._db.query(sql, params, None)
        target_map = {tr[target_col]: tr for tr in target_rows}

        out = [{**r, rel_key: target_map.get(r[local_col])} for r in rows]
        if rq._join_type == "inner":
            out = [r for r in out if r[rel_key] is not None]
        return out


# ── Insert / Update / Delete ────────────────────────────────────────────────────
def _phys(definition, key: str) -> str:
    field = definition.get(key)
    return field.name if isinstance(field, Column) else key


class InsertBuilder:
    def __init__(self, db, table_name: str, definition, dialect: Dialect) -> None:
        self._db = db
        self._table_name = table_name
        self._def = definition
        self._dialect = dialect

    def values(self, row: Dict[str, Any]) -> int:
        d = self._dialect
        cols = [_phys(self._def, k) for k in row]
        params = list(row.values())
        ph = ", ".join(placeholder(d, i + 1) for i in range(len(params)))
        sql = (
            f"INSERT INTO {ident(d, self._table_name)} "
            f"({', '.join(ident(d, c) for c in cols)}) VALUES ({ph})"
        )
        return self._db.mutate(sql, params)


class UpdateBuilder:
    def __init__(self, db, table_name: str, definition, patch: Dict[str, Any], dialect: Dialect):
        self._db = db
        self._table_name = table_name
        self._def = definition
        self._patch = patch
        self._dialect = dialect
        self._conds: List[Condition] = []

    def where(self, *cs: Condition) -> "UpdateBuilder":
        self._conds.extend(cs)
        return self

    def run(self) -> int:
        d = self._dialect
        params: List[Any] = []
        set_parts = []
        for k, v in self._patch.items():
            params.append(v)
            set_parts.append(f"{ident(d, _phys(self._def, k))} = {placeholder(d, len(params))}")
        sql = f"UPDATE {ident(d, self._table_name)} SET {', '.join(set_parts)}"
        sql += _build_where(d, self._conds, params)
        return self._db.mutate(sql, params)


class DeleteBuilder:
    def __init__(self, db, table_name: str, definition, dialect: Dialect) -> None:
        self._db = db
        self._table_name = table_name
        self._def = definition
        self._dialect = dialect
        self._conds: List[Condition] = []

    def where(self, *cs: Condition) -> "DeleteBuilder":
        self._conds.extend(cs)
        return self

    def run(self) -> int:
        d = self._dialect
        params: List[Any] = []
        sql = f"DELETE FROM {ident(d, self._table_name)}"
        sql += _build_where(d, self._conds, params)
        return self._db.mutate(sql, params)
