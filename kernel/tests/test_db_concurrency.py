"""One Storage is used from many worker threads (asyncio.to_thread); it must serialise its own connection."""

from __future__ import annotations

import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db import Storage  # noqa: E402

THREADS = 3
ROUNDS = 400


def _storage(folder: str) -> Storage:
    storage = Storage(Path(folder) / "friday.sqlite3")
    storage.migrate()
    return storage


def test_three_threads_over_the_chat_methods_raise_nothing_and_lose_no_row():
    with tempfile.TemporaryDirectory() as folder:
        storage = _storage(folder)
        errors: list[BaseException] = []
        start = threading.Barrier(THREADS)

        def appender(name: str) -> None:
            try:
                start.wait()
                for i in range(ROUNDS):
                    storage.append_chat(name, "user", f"{name}-{i}")
            except BaseException as exc:  # noqa: BLE001 — collected, asserted below
                errors.append(exc)

        def reader() -> None:
            try:
                start.wait()
                for _ in range(ROUNDS):
                    storage.chat_sessions()
                    storage.chat_history("a")
                    storage.replace_chat("scratch", [{"role": "user", "text": "x"}, {"role": "friday", "text": "y"}])
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [
            threading.Thread(target=appender, args=("a",)),
            threading.Thread(target=appender, args=("b",)),
            threading.Thread(target=reader),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        assert not any(t.is_alive() for t in threads), "a worker thread never finished"
        assert errors == []
        rows = storage.chat_history("a", limit=ROUNDS * 2)
        assert len(rows) == ROUNDS
        assert len(storage.chat_history("b", limit=ROUNDS * 2)) == ROUNDS
        assert len(storage.chat_history("scratch")) == 2
        storage.close()


def test_the_connection_is_wal_with_a_busy_timeout():
    with tempfile.TemporaryDirectory() as folder:
        storage = _storage(folder)
        assert storage.conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert storage.conn.execute("PRAGMA busy_timeout").fetchone()[0] >= 5000
        storage.close()


def test_replace_chat_is_one_transaction_a_bad_row_keeps_the_old_transcript():
    with tempfile.TemporaryDirectory() as folder:
        storage = _storage(folder)
        storage.replace_chat("s", [{"role": "user", "text": "keep me"}])

        class Boom:
            def __str__(self):
                raise RuntimeError("cannot render")

        try:
            storage.replace_chat("s", [{"role": "user", "text": "new"}, {"role": "user", "text": Boom()}])
        except RuntimeError:
            pass
        assert [row["text"] for row in storage.chat_history("s")] == ["keep me"]
        storage.close()


def test_two_threads_on_the_task_methods_stay_consistent():
    with tempfile.TemporaryDirectory() as folder:
        storage = _storage(folder)
        errors: list[BaseException] = []

        def worker(prefix: str) -> None:
            try:
                for i in range(150):
                    task = f"{prefix}{i}"
                    storage.create_task(task, "goal")
                    storage.log_step(task, "s1", "fs.read", {"ok": True})
                    storage.save_checkpoint(task, {"goal": "g", "plan": []})
                    storage.task_steps(task)
                    storage.finish_task(task, "done")
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(p,)) for p in ("x", "y")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        assert errors == []
        assert len(storage.tasks(limit=1000)) == 300
        storage.close()
