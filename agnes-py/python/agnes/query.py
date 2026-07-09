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


# A WHERE predicate is a dict tagged by "kind": a leaf (cmp/in/null/between/
# ilike) or a combinator (not/group). Build leaves with eq/gt/in_array/… and
# nest with and_(...)/or_(...)/not_(...). where(a, b) still means a AND b.
def _returning_clause(dialect: Dialect, returning) -> str:
    """RETURNING clause. Raises on MySQL, which has no RETURNING."""
    if not returning:
        return ""
    if dialect == "mysql":
        raise ValueError("RETURNING is not supported on MySQL; use a follow-up SELECT instead")
    cols = "*" if returning == "*" else ", ".join(ident(dialect, c) for c in returning)
    return f" RETURNING {cols}"


Condition = Dict[str, Any]


def eq(col: Column, value: Any) -> Condition:
    return {"kind": "cmp", "col": col.name, "op": "=", "value": value}


def neq(col: Column, value: Any) -> Condition:
    return {"kind": "cmp", "col": col.name, "op": "!=", "value": value}


def gt(col: Column, value: Any) -> Condition:
    return {"kind": "cmp", "col": col.name, "op": ">", "value": value}


def gte(col: Column, value: Any) -> Condition:
    return {"kind": "cmp", "col": col.name, "op": ">=", "value": value}


def lt(col: Column, value: Any) -> Condition:
    return {"kind": "cmp", "col": col.name, "op": "<", "value": value}


def lte(col: Column, value: Any) -> Condition:
    return {"kind": "cmp", "col": col.name, "op": "<=", "value": value}


def like(col: Column, value: str) -> Condition:
    return {"kind": "cmp", "col": col.name, "op": "like", "value": value}


def ilike(col: Column, value: str) -> Condition:
    """Case-insensitive LIKE. Postgres ILIKE; emulated with LOWER() elsewhere."""
    return {"kind": "ilike", "col": col.name, "value": value}


def in_array(col: Column, values: List[Any]) -> Condition:
    """col IN (…). An empty list is always-false (never matches)."""
    return {"kind": "in", "col": col.name, "values": list(values), "negated": False}


def not_in_array(col: Column, values: List[Any]) -> Condition:
    """col NOT IN (…). An empty list is always-true (matches every row)."""
    return {"kind": "in", "col": col.name, "values": list(values), "negated": True}


def is_null(col: Column) -> Condition:
    return {"kind": "null", "col": col.name, "negated": False}


def is_not_null(col: Column) -> Condition:
    return {"kind": "null", "col": col.name, "negated": True}


def between(col: Column, lo: Any, hi: Any) -> Condition:
    return {"kind": "between", "col": col.name, "lo": lo, "hi": hi}


def and_(*children: Condition) -> Condition:
    return {"kind": "group", "op": "AND", "children": list(children)}


def or_(*children: Condition) -> Condition:
    return {"kind": "group", "op": "OR", "children": list(children)}


def not_(child: Condition) -> Condition:
    return {"kind": "not", "child": child}


def render_condition(dialect: Dialect, c: Condition, params: List[Any]) -> str:
    """Render one predicate, appending its bound values onto params."""
    kind = c.get("kind", "cmp")
    if kind == "cmp":
        params.append(c["value"])
        return f"{ident(dialect, c['col'])} {c['op']} {placeholder(dialect, len(params))}"
    if kind == "in":
        values = c["values"]
        if not values:
            return "1 = 1" if c["negated"] else "1 = 0"
        phs = []
        for v in values:
            params.append(v)
            phs.append(placeholder(dialect, len(params)))
        op = "NOT IN" if c["negated"] else "IN"
        return f"{ident(dialect, c['col'])} {op} ({', '.join(phs)})"
    if kind == "null":
        neg = "NOT " if c["negated"] else ""
        return f"{ident(dialect, c['col'])} IS {neg}NULL"
    if kind == "between":
        params.append(c["lo"])
        lo = placeholder(dialect, len(params))
        params.append(c["hi"])
        hi = placeholder(dialect, len(params))
        return f"{ident(dialect, c['col'])} BETWEEN {lo} AND {hi}"
    if kind == "ilike":
        params.append(c["value"])
        ph = placeholder(dialect, len(params))
        if dialect == "postgres":
            return f"{ident(dialect, c['col'])} ILIKE {ph}"
        return f"LOWER({ident(dialect, c['col'])}) LIKE LOWER({ph})"
    if kind == "not":
        return f"NOT ({render_condition(dialect, c['child'], params)})"
    if kind == "group":
        children = c["children"]
        if not children:
            return "1 = 1" if c["op"] == "AND" else "1 = 0"
        inner = f" {c['op']} ".join(render_condition(dialect, ch, params) for ch in children)
        return f"({inner})"
    raise ValueError(f"unknown condition kind: {kind!r}")


