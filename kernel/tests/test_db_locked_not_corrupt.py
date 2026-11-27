"""A busy or locked database is not a damaged one: only real corruption sets a file aside."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import db  # noqa: E402
from db import Storage  # noqa: E402


class _FailingConn:
    """Wraps a real connection; PRAGMA quick_check raises the given error."""

    def __init__(self, real: sqlite3.Connection, error: Exception) -> None:
        self._real = real
        self._error = error

    def execute(self, sql, *args):
        if "quick_check" in sql:
            raise self._error
        return self._real.execute(sql, *args)

    def __getattr__(self, name):
        return getattr(self._real, name)


def _seed(path: Path) -> None:
    storage = Storage(path)
    storage.migrate()
    storage.append_chat("s", "user", "keep me")
    storage.close()


@pytest.mark.parametrize(
    "message", ["database is locked", "database table is locked", "disk I/O error", "database is busy"]
)
def test_a_transient_error_never_marks_a_healthy_file_corrupt(monkeypatch, message):
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "friday.sqlite3"
        _seed(path)
        real_connect = Storage._connect
        monkeypatch.setattr(
            Storage, "_connect", lambda self: _FailingConn(real_connect(self), sqlite3.OperationalError(message))
        )
        storage = Storage(path)
        assert storage.health()["state"] == "ok"
        assert storage.health()["corruptPath"] is None
        assert not list(Path(folder).glob("*.corrupt-*"))
        storage.close()
        monkeypatch.undo()
        again = Storage(path)
        assert len(again.chat_history("s")) == 1
        again.close()


@pytest.mark.parametrize("message", ["database disk image is malformed", "file is not a database"])
def test_real_corruption_errors_still_set_the_file_aside(monkeypatch, message):
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "friday.sqlite3"
        _seed(path)
        real_connect = Storage._connect
        calls = {"n": 0}

        def connect(self):
            calls["n"] += 1
            conn = real_connect(self)
            return _FailingConn(conn, sqlite3.DatabaseError(message)) if calls["n"] == 1 else conn

        monkeypatch.setattr(Storage, "_connect", connect)
        storage = Storage(path)
        assert storage.health()["state"] in {"restored", "recreated"}
        assert list(Path(folder).glob("*.corrupt-*"))
        storage.close()


def test_set_aside_failure_on_windows_never_raises_at_import(monkeypatch):
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "friday.sqlite3"
        path.write_bytes(b"this is not a sqlite database at all" * 200)
        original = path.read_bytes()
        real_replace = Path.replace

        def deny(self, target):
            if self.name == "friday.sqlite3":
                raise PermissionError("[WinError 32] file in use")
            return real_replace(self, target)

        monkeypatch.setattr(Path, "replace", deny)
        storage = Storage(path)  # must not raise
        storage.migrate()
        report = storage.health()
        assert report["state"] == "unavailable"
        assert path.read_bytes() == original  # the owner's bytes are untouched
        storage.close()


def test_a_non_corruption_open_error_is_not_corrupt():
    assert db.Storage._is_corruption(sqlite3.OperationalError("database is locked")) is False
    assert db.Storage._is_corruption(sqlite3.OperationalError("unable to open database file")) is False
    assert db.Storage._is_corruption(sqlite3.DatabaseError("file is not a database")) is True
    assert db.Storage._is_corruption(sqlite3.DatabaseError("database disk image is malformed")) is True
