"""Typed loopback HTTP contract for the kernel.

`/health` and `/version` stay unauthenticated because the desktop readiness
check calls them before the bridge token is used. Every other HTTP route is
on the companion router and stays behind the phone switch and the pair token.
The bridge WebSocket checks the per-launch token.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

REPO = Path(__file__).resolve().parents[1]


class HealthBody(BaseModel):
    ok: bool
    version: str
    data_dir: str
    models: list[dict[str, Any]]


class VersionBody(BaseModel):
    ok: bool
    product: str
    kernel: str


class ErrorBody(BaseModel):
    """FastAPI's stable error envelope. Clients read `detail`."""

    detail: str = Field(description="Why the request was refused")


def product_version(root: Path | None = None) -> str:
    """Four-part product line from config/friday-version.json, or empty."""
    path = (root or REPO) / "config" / "friday-version.json"
    if not path.is_file():
        return ""
    data = json.loads(path.read_text(encoding="utf-8"))
    return f"{int(data['major'])}.{int(data['minor'])}.{int(data['patch'])}.{int(data['revision'])}"


def websocket_paths(app: Any) -> list[str]:
    """Every mounted WebSocket path, including routers included on the app."""
    found: list[str] = []

    def walk(routes: Any) -> None:
        for route in routes or []:
            if type(route).__name__ == "APIWebSocketRoute":
                path = getattr(route, "path", "")
                if path:
                    found.append(path)
            original = getattr(route, "original_router", None)
            if original is not None:
                walk(getattr(original, "routes", []))
            walk(getattr(route, "routes", []))

    walk(getattr(getattr(app, "router", None), "routes", []))
    return sorted(set(found))


def route_rows(schema: dict[str, Any]) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    paths = schema.get("paths")
    if not isinstance(paths, dict):
        return rows
    for route, item in sorted(paths.items()):
        if not isinstance(item, dict):
            continue
        for verb in sorted(item):
            if verb.startswith("x-") or verb == "parameters":
                continue
            rows.append((verb.upper(), route))
    return rows
