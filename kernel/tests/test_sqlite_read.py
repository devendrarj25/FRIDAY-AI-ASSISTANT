"""SQLite reads look but never touch."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
import sqlite_read


@pytest.fixture
def db(tmp_path: Path) -> Path:
    path = tmp_path / "shop.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, blob BLOB)")
    conn.executemany(
        "INSERT INTO items (name, qty, blob) VALUES (?, ?, ?)", [(f"item{i}", i, b"x" * 10) for i in range(300)]
    )
    conn.commit()
    conn.close()
    return path


def test_lists_tables_and_selects(db: Path) -> None:
    assert sqlite_read.query(db)["tables"] == [{"name": "items", "type": "table"}]
    got = sqlite_read.query(db, "SELECT name, qty, blob FROM items WHERE qty < 3 ORDER BY qty")
    assert got["ok"] and got["columns"] == ["name", "qty", "blob"]
    assert got["rows"][0] == ["item0", 0, "<10 bytes>"] and len(got["rows"]) == 3 and not got["truncated"]


def test_row_limit_and_size_limit(db: Path) -> None:
    got = sqlite_read.query(db, "SELECT * FROM items", limit=10_000)
    assert len(got["rows"]) == 200 and got["truncated"]
    big = sqlite_read.query(db, "SELECT replace(hex(zeroblob(1000000)), '0', 'a')")
    assert big["ok"] and len(big["rows"][0][0]) <= sqlite_read.MAX_CELL + 1


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM items",
        "DROP TABLE items",
        "INSERT INTO items (name) VALUES ('x')",
        "UPDATE items SET qty = 0",
        "ATTACH DATABASE '/tmp/evil.db' AS e",
        "PRAGMA journal_mode = DELETE",
        "CREATE TABLE t (a)",
        "SELECT load_extension('x')",
    ],
)
def test_nothing_can_change_the_file(db: Path, sql: str) -> None:
    before = db.read_bytes()
    got = sqlite_read.query(db, sql)
    assert not got["ok"]
    assert db.read_bytes() == before


def test_one_statement_and_non_databases(db: Path, tmp_path: Path) -> None:
    assert not sqlite_read.query(db, "SELECT 1; DELETE FROM items")["ok"]
    assert sqlite_read.query(db, "SELECT count(*) FROM items")["rows"] == [[300]]
    text = tmp_path / "a.txt"
    text.write_text("hello", encoding="utf-8")
    assert not sqlite_read.query(text)["ok"]
    assert not sqlite_read.query(tmp_path / "missing.db")["ok"]


def test_a_runaway_query_is_stopped(db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sqlite_read, "MAX_SECONDS", 0.2)
    slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000000) SELECT count(*) FROM c"
    got = sqlite_read.query(db, slow)
    assert not got["ok"] and got.get("cause") == "timeout"
