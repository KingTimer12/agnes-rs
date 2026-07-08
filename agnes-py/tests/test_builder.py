"""SQL-generation tests for the query builder (no real DB)."""

import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

# The builder is pure Python; stub the compiled `_native` so importing the
# package doesn't require a matching interpreter ABI build.
_stub = types.ModuleType("agnes._native")
_stub.Database = object  # type: ignore[attr-defined]
sys.modules.setdefault("agnes._native", _stub)

# Import from submodules directly so the test needs no compiled `_native`.
from agnes.query import (  # noqa: E402
    DeleteBuilder,
    InsertBuilder,
    SelectBuilder,
    UpdateBuilder,
    avg,
    between,
    count,
    eq,
    gt,
    ilike,
    in_array,
    is_not_null,
    is_null,
    not_,
    not_in_array,
    or_,
    sum_,
)
from agnes.schema import table, int_, text, float_  # noqa: E402


class FakeRunner:
    def __init__(self, query_result=None):
        self.calls = []
        self.mutations = []
        self.query_result = query_result if query_result is not None else []

    def query(self, sql, params=None, opts=None):
        self.calls.append((sql, params or []))
        return self.query_result

    def mutate(self, sql, params=None):
        self.mutations.append((sql, params or []))
        return 1


order = table(
    {
        "id": int_("id").primary(),
        "userId": int_("user_id"),
        "total": float_("total"),
        "status": text("status"),
        "note": text("note").nullable(),
    },
    "orders",
)
schema = {"order": order}
C = order.definition


def sb(dialect="postgres"):
    return SelectBuilder(FakeRunner(), "orders", C, dialect, schema)


def test_select_star_default():
    assert sb().build()[0] == 'SELECT * FROM "orders"'


def test_select_projection_physical_names():
    b = SelectBuilder(FakeRunner(), "orders", C, "postgres", schema, ["id", "userId"])
    assert b.build()[0] == 'SELECT "id", "user_id" FROM "orders"'


def test_omit_selects_rest():
    b = sb().omit("note", "status")
    assert b.build()[0] == 'SELECT "id", "user_id", "total" FROM "orders"'


def test_limit_offset_and_page():
    sql, _ = sb().order_by(C["id"]).limit(10).offset(20).build()
    assert sql == 'SELECT * FROM "orders" ORDER BY "id" ASC LIMIT 10 OFFSET 20'
    assert sb().page(3, 20).build()[0] == 'SELECT * FROM "orders" LIMIT 20 OFFSET 40'


def test_offset_without_limit_dialect_fallback():
    assert sb().offset(5).build()[0] == 'SELECT * FROM "orders" OFFSET 5'
    assert sb("sqlite").offset(5).build()[0] == 'SELECT * FROM "orders" LIMIT -1 OFFSET 5'
    assert sb("mysql").offset(5).build()[0] == "SELECT * FROM `orders` LIMIT 18446744073709551615 OFFSET 5"


def test_plain_and():
    sql, params = sb().where(eq(C["status"], "paid"), gt(C["total"], 10)).build()
    assert sql == 'SELECT * FROM "orders" WHERE "status" = $1 AND "total" > $2'
    assert params == ["paid", 10]


def test_in_array_and_empty():
    sql, params = sb().where(in_array(C["id"], [1, 2, 3])).build()
    assert sql == 'SELECT * FROM "orders" WHERE "id" IN ($1, $2, $3)'
    assert params == [1, 2, 3]
    assert sb().where(in_array(C["id"], [])).build()[0] == 'SELECT * FROM "orders" WHERE 1 = 0'
    assert sb().where(not_in_array(C["id"], [])).build()[0] == 'SELECT * FROM "orders" WHERE 1 = 1'


def test_null_between_ilike():
    sql, _ = sb().where(is_null(C["note"]), is_not_null(C["status"])).build()
    assert sql == 'SELECT * FROM "orders" WHERE "note" IS NULL AND "status" IS NOT NULL'
    sql, params = sb().where(between(C["total"], 5, 50)).build()
    assert sql == 'SELECT * FROM "orders" WHERE "total" BETWEEN $1 AND $2'
    assert params == [5, 50]
    assert sb().where(ilike(C["status"], "%p%")).build()[0] == 'SELECT * FROM "orders" WHERE "status" ILIKE $1'
    assert (
        sb("mysql").where(ilike(C["status"], "%p%")).build()[0]
        == "SELECT * FROM `orders` WHERE LOWER(`status`) LIKE LOWER(?)"
    )


def test_nested_or_not():
    sql, params = (
        sb()
        .where(eq(C["userId"], 7), or_(in_array(C["status"], ["a", "b"]), is_null(C["status"])), not_(eq(C["total"], 0)))
        .build()
    )
    assert sql == (
        'SELECT * FROM "orders" WHERE "user_id" = $1 AND '
        '("status" IN ($2, $3) OR "status" IS NULL) AND NOT ("total" = $4)'
    )
    assert params == [7, "a", "b", 0]


