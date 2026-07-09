"""Schema DSL — mirrors agnes-library (TypeScript).

Define tables once; column types, nullability and relations flow through to the
query builder and to `agnes-cli` (push/pull/migrate).
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, Optional, Union

ColumnType = str  # "int" | "bigint" | "text" | "bool" | "float" | "bytes" | "json"


class OnAction(str, Enum):
    NONE = "NO ACTION"
    RESTRICT = "RESTRICT"
    CASCADE = "CASCADE"
    SET_NULL = "SET NULL"
    SET_DEFAULT = "SET DEFAULT"


class Column:
    """A table column. Modifiers are chainable and mutate in place."""

    _kind = "column"

    def __init__(self, name: str, type: ColumnType) -> None:
        self.name = name
        self.type = type
        self.flags: Dict[str, Any] = {}

    def primary(self) -> "Column":
        self.flags["primary"] = True
        return self

    def nullable(self) -> "Column":
        self.flags["nullable"] = True
        return self

    def default(self, value: Any) -> "Column":
        self.flags["default"] = value
        return self

    def autoincrement(self) -> "Column":
        self.flags["autoincrement"] = True
        return self

    def index(self, name: str) -> "Column":
        self.flags["index"] = {"name": name, "unique": False}
        return self

    def unique_index(self, name: str) -> "Column":
        self.flags["index"] = {"name": name, "unique": True}
        return self

    def soft_delete(self) -> "Column":
        """Mark this column as the table's soft-delete marker. Deletes become an
        UPDATE that stamps it (hard_delete() forces a real DELETE); reads
        auto-filter <col> IS NULL (with_deleted() opts out). Implies nullable —
        a null marker means "not deleted". Use a nullable timestamp/text column."""
        self.flags["soft_delete"] = True
        self.flags["nullable"] = True
        return self


# ── Column helpers (trailing underscore where the name shadows a builtin) ──────
def int_(name: str) -> Column:
    return Column(name, "int")


def bigint(name: str) -> Column:
    return Column(name, "bigint")


def text(name: str) -> Column:
    return Column(name, "text")


def bool_(name: str) -> Column:
    return Column(name, "bool")


def float_(name: str) -> Column:
    return Column(name, "float")


def bytes_(name: str) -> Column:
    return Column(name, "bytes")


def json_(name: str) -> Column:
    return Column(name, "json")


# ── Relations ──────────────────────────────────────────────────────────────────
class OneRelation:
    _kind = "one"

    def __init__(
        self,
        target: str,
        local_key: str,
        target_key: str,
        on_update: OnAction = OnAction.NONE,
        on_delete: OnAction = OnAction.NONE,
    ) -> None:
        self.target = target
        self.local_key = local_key
        self.target_key = target_key
        self.on_update = on_update
        self.on_delete = on_delete


class ManyRelation:
    _kind = "many"

    def __init__(self, target: str, foreign_key: str) -> None:
        self.target = target
        self.foreign_key = foreign_key


def one(
    target: str,
    local_key: str,
    target_key: str,
    on_update: OnAction = OnAction.NONE,
    on_delete: OnAction = OnAction.NONE,
) -> OneRelation:
    return OneRelation(target, local_key, target_key, on_update, on_delete)


def many(target: str, foreign_key: str) -> ManyRelation:
    return ManyRelation(target, foreign_key)


Field = Union[Column, OneRelation, ManyRelation]


class _Cols:
    """Attribute/item access to a table's columns for use with operators."""

    def __init__(self, definition: Dict[str, Field]) -> None:
        object.__setattr__(self, "_def", definition)

    def __getattr__(self, key: str) -> Column:
        return self[key]

    def __getitem__(self, key: str) -> Column:
        field = self._def.get(key)  # type: ignore[attr-defined]
        if not isinstance(field, Column):
            raise KeyError(f"{key!r} is not a column")
        return field


class TableEntry:
    def __init__(self, definition: Dict[str, Field], table_name: str) -> None:
        self.definition = definition
        self.table_name = table_name

    @property
    def c(self) -> _Cols:
        """Columns accessor: `entry.c.age` / `entry.c["age"]`."""
        return _Cols(self.definition)


def table(definition: Dict[str, Field], table_name: str) -> TableEntry:
    return TableEntry(definition, table_name)


# Schema may be flat (`{"user": table(...)}`) or grouped by DB schema
# (`{"legislativo": {"etapas": table(...)}}`).
Schema = Dict[str, Union[TableEntry, Dict[str, TableEntry]]]


def flatten_schema(schema: Schema) -> Dict[str, TableEntry]:
    """Collapse grouped entries to dotted keys (`legislativo.etapas`) that match
    each table's physical name and its relation targets."""
    out: Dict[str, TableEntry] = {}
    for key, value in schema.items():
        if isinstance(value, TableEntry):
            out[key] = value
        elif isinstance(value, dict):
            for sub_key, entry in value.items():
                if isinstance(entry, TableEntry):
                    out[f"{key}.{sub_key}"] = entry
    return out
