"""A damaged database never stops the kernel at import: it is set aside, restored or recreated, and reported."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import db  # noqa: E402
from db import SCHEMA_VERSION, Storage  # noqa: E402


def _seed(path: Path, rows: int = 3) -> None:
    storage = Storage(path)
    storage.migrate()
    for i in range(rows):
        storage.append_chat("s", "user", f"hello {i}")
    storage.close()


def _damage(path: Path) -> None:
    path.write_bytes(b"this is not a sqlite database at all" * 200)


def test_a_healthy_database_reports_ok_and_keeps_its_rows():
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "friday.sqlite3"
        _seed(path)
        storage = Storage(path)
        storage.migrate()
        assert storage.health()["state"] == "ok"
        assert len(storage.chat_history("s")) == 3
        storage.close()


def test_a_corrupt_file_is_renamed_aside_and_a_fresh_database_is_created():
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "friday.sqlite3"
        _damage(path)
        storage = Storage(path)
        storage.migrate()
        report = storage.health()
        assert report["state"] == "recreated"
        aside = Path(report["corruptPath"])
        assert aside.name.startswith("friday.sqlite3.corrupt-") and aside.is_file()
        assert aside.read_bytes().startswith(b"this is not")  # the owner's bytes are kept, not deleted
        storage.append_chat("s", "user", "works again")
        assert len(storage.chat_history("s")) == 1
        storage.close()


def test_a_corrupt_file_is_restored_from_the_backup_when_there_is_one():
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "friday.sqlite3"
        _seed(path, rows=4)
        # A backup the way migrate() writes one.
        source = sqlite3.connect(path)
        target = sqlite3.connect(str(path) + ".bak")
        source.backup(target)
        target.close()
        source.close()
        _damage(path)
        storage = Storage(path)
        storage.migrate()
        report = storage.health()
        assert report["state"] == "restored"
        assert Path(report["corruptPath"]).is_file()
        assert len(storage.chat_history("s")) == 4
        storage.close()


def test_a_corrupt_backup_is_not_restored_over_the_corrupt_file():
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "friday.sqlite3"
        _damage(path)
        Path(str(path) + ".bak").write_bytes(b"also broken" * 100)
        storage = Storage(path)
        storage.migrate()
        assert storage.health()["state"] == "recreated"
        assert storage.chat_history("s") == []
        storage.close()


def test_the_indexes_exist_and_migrating_twice_is_harmless():
    with tempfile.TemporaryDirectory() as folder:
        storage = Storage(Path(folder) / "friday.sqlite3")
        storage.migrate()
        storage.migrate()
        names = {row[0] for row in storage.conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert {"idx_chats_session_id", "idx_task_steps_task_id"} <= names
        plan = " ".join(
            str(row[3]) for row in storage.conn.execute("EXPLAIN QUERY PLAN SELECT * FROM chats WHERE session='s'")
        )
        assert "idx_chats_session_id" in plan
        storage.close()


def test_a_newer_schema_is_reported_and_not_downgraded():
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "friday.sqlite3"
        storage = Storage(path)
        storage.migrate()
        storage.set_setting("schema_version", SCHEMA_VERSION + 5)
        storage.close()
        storage = Storage(path)
        storage.migrate()
        report = storage.health()
        assert report["state"] == "newer-schema"
        assert report["storedVersion"] == SCHEMA_VERSION + 5
        assert storage.settings()["schema_version"] == SCHEMA_VERSION + 5  # never written back lower
        storage.close()


def test_the_health_report_is_a_plain_dict_for_doctor():
    with tempfile.TemporaryDirectory() as folder:
        storage = Storage(Path(folder) / "friday.sqlite3")
        storage.migrate()
        report = storage.health()
        assert set(report) >= {"state", "schemaVersion", "corruptPath"}
        assert report["schemaVersion"] == db.SCHEMA_VERSION
        storage.close()