def _build_where(dialect: Dialect, conds: List[Condition], params: List[Any]) -> str:
    if not conds:
        return ""
    parts = [render_condition(dialect, c, params) for c in conds]
    return " WHERE " + " AND ".join(parts)


def _soft_delete_name(definition) -> Optional[str]:
    """Physical name of the table's soft-delete marker column, if declared."""
    for v in definition.values():
        if getattr(v, "_kind", None) == "column" and v.flags.get("soft_delete"):
            return v.name
    return None


# ── Aggregations ─────────────────────────────────────────────────────────────
Aggregate = Dict[str, Any]  # {"fn": str, "col": str}


def count(col: Optional[Column] = None) -> Aggregate:
    """COUNT(col), or COUNT(*) when called with no column."""
    return {"fn": "count", "col": col.name if col is not None else "*"}


def sum_(col: Column) -> Aggregate:
    return {"fn": "sum", "col": col.name}


def avg(col: Column) -> Aggregate:
    return {"fn": "avg", "col": col.name}


def min_(col: Column) -> Aggregate:
    return {"fn": "min", "col": col.name}


def max_(col: Column) -> Aggregate:
    return {"fn": "max", "col": col.name}


def _render_agg(dialect: Dialect, a: Aggregate) -> str:
    inner = "*" if a["col"] == "*" else ident(dialect, a["col"])
    return f"{a['fn'].upper()}({inner})"


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
    def __init__(self, db, table_name: str, definition, dialect: Dialect, schema, select_keys=None) -> None:
        self._db = db
        self._table_name = table_name
        self._def = definition
        self._dialect = dialect
        self._schema = schema
        self._conds: List[Condition] = []
        self._limit_n: Optional[int] = None
        self._offset_n: Optional[int] = None
        self._order_by_col: Optional[str] = None
        self._order_dir = "asc"
        self._opts: Dict[str, Any] = {}
        self._includes: Dict[str, Any] = {}
        self._joins: List[Dict[str, Any]] = []
        self._group_by: List[str] = []
        self._having: List[Dict[str, Any]] = []
        # Column keys to project (empty = all), set by db.select(*fields).from_().
        self._select_keys: List[str] = list(select_keys or [])
        # Column keys to exclude, set by .omit().
        self._omit_keys: List[str] = []
        # Include soft-deleted rows (skip the <marker> IS NULL filter).
        self._with_deleted = False

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

    def offset(self, n: int) -> "SelectBuilder":
        """Skip the first n rows (pair with limit()/order_by())."""
        self._offset_n = n
        return self

    def page(self, page: int, per_page: int) -> "SelectBuilder":
        """Page through results: page is 1-based, per_page rows each. Sets both
        limit and offset. Use with order_by() for stable ordering."""
        p = max(1, int(page))
        self._limit_n = per_page
        self._offset_n = (p - 1) * per_page
        return self

    def ttl(self, secs: int) -> "SelectBuilder":
        self._opts["ttl"] = secs
        return self

    def bypass_cache(self) -> "SelectBuilder":
        self._opts["bypass_cache"] = True
        return self

    def fresh_read(self) -> "SelectBuilder":
        """Read-your-writes: run on the write master (skips replicas) so replica
        lag can't return stale data just after a write. No-op without replicas."""
        self._opts["read_primary"] = True
        return self

    def include(self, rels: Dict[str, Any]) -> "SelectBuilder":
        self._includes.update(rels)
        return self

    def with_deleted(self) -> "SelectBuilder":
        """Include soft-deleted rows. No-op unless the table declares a
        soft_delete() marker column."""
        self._with_deleted = True
        return self

    def _where_clause(self, params: List[Any]) -> str:
        """WHERE clause including the soft-delete <marker> IS NULL filter (unless
        with_deleted() was called or the table has no marker)."""
        d = self._dialect
        sql = _build_where(d, self._conds, params)
        marker = None if self._with_deleted else _soft_delete_name(self._def)
        if marker:
            pred = f"{ident(d, self._table_name)}.{ident(d, marker)} IS NULL"
            sql += f" AND {pred}" if sql else f" WHERE {pred}"
        return sql

    def omit(self, *cols) -> "SelectBuilder":
        """Exclude columns from the result — everything except these. Saves
        listing every column just to drop one (e.g. a password). Accepts column
        keys (str) or Column handles.

            db.select().from_("user").omit("password").all()
        """
        self._omit_keys.extend(c.name if isinstance(c, Column) else c for c in cols)
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

    def group_by(self, *cols: Column) -> "SelectBuilder":
        """Group aggregate results by these columns (used with .aggregate())."""
        self._group_by.extend(c.name for c in cols)
        return self

    def having(self, agg: Aggregate, op: str, value: Any) -> "SelectBuilder":
        """Filter grouped rows by an aggregate, e.g. .having(sum_(o.total), ">", 100)."""
        self._having.append({"agg": agg, "op": op, "value": value})
        return self

    def _build_joins(self) -> str:
        d = self._dialect
        sql = ""
        for j in self._joins:
            keyword = "FULL OUTER" if j["type"] == "full" else j["type"].upper()
            entry = self._schema.get(j["table"])
            join_table = entry.table_name if isinstance(entry, TableEntry) else j["table"]
            sql += f" {keyword} JOIN {ident(d, join_table)}"
            sql += f" ON {ident(d, self._table_name)}.{ident(d, j['left'])}"
            sql += f" = {ident(d, join_table)}.{ident(d, j['right'])}"
        return sql

    def _column_keys(self) -> List[str]:
        return [k for k, v in self._def.items() if getattr(v, "_kind", None) == "column"]

    def _physical(self, key: str) -> str:
        col = self._def.get(key)
        return col.name if isinstance(col, Column) else key

    def _select_clause(self) -> str:
        if self._select_keys:
            keys = list(self._select_keys)
        elif self._omit_keys:
            keys = [k for k in self._column_keys() if self._physical(k) not in self._omit_keys and k not in self._omit_keys]
        else:
            return "*"
        if self._includes:
            pk = next(
                (k for k in self._column_keys() if getattr(self._def[k], "flags", {}).get("primary")),
                None,
            )
            if pk and pk not in keys:
                keys.append(pk)
        return ", ".join(ident(self._dialect, self._physical(k)) for k in keys)

    def _limit_offset(self) -> str:
        """LIMIT/OFFSET tail. OFFSET needs a LIMIT on MySQL and SQLite, so an
        offset without a limit emits a dialect 'all rows' sentinel."""
        limit_n, offset_n, d = self._limit_n, self._offset_n, self._dialect
        if limit_n is None and offset_n is None:
            return ""
        if offset_n is None:
            return f" LIMIT {limit_n}"
        if limit_n is not None:
            return f" LIMIT {limit_n} OFFSET {offset_n}"
        if d == "postgres":
            return f" OFFSET {offset_n}"
        if d == "mysql":
            return f" LIMIT 18446744073709551615 OFFSET {offset_n}"
        return f" LIMIT -1 OFFSET {offset_n}"  # sqlite

    def build(self) -> Tuple[str, List[Any]]:
        params: List[Any] = []
        d = self._dialect
        sql = f"SELECT {self._select_clause()} FROM {ident(d, self._table_name)}"
        sql += self._build_joins()
        sql += self._where_clause(params)
        if self._order_by_col:
            sql += f" ORDER BY {ident(d, self._order_by_col)} {self._order_dir.upper()}"
        sql += self._limit_offset()
        return sql, params

    def aggregate(self, aggs: Dict[str, Aggregate]) -> List[Dict[str, Any]]:
        """Run an aggregate query. Selects the grouped columns (from group_by())
        plus one column per alias in aggs. Honors where(), having(), order_by()
        and limit().

            db.select("order") \\
              .where(gt(o.total, 0)) \\
              .group_by(o.user_id) \\
              .having(sum_(o.total), ">", 100) \\
              .aggregate({"spent": sum_(o.total), "orders": count()})
        """
        d = self._dialect
        params: List[Any] = []
        select_parts = [ident(d, g) for g in self._group_by]
        select_parts += [f"{_render_agg(d, a)} AS {ident(d, alias)}" for alias, a in aggs.items()]
        sql = f"SELECT {', '.join(select_parts)} FROM {ident(d, self._table_name)}"
        sql += self._build_joins()
        sql += self._where_clause(params)
        if self._group_by:
            sql += " GROUP BY " + ", ".join(ident(d, g) for g in self._group_by)
        if self._having:
            parts = []
            for h in self._having:
                params.append(h["value"])
                parts.append(f"{_render_agg(d, h['agg'])} {h['op']} {placeholder(d, len(params))}")
            sql += " HAVING " + " AND ".join(parts)
        if self._order_by_col:
            sql += f" ORDER BY {ident(d, self._order_by_col)} {self._order_dir.upper()}"
        sql += self._limit_offset()
        return self._db.query(sql, params, self._opts or None)

    def all(self) -> List[Dict[str, Any]]:
        sql, params = self.build()
        rows = self._db.query(sql, params, self._opts or None)
        return self._resolve_includes(rows)

    def first(self) -> Optional[Dict[str, Any]]:
        self.limit(1)
        rows = self.all()
        return rows[0] if rows else None

    def count(self) -> int:
        """Count matching rows — SELECT COUNT(*) honoring where() and joins
        (ignores projection, limit/offset and ordering)."""
        d = self._dialect
        params: List[Any] = []
        sql = f"SELECT COUNT(*) AS {ident(d, 'n')} FROM {ident(d, self._table_name)}"
        sql += self._build_joins()
        sql += self._where_clause(params)
        rows = self._db.query(sql, params, self._opts or None)
        return int(rows[0]["n"]) if rows else 0

    def exists(self) -> bool:
        """Whether any row matches — SELECT 1 ... LIMIT 1, honoring where()/joins."""
        d = self._dialect
        params: List[Any] = []
        sql = f"SELECT 1 FROM {ident(d, self._table_name)}"
        sql += self._build_joins()
        sql += self._where_clause(params)
        sql += " LIMIT 1"
        return len(self._db.query(sql, params, self._opts or None)) > 0

    def stream(self, batch_size: int = 500):
        """Stream the result row-by-row instead of buffering it all — for
        scanning large tables without exhausting memory. The Rust core fetches in
        batches of batch_size behind a bounded channel (server-side cursor on
        Postgres). Not available inside a transaction; incompatible with
        include(). Yields one dict per row.

            for user in db.select("user").where(gt(U.age, 18)).stream():
                process(user)
        """
        stream_fn = getattr(self._db, "stream", None)
        if stream_fn is None:
            raise RuntimeError(
                "streaming is only available on the database, not inside a transaction"
            )
        if self._includes:
            raise RuntimeError("cannot stream a query with include(); relations need the full result set")
        sql, params = self.build()
        handle = stream_fn(sql, params)
        while True:
            batch = handle.next_batch(batch_size)
            if not batch:
                break
            for row in batch:
                yield row

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
            base_where += f" AND {render_condition(d, cond, params)}"

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
            sql += f" AND {render_condition(d, cond, params)}"
        if rq._order_by_col:
            sql += f" ORDER BY {ident(d, rq._order_by_col)} {rq._order_dir.upper()}"

        target_rows = self._db.query(sql, params, None)
        target_map = {tr[target_col]: tr for tr in target_rows}

        out = [{**r, rel_key: target_map.get(r[local_col])} for r in rows]
        if rq._join_type == "inner":
            out = [r for r in out if r[rel_key] is not None]
        return out


