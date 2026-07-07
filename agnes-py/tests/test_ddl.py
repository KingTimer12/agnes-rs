"""DDL-generation tests — mirror agnes-library/test/ddl.test.ts."""

import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

# Stub the compiled `_native` so importing the package needs no ABI-matched build.
_stub = types.ModuleType("agnes._native")
_stub.Database = object  # type: ignore[attr-defined]
sys.modules.setdefault("agnes._native", _stub)

from agnes.ddl import create_table_sql, generate_schema_ddl  # noqa: E402
from agnes.schema import (  # noqa: E402
    OnAction,
    bool_,
    int_,
    one,
    table,
    text,
)

schema = {
    "user": table(
        {
            "id": int_("id").primary().autoincrement(),
            "email": text("email").unique_index("user_email_idx"),
            "active": bool_("active").default(True),
            "bio": text("bio").nullable(),
        },
        "users",
    ),
    "post": table(
        {
            "id": int_("id").primary().autoincrement(),
            "userId": int_("user_id").index("post_user_idx"),
            "title": text("title"),
            "user": one("user", "userId", "id", OnAction.NONE, OnAction.CASCADE),
        },
        "posts",
    ),
}


def test_pg_user():
    assert create_table_sql("postgres", schema["user"], schema) == (
        'CREATE TABLE IF NOT EXISTS "users" ('
        '"id" SERIAL, "email" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT TRUE, "bio" TEXT, '
        'PRIMARY KEY ("id"))'
    )


def test_pg_fk():
    assert create_table_sql("postgres", schema["post"], schema) == (
        'CREATE TABLE IF NOT EXISTS "posts" ('
        '"id" SERIAL, "user_id" INTEGER NOT NULL, "title" TEXT NOT NULL, '
        'PRIMARY KEY ("id"), '
        'FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE)'
    )


def test_sqlite_inline_pk():
    sql = create_table_sql("sqlite", schema["user"], schema)
    assert '"id" INTEGER PRIMARY KEY AUTOINCREMENT' in sql
    assert "PRIMARY KEY (" not in sql
    assert '"active" INTEGER NOT NULL DEFAULT 1' in sql


def test_mysql():
    sql = create_table_sql("mysql", schema["user"], schema)
    assert "`id` INT AUTO_INCREMENT" in sql
    assert "`active` TINYINT(1) NOT NULL DEFAULT 1" in sql
    assert "PRIMARY KEY (`id`)" in sql


def test_generate_order():
    stmts = generate_schema_ddl("postgres", schema)
    user_i = next(i for i, s in enumerate(stmts) if 'TABLE IF NOT EXISTS "users"' in s)
    post_i = next(i for i, s in enumerate(stmts) if 'TABLE IF NOT EXISTS "posts"' in s)
    assert user_i < post_i
    first_index = next(i for i, s in enumerate(stmts) if "INDEX IF NOT EXISTS" in s)
    assert first_index > post_i
    assert 'CREATE UNIQUE INDEX IF NOT EXISTS "user_email_idx" ON "users" ("email")' in stmts
    assert 'CREATE INDEX IF NOT EXISTS "post_user_idx" ON "posts" ("user_id")' in stmts
