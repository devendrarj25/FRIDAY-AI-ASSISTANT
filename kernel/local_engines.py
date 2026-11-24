"""The one table of local inference engines (Ollama, LM Studio, llama.cpp, ...).

``local_engines.json`` next to this file is the table; the desktop reads the same file
(``electron/local-engines.cjs``). Add an engine by adding one row, nowhere else.

The loader never raises. A missing file, malformed JSON, or no usable row falls back to a
small built-in table, and a bad row is skipped on its own.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REGISTRY_FILE = Path(__file__).with_name("local_engines.json")

_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
_WIRES = frozenset({"openai", "ollama"})
_FLAGS = ("needsLoad", "keepAlive", "offloadHint", "registryPrefix")

#: Used only when the file cannot be read: the engines a fresh install talks to first.
FALLBACK_ROWS: list[dict] = [
    {
        "id": "ollama",
        "name": "Ollama",
        "wire": "ollama",
        "endpoint": "http://127.0.0.1:11434",
        "apiPath": "",
        "chatPath": "/api/chat",
        "modelsPath": "/api/tags",
        "env": "OLLAMA_HOST",
        "keepAlive": True,
        "offloadHint": True,
        "registryPrefix": True,
    },
    {
        "id": "lmstudio",
        "name": "LM Studio",
        "wire": "openai",
        "endpoint": "http://127.0.0.1:1234",
        "apiPath": "/v1",
        "modelsPath": "/v1/models",
        "needsLoad": True,
        "registryPrefix": True,
    },
    {
        "id": "llamacpp",
        "name": "llama.cpp",
        "wire": "openai",
        "endpoint": "http://127.0.0.1:8080",
        "apiPath": "/v1",
        "modelsPath": "/v1/models",
        "healthPath": "/health",
        "registryPrefix": True,
        "aliases": ["llama.cpp"],
    },
]
FALLBACK_GENERIC = ["local"]


def _text(value: object, limit: int = 200) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _http_base(value: object) -> str:
    text = _text(value).rstrip("/")
    return text if re.match(r"^https?://[^\s/]+", text, re.I) else ""


def _path(value: object, default: str) -> str:
    text = _text(value)
    if not text:
        return default
    return text if text.startswith("/") else ""


def clean_row(raw: object) -> dict | None:
    """One validated engine row, or None when it cannot be used. Unknown fields are dropped."""
    if not isinstance(raw, dict):
        return None
    engine_id = _text(raw.get("id")).lower()
    wire = _text(raw.get("wire")).lower()
    endpoint = _http_base(raw.get("endpoint"))
    if not _ID.match(engine_id) or wire not in _WIRES or not endpoint:
        return None
    api_path = raw.get("apiPath")
    models_path = _path(raw.get("modelsPath"), "/api/tags" if wire == "ollama" else "/v1/models")
    row: dict = {
        "id": engine_id,
        "name": _text(raw.get("name"), 80) or engine_id,
        "wire": wire,
        "endpoint": endpoint,
        "apiPath": ("" if api_path in (None, "") else _path(api_path, "")) if wire == "openai" else "",
        "chatPath": _path(raw.get("chatPath"), "/api/chat") if wire == "ollama" else "",
        "modelsPath": models_path,
        "healthPath": _path(raw.get("healthPath"), models_path),
        "env": _text(raw.get("env"), 80),
    }
    for flag in _FLAGS:
        row[flag] = raw.get(flag) is True
    for key in ("alternates", "platforms", "aliases"):
        items = raw.get(key)
        row[key] = [t for t in (_text(i, 80) for i in items) if t] if isinstance(items, list) else []
    row["alternates"] = [t for t in (_http_base(i) for i in row["alternates"]) if t]
    row["aliases"] = [t.lower() for t in row["aliases"]]
    return row


def load_table(path: Path | None = None) -> tuple[dict[str, dict], tuple[str, ...]]:
    """(rows by id, generic kinds) from the file; the built-in table when the file is unusable."""
    rows: dict[str, dict] = {}
    generic: list[str] = []
    try:
        data = json.loads((path or REGISTRY_FILE).read_text(encoding="utf-8-sig"))
        items = data.get("engines") if isinstance(data, dict) else None
        for item in items if isinstance(items, list) else []:
            row = clean_row(item)
            if row and row["id"] not in rows:
                rows[row["id"]] = row
        kinds = data.get("genericKinds") if isinstance(data, dict) else None
        for kind in kinds if isinstance(kinds, list) else []:
            text = _text(kind, 40).lower()
            if _ID.match(text) and text not in generic:
                generic.append(text)
    except (OSError, ValueError):
        rows = {}
    if not rows:
        rows = {r["id"]: r for r in (clean_row(x) for x in FALLBACK_ROWS) if r}
        generic = list(FALLBACK_GENERIC)
    return rows, tuple(generic)


ENGINES, GENERIC_KINDS = load_table()


def engine_ids() -> tuple[str, ...]:
    return tuple(ENGINES)


def kinds_of(rows: dict[str, dict], generic: tuple[str, ...]) -> frozenset[str]:
    """Every provider name that means "answers from this PC": engine ids, aliases and generic kinds."""
    names = set(rows) | set(generic)
    for row in rows.values():
        names.update(row["aliases"])
    return frozenset(names)


LOCAL_KINDS = kinds_of(ENGINES, GENERIC_KINDS)


def is_local_kind(name: object) -> bool:
    return str(name or "").strip().lower() in LOCAL_KINDS


def openai_compatible_ids() -> frozenset[str]:
    return frozenset(i for i, row in ENGINES.items() if row["wire"] == "openai")


def registry_prefix_ids() -> frozenset[str]:
    """Engines whose registry id is ``engine:model`` (the prefix is not part of the provider's model name)."""
    return frozenset(i for i, row in ENGINES.items() if row["registryPrefix"])


def supports(engine_id: object, flag: str) -> bool:
    row = ENGINES.get(str(engine_id or "").lower())
    return bool(row and flag in _FLAGS and row[flag])


def surface_for(row: dict) -> dict:
    """The ``PROVIDER_SURFACES`` entry for one engine row."""
    base = row["endpoint"] + row["apiPath"]
    if row["wire"] == "ollama":
        return {"wire": "ollama", "base": base, "chat_path": row["chatPath"]}
    return {"wire": "openai", "base": base}


def surfaces() -> dict[str, dict]:
    out = {engine_id: surface_for(row) for engine_id, row in ENGINES.items()}
    for kind in GENERIC_KINDS:
        out.setdefault(kind, {"wire": "openai", "base": None})
    return out
