"""Base class shared by every generated protocol model (ADR 0005)."""

from __future__ import annotations

import sys
from typing import Any

from pydantic import BaseModel, ConfigDict, JsonValue, model_validator

if sys.version_info >= (3, 11):
    from typing import Self
else:  # pragma: no cover - exercised only on 3.10
    from typing_extensions import Self


def reject_bool(value: Any) -> Any:
    """Reject booleans where an integer literal is expected (``True == 1`` in Python)."""
    if isinstance(value, bool):
        raise ValueError("a boolean is not an integer")
    return value


class ProtocolModel(BaseModel):
    """Strict, immutable model that matches the TypeScript validator exactly.

    - Unknown fields are rejected (`additionalProperties: false`).
    - No type coercion: `"1"` is not an integer and `true` is not `1`.
    - `null` is never valid. An optional field is omitted, not set to null.
    - Serialization omits fields that were not set, so a round trip preserves absence.
    """

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    @model_validator(mode="before")
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nulls = sorted(str(k) for k, v in data.items() if v is None)
            if nulls:
                raise ValueError(
                    f"null is not allowed (omit the field instead): {', '.join(nulls)}"
                )
        return data

    @classmethod
    def from_json(cls, data: str | bytes) -> Self:
        """Parse and validate one JSON document."""
        return cls.model_validate_json(data)

    def to_json_obj(self) -> dict[str, JsonValue]:
        """Return the JSON-compatible dict, omitting unset optional fields."""
        return self.model_dump(mode="json", exclude_unset=True)

    def to_json(self) -> str:
        """Return compact JSON, omitting unset optional fields."""
        return self.model_dump_json(exclude_unset=True)
