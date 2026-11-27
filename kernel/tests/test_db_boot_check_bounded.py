"""Boot does not scan a large database in full after a clean shutdown, and a backup that cannot be copied is treated
as no backup instead of stopping the kernel at import."""

from __future__ import annotations

import shutil
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import db  # noqa: E402
import failure_guard  # noqa: E402
from db import Storage  # noqa: E402


def _seed(path: Path) -> None:
    storage = Storage(path)
    storage.migrate()
    storage.append_chat("s", "user", "hello")
    storage.close()


def _count_full_checks(monkeypatch) -> list[int]:
    calls: list[int] = []
    original = Storage._passes_quick_check

    def counted(conn):
        calls.append(1)
        return original(conn)

    monkeypatch.setattr(Storage, "_passes_quick_check", staticmethod(counted))
    return calls


def test_a_small_database_is_always_checked_in_full(monkeypatch, tmp_path):
    path = tmp_path / "friday.sqlite3"
    _seed(path)
    calls = _count_full_checks(monkeypatch)
    Storage(path).close()
    assert len(calls) == 1


def test_a_large_database_after_a_clean_shutdown_skips_the_full_scan(monkeypatch, tmp_path):
    path = tmp_path / "friday.sqlite3"
    _seed(path)
    monkeypatch.setattr(db, "QUICK_CHECK_MAX_BYTES", 1)
    calls = _count_full_checks(monkeypatch)
    storage = Storage(path)
    assert calls == []
    assert storage.health()["state"] == "ok"
    assert len(storage.chat_history("s")) == 1
    storage.close()


def test_a_large_database_after_an_unclean_stop_is_checked_in_full(monkeypatch, tmp_path):
    path = tmp_path / "friday.sqlite3"
    _seed(path)
    monkeypatch.setattr(db, "QUICK_CHECK_MAX_BYTES", 1)
    Path(str(path) + ".clean").unlink()  # a crash or a kill leaves no clean-shutdown mark
    calls = _count_full_checks(monkeypatch)
    Storage(path).close()
    assert len(calls) == 1


def test_a_clean_mark_is_used_once_then_the_next_boot_is_unclean_until_it_is_written_again(monkeypatch, tmp_path):
    path = tmp_path / "friday.sqlite3"
    _seed(path)
    monkeypatch.setattr(db, "QUICK_CHECK_MAX_BYTES", 1)
    live = Storage(path)  # opened and not closed: the mark is gone while it runs
    assert not Path(str(path) + ".clean").exists()
    calls = _count_full_checks(monkeypatch)
    second = Storage(path)
    assert len(calls) == 1
    second.close()
    live.mark_clean()
    assert Path(str(path) + ".clean").exists()
    live.close()


def test_a_damaged_large_file_is_still_caught_after_a_clean_mark(monkeypatch, tmp_path):
    path = tmp_path / "friday.sqlite3"
    _seed(path)
    monkeypatch.setattr(db, "QUICK_CHECK_MAX_BYTES", 1)
    path.write_bytes(b"this is not a sqlite database at all" * 200)
    storage = Storage(path)
    storage.migrate()
    report = storage.health()
    assert report["state"] in {"restored", "recreated"}  # the seed left a backup, so it is restored
    assert Path(report["corruptPath"]).is_file()
    storage.close()


def test_a_backup_that_cannot_be_copied_counts_as_no_backup(monkeypatch, tmp_path):
    path = tmp_path / "friday.sqlite3"
    path.write_bytes(b"x")
    Path(str(path) + ".bak").write_bytes(b"backup")

    def refuse(*args, **kwargs):
        raise PermissionError("locked by a scanner")

    monkeypatch.setattr(shutil, "copyfile", refuse)
    assert failure_guard.restore_database_file(path) is False


def test_a_corrupt_file_with_an_unreadable_backup_still_starts_fresh(monkeypatch, tmp_path):
    path = tmp_path / "friday.sqlite3"
    _seed(path)
    source = sqlite3.connect(path)
    bak = sqlite3.connect(str(path) + ".bak")
    source.backup(bak)
    bak.close()
    source.close()
    path.write_bytes(b"this is not a sqlite database at all" * 200)

    def refuse(*args, **kwargs):
        raise OSError(28, "no space left on device")

    monkeypatch.setattr(shutil, "copyfile", refuse)
    storage = Storage(path)  # must not raise at import
    storage.migrate()
    assert storage.health()["state"] == "recreated"
    storage.close()


@pytest.mark.parametrize("name", ["mark_clean"])
def test_the_kernel_marks_a_clean_shutdown(name):
    source = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    assert f"storage.{name}" in source
