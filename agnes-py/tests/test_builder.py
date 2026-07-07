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
    SelectBuilder,
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
    def __init__(self):
        self.calls = []

    def query(self, sql, params=None, opts=None):
        self.calls.append((sql, params or []))
        return []

    def mutate(self, sql, params=None):
        return 0


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
