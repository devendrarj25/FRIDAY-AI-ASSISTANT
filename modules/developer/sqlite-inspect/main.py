"""Read-only SQLite inspector. Uses stdlib sqlite3 on a path inside the workspace."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
from pathlib import Path

MANIFEST = None
SKIP_NAME = {"password", "passwd", "secret", "token", "api_key", "apikey"}


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


def _safe_columns(names: list[str]) -> list[str]:
    return [name for name in names if str(name).lower() not in SKIP_NAME]


async def run(tools, path: str, sample: int = 3) -> dict:
    listing = await tools.execute("fs.read", {"path": path})
    if listing.get("ok") is False:
        return listing
    if "entries" in listing:
        return {"ok": False, "error": "path is a directory — pass a .sqlite / .db file"}
    candidates = []
    if listing.get("path"):
        candidates.append(Path(str(listing["path"])))
    workspace = getattr(tools, "workspace", None)
    if workspace:
        candidates.append(Path(workspace) / path)
    candidates.append(Path(path))
    db_path = next((item for item in candidates if item.is_file()), None)
    if db_path is None:
        return {"ok": False, "error": f"sqlite file not found on disk: {path}"}
    try:
        conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        return {"ok": False, "error": str(exc)}
    try:
        tables = [
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY 1"
            )
        ]
        detail = []
        for table in tables:
            cols = list(conn.execute(f"PRAGMA table_info({table})"))
            names = _safe_columns([str(col[1]) for col in cols])
            count = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            quoted = ", ".join(f'"{name}"' for name in names) or "NULL"
            rows = []
            if names:
                rows = [
                    dict(zip(names, row))
                    for row in conn.execute(f'SELECT {quoted} FROM "{table}" LIMIT ?', (max(0, int(sample)),))
                ]
            detail.append(
                {
                    "table": table,
                    "columns": [
                        {"name": str(col[1]), "type": str(col[2] or ""), "skipped": str(col[1]).lower() in SKIP_NAME}
                        for col in cols
                    ],
                    "rowCount": count,
                    "sample": rows,
                }
            )
        return {"ok": True, "path": str(db_path), "tables": detail}
    finally:
        conn.close()


class _LocalTools:
    def __init__(self, root: str) -> None:
        self.root = Path(root)
        self.workspace = self.root

    async def execute(self, name: str, args: dict, **_kwargs) -> dict:
        target = (self.root / str(args.get("path", "."))).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return {"ok": False, "error": "path escapes workspace"}
        if name != "fs.read":
            return {"ok": False, "error": f"unknown tool {name}"}
        if target.is_dir():
            return {"ok": True, "entries": sorted(p.name for p in target.iterdir())}
        if not target.is_file():
            return {"ok": False, "error": "missing"}
        return {"ok": True, "path": str(target), "content": ""}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-sqlite-inspect-") as tmp:
        db = Path(tmp) / "demo.db"
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE items (id INTEGER, name TEXT, password TEXT)")
        conn.execute("INSERT INTO items VALUES (1, 'alpha', 'nope')")
        conn.commit()
        conn.close()
        tools = _LocalTools(tmp)
        result = asyncio.run(run(tools, path="demo.db"))
        if not result.get("ok") or result["tables"][0]["rowCount"] != 1:
            raise RuntimeError(result)
        sample = result["tables"][0]["sample"][0]
        if "password" in sample:
            raise RuntimeError("password column was dumped")
        if sample.get("name") != "alpha":
            raise RuntimeError(sample)
        return {"ok": True, "tables": [row["table"] for row in result["tables"]]}
