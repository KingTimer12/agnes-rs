# agnes (Python)

Python port of [`agnes-library`](../agnes-library) — a type-hinted database
toolkit with a **Rust core** (pool, SQL parser, self-invalidating cache) exposed
via [PyO3](https://pyo3.rs). Same schema DSL, query builder, relations and cache
as the TypeScript version; **synchronous** API.

## Install

```bash
pip install agnes-library      # imports as `agnes`
```

Build from source (needs Rust + [maturin](https://www.maturin.rs)):

```bash
cd agnes-py && maturin develop --release
```

## Schema

`table(def, "physical_name")`. Columns: `int_, bigint, text, bool_, float_, bytes_, json_`
(trailing `_` avoids shadowing builtins). Modifiers: `.primary()`, `.nullable()`,
`.default(v)`, `.autoincrement()`, `.index("n")`, `.unique_index("n")`.
Relations: `one(target, local_key, target_key, OnAction, OnAction)`, `many(target, fk)`.

```python
from agnes import table, int_, text, bool_, one, many, OnAction

schema = {
    "user": table({
        "id": int_("id").primary().autoincrement(),
        "name": text("name").index("name_idx"),
        "email": text("email").unique_index("email_idx"),
        "active": bool_("active").default(True),
        "posts": many("post", "userId"),
    }, "users"),
    "post": table({
        "id": int_("id").primary().autoincrement(),
        "userId": int_("user_id"),
        "user": one("user", "userId", "id", OnAction.NONE, OnAction.CASCADE),
    }, "posts"),
}
```

Grouped (multi-schema) form flattens to a dotted key you select by — the
relation `target` must use that dotted key:

```python
schema = {"legislativo": {"etapas": table({...}, "legislativo.etapas")}}
# db.select("legislativo.etapas"); many("legislativo.etapas", "...")
```

## Client

```python
from agnes import AgnesClient, eq, gt, query

db = AgnesClient.create(
    {
        "driver": "postgres",            # "postgres" | "mysql" | "sqlite"
        "url": "postgres://user:pass@host/db",
        # connection pool tuning (all optional):
        "max_connections": 10,           # hard cap (default 10)
        "min_connections": 0,            # kept warm while idle (default 0)
        "acquire_timeout_secs": 30,      # wait for a free connection
        "idle_timeout_secs": 600,        # close after this idle time
        "max_lifetime_secs": 1800,       # recycle after this lifetime
        "strip_timezone": True,          # optional: timestamps as naive ISO (no offset)
        "cache": {"enabled": True, "wal_path": ".agnes/cache.wal"},
    },
    schema,
)

U = db._schema["user"].c            # column accessor: U.age, U["age"]

rows = (db.select("user")
          .where(gt(U.age, 18), eq(U.active, True))
          .order_by(U.name, "asc")
          .limit(50)
          .ttl(60)                  # cache 60s, auto-invalidated on write
          .all())

with_posts = db.select("user").include({"posts": query().limit(3)}).all()

db.insert_into("user").values({"name": "Ana", "age": 30})
db.update("user", {"active": False}).where(eq(U.id, 1)).run()
db.delete_from("post").where(eq(db._schema["post"].c.id, 2)).run()

# raw SQL fallback
db.query("SELECT * FROM users WHERE age > $1", [18], {"ttl": 30})
db.mutate("UPDATE users SET active = $1 WHERE id = $2", [False, 1])
```

## Transactions

Interactive transactions, Prisma-style. `db.transaction(fn)` calls `fn(tx)` with
the same query API on one connection; commits when it returns, rolls back and
re-raises if it raises.

```python
def transfer(tx):
    tx.update("account", {"balance": 60}).where(eq(acc.id, 1)).run()
    tx.update("account", {"balance": 40}).where(eq(acc.id, 2)).run()
    # raise here → both updates roll back

db.transaction(transfer)
```

Operators: `eq, neq, gt, gte, lt, lte, like`. `query()` (for `include`) has
`.where`, `.order_by`, `.limit`, `.select(*cols)`, `.type("left"|"inner")`.
SQL joins: `.left_join/.inner_join/.right_join/.full_join("tbl", on(a, b))`.
