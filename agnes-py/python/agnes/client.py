"""AgnesClient — mirrors agnes-library/src/client.ts."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ._native import Database
from .query import DeleteBuilder, InsertBuilder, SelectBuilder, UpdateBuilder
from .schema import Schema, TableEntry, flatten_schema


class AgnesClient:
    def __init__(self, db: Database, schema: Dict[str, TableEntry], dialect: str) -> None:
        self._db = db
        self._schema = schema
        self._dialect = dialect

    @classmethod
    def create(cls, config: Dict[str, Any], schema: Schema) -> "AgnesClient":
        """Connect and wire the client.

        config keys: driver, url, max_connections?, strip_timezone?,
        cache?={enabled, wal_path?, compaction_threshold?}
        """
        db = Database.connect(config)
        return cls(db, flatten_schema(schema), config["driver"])

    def _entry(self, table: str) -> TableEntry:
        entry = self._schema.get(table)
        if not isinstance(entry, TableEntry):
            raise KeyError(f"unknown table {table!r}")
        return entry

    def select(self, table: str) -> SelectBuilder:
        e = self._entry(table)
        return SelectBuilder(self._db, e.table_name, e.definition, self._dialect, self._schema)

    def insert_into(self, table: str) -> InsertBuilder:
        e = self._entry(table)
        return InsertBuilder(self._db, e.table_name, e.definition, self._dialect)

    def update(self, table: str, patch: Dict[str, Any]) -> UpdateBuilder:
        e = self._entry(table)
        return UpdateBuilder(self._db, e.table_name, e.definition, patch, self._dialect)

    def delete_from(self, table: str) -> DeleteBuilder:
        e = self._entry(table)
        return DeleteBuilder(self._db, e.table_name, e.definition, self._dialect)

    def query(
        self,
        sql: str,
        params: Optional[List[Any]] = None,
        opts: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        return self._db.query(sql, params, opts)

    def mutate(self, sql: str, params: Optional[List[Any]] = None) -> int:
        return self._db.mutate(sql, params)
