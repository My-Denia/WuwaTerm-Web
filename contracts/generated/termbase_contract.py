# GENERATED FILE — DO NOT EDIT DIRECTLY.
# Source: contracts/termbase-v1/schema.json (`npm run generate:contracts`).

from __future__ import annotations

from typing import Literal, TypedDict

TERMBASE_FORMAT = "wuwaterm-termbase-v1"
TERMBASE_SCHEMA_VERSION = 1
TERMBASE_DIRECTION_VALUES: tuple[str, ...] = ("en", "zh",)
TermbaseDirection = Literal["en", "zh"]
TERMBASE_KIND_VALUES: tuple[str, ...] = ("community_term", "preferred_term", "do_not_translate",)
TermbaseKind = Literal["community_term", "preferred_term", "do_not_translate"]
TERMBASE_MAX_ENTRIES = 2000
TERMBASE_ID_SCALARS = (1, 64)
TERMBASE_SOURCE_SCALARS = (1, 120)
TERMBASE_TARGET_SCALARS = (1, 160)
TERMBASE_NOTE_SCALARS = (0, 160)


class ContractTermbaseEntryV1(TypedDict):
    id: str
    source: str
    target: str
    direction: TermbaseDirection
    kind: TermbaseKind
    note: str
    updated_at: str


class ContractTermbaseV1(TypedDict):
    format: Literal["wuwaterm-termbase-v1"]
    schema_version: Literal[1]
    updated_at: str
    entries: list[ContractTermbaseEntryV1]