def test_aggregate():
    runner = FakeRunner()
    b = SelectBuilder(runner, "orders", C, "postgres", schema)
    b.where(gt(C["total"], 0)).group_by(C["userId"]).having(sum_(C["total"]), ">", 100).aggregate(
        {"spent": sum_(C["total"]), "n": count(), "avgTotal": avg(C["total"])}
    )
    assert len(runner.calls) == 1
    sql, params = runner.calls[0]
    assert sql == (
        'SELECT "user_id", SUM("total") AS "spent", COUNT(*) AS "n", AVG("total") AS "avgTotal" '
        'FROM "orders" WHERE "total" > $1 GROUP BY "user_id" HAVING SUM("total") > $2'
    )
    assert params == [0, 100]


def ib(dialect="postgres"):
    r = FakeRunner()
    return r, InsertBuilder(r, "orders", C, dialect)


def test_insert_single():
    r, b = ib()
    n = b.values({"userId": 1, "total": 9})
    assert n == 1
    assert r.mutations[0][0] == 'INSERT INTO "orders" ("user_id", "total") VALUES ($1, $2)'
    assert r.mutations[0][1] == [1, 9]


def test_insert_multi_union_null():
    r, b = ib()
    b.values([{"userId": 1, "total": 9}, {"userId": 2, "status": "new"}])
    assert len(r.mutations) == 1
    sql, params = r.mutations[0]
    assert sql == (
        'INSERT INTO "orders" ("user_id", "total", "status") VALUES ($1, $2, $3), ($4, $5, $6)'
    )
    assert params == [1, 9, None, 2, None, "new"]


def test_upsert_merge_pg():
    r, b = ib()
    b.on_conflict(C["id"]).merge().values({"id": 5, "total": 3, "status": "paid"})
    assert r.mutations[0][0] == (
        'INSERT INTO "orders" ("id", "total", "status") VALUES ($1, $2, $3) '
        'ON CONFLICT ("id") DO UPDATE SET "total" = EXCLUDED."total", "status" = EXCLUDED."status"'
    )


def test_upsert_ignore_and_mysql():
    r, b = ib("sqlite")
    b.on_conflict(C["id"]).ignore().values({"id": 5, "total": 3})
    assert r.mutations[0][0] == (
        'INSERT INTO "orders" ("id", "total") VALUES (?, ?) ON CONFLICT ("id") DO NOTHING'
    )

    r2, b2 = ib("mysql")
    b2.ignore().values({"id": 5, "total": 3})
    assert r2.mutations[0][0] == "INSERT IGNORE INTO `orders` (`id`, `total`) VALUES (?, ?)"

    r3, b3 = ib("mysql")
    b3.on_conflict(C["id"]).merge(C["total"]).values({"id": 5, "total": 3})
    assert r3.mutations[0][0] == (
        "INSERT INTO `orders` (`id`, `total`) VALUES (?, ?) "
        "ON DUPLICATE KEY UPDATE `total` = VALUES(`total`)"
    )


def test_insert_returning():
    r = FakeRunner(query_result=[{"id": 1, "total": 9}])
    b = InsertBuilder(r, "orders", C, "postgres")
    rows = b.returning().values({"userId": 1, "total": 9})
    assert r.calls[0][0] == 'INSERT INTO "orders" ("user_id", "total") VALUES ($1, $2) RETURNING *'
    assert rows == [{"id": 1, "total": 9}]
    assert r.mutations == []


def test_update_delete_returning():
    r = FakeRunner()
    UpdateBuilder(r, "orders", C, {"status": "paid"}, "postgres").where(eq(C["id"], 1)).returning(
        C["id"], C["total"]
    ).run()
    assert r.calls[0][0] == 'UPDATE "orders" SET "status" = $1 WHERE "id" = $2 RETURNING "id", "total"'

    r2 = FakeRunner()
    DeleteBuilder(r2, "orders", C, "postgres").where(eq(C["id"], 1)).returning().run()
    assert r2.calls[0][0] == 'DELETE FROM "orders" WHERE "id" = $1 RETURNING *'


def test_returning_raises_on_mysql():
    r = FakeRunner()
    raised = False
    try:
        DeleteBuilder(r, "orders", C, "mysql").returning().run()
    except ValueError as e:
        raised = "not supported on MySQL" in str(e)
    assert raised


def test_insert_chunks():
    r, b = ib("sqlite")
    n = b.values([{"userId": i} for i in range(950)])
    assert len(r.mutations) == 2  # 900 vars / 1 col = 900 rows per chunk
    assert n == 2