class SelectStart:
    """Intermediate returned by db.select(*fields) / db.select() — call .from_(table)
    to pick the table. Fields passed to select() become the projection (none = all
    columns). Chain .omit(...) on the resulting builder to drop columns instead.

        db.select().from_("user").all()                 # all columns
        db.select("name", "email").from_("user").all()  # only these
        db.select().from_("user").omit("password").all()
    """

    def __init__(self, db, dialect: Dialect, schema, fields: List[str]) -> None:
        self._db = db
        self._dialect = dialect
        self._schema = schema
        self._fields = fields

    def from_(self, table: str) -> "SelectBuilder":
        entry = self._schema.get(table)
        if not isinstance(entry, TableEntry):
            raise KeyError(f"unknown table {table!r}")
        return SelectBuilder(
            self._db, entry.table_name, entry.definition, self._dialect, self._schema, self._fields
        )


# ── Insert / Update / Delete ────────────────────────────────────────────────────
def _phys(definition, key: str) -> str:
    field = definition.get(key)
    return field.name if isinstance(field, Column) else key


def _max_vars(dialect: Dialect) -> int:
    # Bound-parameter ceilings; stay conservative (SQLite older builds cap at 999).
    return 900 if dialect == "sqlite" else 60000


class InsertBuilder:
    def __init__(self, db, table_name: str, definition, dialect: Dialect) -> None:
        self._db = db
        self._table_name = table_name
        self._def = definition
        self._dialect = dialect
        self._conflict_cols: Optional[List[str]] = None
        self._mode = "none"  # "none" | "ignore" | "merge"
        self._merge_cols: Optional[List[str]] = None
        self._returning = None  # None | "*" | List[str]

    def returning(self, *cols: Column) -> "InsertBuilder":
        """Return the inserted rows instead of a count (Postgres/SQLite
        RETURNING). No args returns every column. Raises on MySQL."""
        self._returning = [c.name for c in cols] if cols else "*"
        return self

    def on_conflict(self, *cols: Column) -> "InsertBuilder":
        """Conflict target columns (Postgres/SQLite ON CONFLICT (...)). MySQL
        ignores the target and uses its unique keys. Pair with merge()/ignore()."""
        self._conflict_cols = [c.name for c in cols]
        return self

    def ignore(self) -> "InsertBuilder":
        """On conflict, skip the row (DO NOTHING / INSERT IGNORE)."""
        self._mode = "ignore"
        return self

    def merge(self, *cols: Column) -> "InsertBuilder":
        """On conflict, update the row (upsert). No args updates every inserted
        column except the conflict target; otherwise only the given columns."""
        self._mode = "merge"
        if cols:
            self._merge_cols = [c.name for c in cols]
        return self

    def _conflict_clause(self, inserted_cols: List[str]) -> str:
        if self._mode == "none":
            return ""
        d = self._dialect
        conflict_set = set(self._conflict_cols or [])
        update_cols = self._merge_cols or [c for c in inserted_cols if c not in conflict_set]

        if d == "mysql":
            if self._mode == "ignore":
                return ""  # handled by the INSERT IGNORE prefix
            sets = ", ".join(f"{ident(d, c)} = VALUES({ident(d, c)})" for c in update_cols)
            return f" ON DUPLICATE KEY UPDATE {sets}"

        target = (
            f" ({', '.join(ident(d, c) for c in self._conflict_cols)})"
            if self._conflict_cols
            else ""
        )
        if self._mode == "ignore":
            return f" ON CONFLICT{target} DO NOTHING"
        sets = ", ".join(f"{ident(d, c)} = EXCLUDED.{ident(d, c)}" for c in update_cols)
        return f" ON CONFLICT{target} DO UPDATE SET {sets}"

    def _build_statement(self, chunk: List[Dict[str, Any]], col_keys: List[str]):
        d = self._dialect
        phys_cols = [_phys(self._def, k) for k in col_keys]
        params: List[Any] = []
        tuples = []
        for row in chunk:
            phs = []
            for k in col_keys:
                params.append(row.get(k))
                phs.append(placeholder(d, len(params)))
            tuples.append(f"({', '.join(phs)})")
        keyword = "INSERT IGNORE INTO" if d == "mysql" and self._mode == "ignore" else "INSERT INTO"
        sql = (
            f"{keyword} {ident(d, self._table_name)} "
            f"({', '.join(ident(d, c) for c in phys_cols)}) VALUES {', '.join(tuples)}"
        )
        sql += self._conflict_clause(phys_cols)
        sql += _returning_clause(d, self._returning)
        return sql, params

    def values(self, row_or_rows):
        """Insert one row (dict) or many (list of dicts). Multi-row inserts go in
        one statement, chunked to respect the driver's parameter limit. Chunks
        are separate statements — wrap in db.transaction for all-or-nothing.
        Returns total affected rows, or the inserted rows if returning() was set."""
        rows = row_or_rows if isinstance(row_or_rows, list) else [row_or_rows]
        if not rows:
            return [] if self._returning else 0

        # Union of keys across rows, first-seen order. Missing keys insert NULL.
        col_keys: List[str] = []
        seen = set()
        for row in rows:
            for k in row:
                if k not in seen:
                    seen.add(k)
                    col_keys.append(k)
        if not col_keys:
            return [] if self._returning else 0

        rows_per_chunk = max(1, _max_vars(self._dialect) // len(col_keys))

        if self._returning:
            out: List[Dict[str, Any]] = []
            for i in range(0, len(rows), rows_per_chunk):
                sql, params = self._build_statement(rows[i : i + rows_per_chunk], col_keys)
                out.extend(self._db.query(sql, params, None))
            return out

        affected = 0
        for i in range(0, len(rows), rows_per_chunk):
            chunk = rows[i : i + rows_per_chunk]
            sql, params = self._build_statement(chunk, col_keys)
            affected += self._db.mutate(sql, params)
        return affected


class UpdateBuilder:
    def __init__(self, db, table_name: str, definition, patch: Dict[str, Any], dialect: Dialect):
        self._db = db
        self._table_name = table_name
        self._def = definition
        self._patch = patch
        self._dialect = dialect
        self._conds: List[Condition] = []
        self._returning = None

    def where(self, *cs: Condition) -> "UpdateBuilder":
        self._conds.extend(cs)
        return self

    def returning(self, *cols: Column) -> "UpdateBuilder":
        """Return the updated rows instead of a count (Postgres/SQLite
        RETURNING). No args returns every column. Raises on MySQL."""
        self._returning = [c.name for c in cols] if cols else "*"
        return self

    def run(self):
        d = self._dialect
        params: List[Any] = []
        set_parts = []
        for k, v in self._patch.items():
            params.append(v)
            set_parts.append(f"{ident(d, _phys(self._def, k))} = {placeholder(d, len(params))}")
        sql = f"UPDATE {ident(d, self._table_name)} SET {', '.join(set_parts)}"
        sql += _build_where(d, self._conds, params)
        sql += _returning_clause(d, self._returning)
        if self._returning:
            return self._db.query(sql, params, None)
        return self._db.mutate(sql, params)


class DeleteBuilder:
    def __init__(self, db, table_name: str, definition, dialect: Dialect) -> None:
        self._db = db
        self._table_name = table_name
        self._def = definition
        self._dialect = dialect
        self._conds: List[Condition] = []
        self._returning = None
        self._hard = False

    def where(self, *cs: Condition) -> "DeleteBuilder":
        self._conds.extend(cs)
        return self

    def returning(self, *cols: Column) -> "DeleteBuilder":
        """Return the deleted rows instead of a count (Postgres/SQLite
        RETURNING). No args returns every column. Raises on MySQL."""
        self._returning = [c.name for c in cols] if cols else "*"
        return self

    def hard_delete(self) -> "DeleteBuilder":
        """Force a real DELETE even when the table declares a soft_delete()
        marker. No-op for tables without one."""
        self._hard = True
        return self

    def run(self):
        d = self._dialect
        params: List[Any] = []
        marker = None if self._hard else _soft_delete_name(self._def)
        table = ident(d, self._table_name)
        # Soft delete: stamp the marker instead of removing the row. Only touch
        # rows not already deleted so the affected-count reflects real changes.
        if marker:
            sql = f"UPDATE {table} SET {ident(d, marker)} = CURRENT_TIMESTAMP"
        else:
            sql = f"DELETE FROM {table}"
        sql += _build_where(d, self._conds, params)
        if marker:
            pred = f"{ident(d, marker)} IS NULL"
            sql += f" AND {pred}" if self._conds else f" WHERE {pred}"
        sql += _returning_clause(d, self._returning)
        if self._returning:
            return self._db.query(sql, params, None)
        return self._db.mutate(sql, params)
