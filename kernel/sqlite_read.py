"""Read a SQLite database the way a careful colleague would: look, never touch.

The file is opened read-only, the connection refuses to write, an authorizer allows only SELECT-style
reads (no ATTACH, no PRAGMA that changes anything, no function that loads code), a progress handler
stops a query that runs too long, and the answer is cut at a row and a size limit. One statement only.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

MAX_ROWS = 200
MAX_CELL = 2_000
MAX_BYTES = 200_000
MAX_SECONDS = 5

_ALLOWED = {
    sqlite3.SQLITE_SELECT,
    sqlite3.SQLITE_READ,
    sqlite3.SQLITE_FUNCTION,
    sqlite3.SQLITE_RECURSIVE,
}
_DENIED_FUNCTIONS = {"load_extension", "readfile", "writefile", "edit", "fts3_tokenizer"}


def _authorizer(action: int, arg1: str | None, arg2: str | None, db: str | None, source: str | None) -> int:
    if action == sqlite3.SQLITE_FUNCTION and str(arg2 or arg1 or "").lower() in _DENIED_FUNCTIONS:
        return sqlite3.SQLITE_DENY
    if action in _ALLOWED:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_PRAGMA and str(arg1 or "").lower() in {"table_info", "table_xinfo", "index_list"}:
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def _cell(value: object) -> object:
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, str) and len(value) > MAX_CELL:
        return value[:MAX_CELL] + "…"
    return value


def _connect(path: Path) -> sqlite3.Connection:
    for suffix in ("?mode=ro", "?immutable=1"):
        try:
            conn = sqlite3.connect(f"{path.resolve().as_uri()}{suffix}", uri=True, timeout=2)
            conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
            return conn
        except sqlite3.Error:
            continue
    raise sqlite3.DatabaseError("that file is not a SQLite database FRIDAY can open")


def query(path: Path, sql: str | None = None, limit: int = 50) -> dict:
    if not path.is_file():
        return {"ok": False, "error": f"{path.name} is not a file"}
    try:
        conn = _connect(path)
    except sqlite3.Error as exc:
        return {"ok": False, "error": str(exc)}
    try:
        conn.execute("PRAGMA query_only = ON")
        conn.set_authorizer(_authorizer)
        deadline = time.monotonic() + MAX_SECONDS
        conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 10_000)
        if not (sql or "").strip():
            tables = conn.execute(
                "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
            return {"ok": True, "tables": [{"name": n, "type": t} for n, t in tables]}
        cursor = conn.execute(sql)
        rows: list[list[object]] = []
        size = 0
        truncated = False
        for row in cursor:
            cells = [_cell(v) for v in row]
            size += len(repr(cells))
            if len(rows) >= max(1, min(int(limit), MAX_ROWS)) or size > MAX_BYTES:
                truncated = True
                break
            rows.append(cells)
        columns = [d[0] for d in (cursor.description or [])]
        return {"ok": True, "columns": columns, "rows": rows, "truncated": truncated}
    except sqlite3.OperationalError as exc:
        if "interrupted" in str(exc):
            return {
                "ok": False,
                "error": f"the query ran longer than {MAX_SECONDS} seconds and was stopped",
                "cause": "timeout",
            }
        return {"ok": False, "error": str(exc)}
    except sqlite3.Warning:
        return {"ok": False, "error": "send one statement at a time"}
    except sqlite3.DatabaseError as exc:
        if "not authorized" in str(exc):
            return {"ok": False, "error": "only reading is allowed: use SELECT", "cause": "refused"}
        return {"ok": False, "error": str(exc)}
    finally:
        conn.close()
