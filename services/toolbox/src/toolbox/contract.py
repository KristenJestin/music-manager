"""The contract this image implements, reduced to one number and one hash.

This exists because of the failure that opened both MCP test reports and was never actually
*detected* by anything an agent could call. The sequence:

1. a field is added to a model in ``models.py``;
2. the app is rebuilt and starts sending it;
3. the toolbox container is **not** rebuilt, so its pydantic models still forbid it;
4. every call comes back ``422 extra_forbidden`` — and ``GET /health`` cheerfully answers
   ``ok: true`` with four binary versions, because the binaries really are fine.

The staleness was detectable on the host — ``scripts/stack.ts`` compares mtimes — and nowhere
else. So the image now *states* which contract it implements, and the app compares that with
the contract it was generated against. A mismatch is the diagnosis, printed before anything
fails.

**Why not hash the OpenAPI document itself.** The document is serialised on both sides of a
language boundary, and Python escapes non-ASCII where JavaScript does not, so two "identical"
documents hash differently for reasons that have nothing to do with the contract. What is
hashed here is a *canonical projection*: the operations, and every schema's field names,
required set and whether it accepts extras. That is precisely the surface a stale image gets
wrong, and it is stable under reformatting, reordering and prose edits to a docstring.

The value is computed here, in Python, and the TypeScript side never recomputes it — the
generator asks this module for it and writes it into ``packages/contracts/toolbox/contract.ts``.
One implementation, so the two can only ever disagree about a real difference.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Final, cast

__all__ = ["SCHEMA_VERSION", "canonical_lines", "contract_hash"]

#: The shape of the *contract statement itself*, not of the API.
#:
#: Bumped only when `canonical_lines` changes, because two hashes computed by two different
#: algorithms are not comparable and an app that does not know that would report a rebuild
#: that would not help. The app refuses to compare across versions.
SCHEMA_VERSION: Final[int] = 1

#: HTTP methods an OpenAPI path item may carry. Anything else in there is metadata.
_METHODS: Final[frozenset[str]] = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)


def _mapping(value: object) -> Mapping[str, object]:
    """A mapping with string keys, or an empty one. Never a guess about what is inside."""
    if not isinstance(value, Mapping):
        return {}
    items: dict[str, object] = {}
    for key, item in cast(Mapping[object, object], value).items():
        if isinstance(key, str):
            items[key] = item
    return items


def _strings(value: object) -> list[str]:
    """The string elements of a list, sorted. Anything else in there is not a field name."""
    if not isinstance(value, list):
        return []
    return sorted(item for item in cast(list[object], value) if isinstance(item, str))


def canonical_lines(document: Mapping[str, object]) -> list[str]:
    """The contract, as sorted lines — the thing that is hashed.

    One line per operation and one per component schema. Descriptions, examples, titles and
    the document's own version are deliberately absent: rewording a docstring must not look
    like a stale image, or the warning stops being read.
    """
    lines: list[str] = []

    paths = _mapping(document.get("paths"))
    for path in sorted(paths):
        item = _mapping(paths[path])
        for method in sorted(key for key in item if key.lower() in _METHODS):
            operation = _mapping(item[method])
            operation_id = operation.get("operationId")
            lines.append(
                f"{method.upper()} {path} {operation_id if isinstance(operation_id, str) else ''}"
            )

    schemas = _mapping(_mapping(document.get("components")).get("schemas"))
    for name in sorted(schemas):
        schema = _mapping(schemas[name])
        properties = ",".join(sorted(_mapping(schema.get("properties"))))
        required = ",".join(_strings(schema.get("required")))
        # `additionalProperties: false` is exactly what turns a field the caller does not know
        # about into a 422, so it belongs in the hash more than anything else here.
        closed = "closed" if schema.get("additionalProperties") is False else "open"
        lines.append(f"{name}({properties}) required=({required}) {closed}")

    return lines


def contract_hash(document: Mapping[str, object]) -> str:
    """Sixteen hex characters — long enough to be unique, short enough to read in a log."""
    payload = "\n".join(canonical_lines(document))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
