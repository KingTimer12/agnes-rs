"""AgnesClient — mirrors agnes-library/src/client.ts."""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, TypeVar

from ._native import Database
from .query import DeleteBuilder, InsertBuilder, SelectBuilder, UpdateBuilder
from .schema import Schema, TableEntry, flatten_schema

T = TypeVar("T")


class _ClientBase:
    """Query surface shared by the client and a transaction."""

    def __init__(self, runner, schema: Dict[str, TableEntry], dialect: str) -> None:
        self._runner = runner
        self._schema = schema
        self._dialect = dialect

    def _entry(self, table: str) -> TableEntry:
        entry = self._schema.get(table)
        if not isinstance(entry, TableEntry):
            raise KeyError(f"unknown table {table!r}")
        return entry

    def select(self, table: str) -> SelectBuilder:
        e = self._entry(table)
        return SelectBuilder(self._runner, e.table_name, e.definition, self._dialect, self._schema)

    def insert_into(self, table: str) -> InsertBuilder:
        e = self._entry(table)
        return InsertBuilder(self._runner, e.table_name, e.definition, self._dialect)

    def update(self, table: str, patch: Dict[str, Any]) -> UpdateBuilder:
        e = self._entry(table)
        return UpdateBuilder(self._runner, e.table_name, e.definition, patch, self._dialect)

    def delete_from(self, table: str) -> DeleteBuilder:
        e = self._entry(table)
        return DeleteBuilder(self._runner, e.table_name, e.definition, self._dialect)

    def query(
        self,
        sql: str,
        params: Optional[List[Any]] = None,
        opts: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        return self._runner.query(sql, params, opts)

    def mutate(self, sql: str, params: Optional[List[Any]] = None) -> int:
        return self._runner.mutate(sql, params)


class TransactionClient(_ClientBase):
    """The transaction handle passed to `db.transaction(lambda tx: ...)`."""


class AgnesClient(_ClientBase):
    def __init__(self, db: Database, schema: Dict[str, TableEntry], dialect: str) -> None:
        super().__init__(db, schema, dialect)
        self._db = db

    @classmethod
    def create(cls, config: Dict[str, Any], schema: Schema) -> "AgnesClient":
        """Connect and wire the client.

        config keys: driver, url, strip_timezone?,
        pool tuning: max_connections?, min_connections?, acquire_timeout_secs?,
        idle_timeout_secs?, max_lifetime_secs?,
        cache?={enabled, wal_path?, compaction_threshold?}
        """
        db = Database.connect(config)
        return cls(db, flatten_schema(schema), config["driver"])

    def transaction(self, fn: Callable[[TransactionClient], T]) -> T:
        """Run `fn` inside a transaction. Commits when it returns; rolls back and
        re-raises if it raises (Prisma-style interactive transaction)."""
        rust_tx = self._db.begin_transaction()
        tx = TransactionClient(rust_tx, self._schema, self._dialect)
        try:
            result = fn(tx)
            rust_tx.commit()
            return result
        except BaseException:
            rust_tx.rollback()
            raise
