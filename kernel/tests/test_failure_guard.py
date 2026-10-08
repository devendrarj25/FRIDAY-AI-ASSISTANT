"""Injected faults: a crash, a 429, a full disk, a denied write, a clock jump, a corrupt file."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import Storage  # noqa: E402
from failure_guard import (  # noqa: E402
    approval_fresh,
    classify_failure,
    idle_within,
    migrate_json,
    offline_flows,
    recover_failure,
    restore_database_file,
    startup_within,
)
from planner import Planner  # noqa: E402
from tests.test_planner_resume import FakeAuthority, FakeMemory, FakeRouter, drain  # noqa: E402


class FlakyTools:
    def __init__(self) -> None:
        self.calls = 0
        self.authority = FakeAuthority()

    def describe(self):
        return [{"name": "read", "risk": "safe"}]

    def risk(self, name: str) -> str:
        return "safe"

    async def execute(self, name, args, authorization=None):
        self.calls += 1
        return {"ok": True, "name": name}


class FailureClassTests(unittest.TestCase):
    def test_each_fault_has_one_recovery(self):
        self.assertEqual(classify_failure("kernel crash on restart"), "kernel-crash")
        self.assertEqual(recover_failure("kernel-crash")["action"], "resume")
        self.assertEqual(classify_failure("HTTP 429"), "provider-outage")
        self.assertEqual(recover_failure("provider-outage", 0)["action"], "retry")
        self.assertEqual(recover_failure("provider-outage", 2)["action"], "fallback")
        self.assertEqual(classify_failure("ENOSPC disk full"), "disk-full")
        self.assertEqual(recover_failure("disk-full")["action"], "stop")
        self.assertEqual(classify_failure("EACCES permission denied"), "permission-denied")
        self.assertEqual(recover_failure("permission-denied")["action"], "stop")
        self.assertEqual(classify_failure("clock jump"), "clock-jump")
        self.assertEqual(recover_failure("clock-jump")["action"], "expire")
        self.assertEqual(classify_failure("malformed json"), "corrupt-state")
        self.assertEqual(recover_failure("corrupt-state")["action"], "restore")
        self.assertEqual(classify_failure("interrupted write"), "interrupted-write")
        self.assertEqual(recover_failure("interrupted-write")["action"], "restore")

    def test_a_jumped_clock_expires_a_spoken_yes(self):
        asked = 1_000_000
        self.assertTrue(approval_fresh(asked, asked + 120_000))
        self.assertFalse(approval_fresh(asked, asked + 120_001))
        self.assertFalse(approval_fresh(asked, asked - 1))

    def test_startup_and_idle_use_the_injected_clock(self):
        self.assertTrue(startup_within(0, 1_000)["ok"])
        self.assertFalse(startup_within(0, 9_000)["ok"])
        self.assertFalse(startup_within(5_000, 4_000)["ok"])
        self.assertTrue(idle_within([0.2, 0.4])["ok"])
        self.assertFalse(idle_within([0.2, 1.5])["ok"])

    def test_offline_keeps_local_flows_and_closes_cloud(self):
        quiet = offline_flows(False, True)
        self.assertTrue(quiet["chat"] and quiet["tasks"] and quiet["memory"] and quiet["localModel"])
        self.assertFalse(quiet["cloud"])
        self.assertFalse(offline_flows(False, False)["localModel"])
        self.assertTrue(offline_flows(True, True)["cloud"])


class MigrationTests(unittest.TestCase):
    def test_schema_change_backs_up_before_the_new_columns(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "friday.sqlite3"
        storage = Storage(path)
        self.addCleanup(storage.close)
        storage.migrate()
        bak = Path(str(path) + ".bak")
        self.assertTrue(bak.is_file())
        saved = sqlite3.connect(bak)
        names = {row[1] for row in saved.execute("PRAGMA table_info(tasks)")}
        self.assertNotIn("priority", names)
        self.assertNotIn("idempotency_key", names)
        versions = saved.execute(
            "SELECT key FROM settings WHERE key='schema_version'"
        ).fetchall()
        saved.close()
        self.assertEqual(versions, [])
        live = {row["name"] for row in storage.conn.execute("PRAGMA table_info(tasks)")}
        self.assertIn("priority", live)
        self.assertIn("idempotency_key", live)
        self.assertEqual(storage.settings()["schema_version"], 2)

    def test_the_same_idempotency_key_does_not_open_a_second_task(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        storage = Storage(Path(folder.name) / "friday.sqlite3")
        self.addCleanup(storage.close)
        storage.migrate()
        first = storage.create_task("task-a", "send the note", idempotency_key="note-1")
        second = storage.create_task("task-b", "send the note again", idempotency_key="note-1")
        other = storage.create_task("task-c", "a different note", idempotency_key="note-2")
        self.assertEqual(first, "task-a")
        self.assertEqual(second, "task-a")
        self.assertEqual(other, "task-c")
        count = storage.conn.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()["n"]
        self.assertEqual(count, 2)

    def test_a_corrupt_database_restores_the_backup(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "friday.sqlite3"
        storage = Storage(path)
        storage.migrate()
        storage.set_setting("kept", "yes")
        storage.backup_database()
        storage.close()
        path.write_bytes(b"not a database")
        self.assertTrue(restore_database_file(path))
        restored = Storage(path)
        self.addCleanup(restored.close)
        self.assertEqual(restored.settings()["kept"], "yes")

    def test_a_failed_json_write_keeps_the_previous_body(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "state.json"
        path.write_text(json.dumps({"version": 1, "note": "keep"}), encoding="utf-8")

        def bump(value):
            return {**value, "version": 2}

        full = migrate_json(path, bump, now=10, fail="disk-full")
        self.assertFalse(full["ok"])
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 1)
        denied = migrate_json(path, bump, now=11, fail="permission-denied")
        self.assertEqual(denied["reason"], "permission-denied")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["note"], "keep")
        cut = migrate_json(path, bump, now=12, fail="interrupt")
        self.assertEqual(cut["reason"], "interrupted-write")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 1)
        done = migrate_json(path, bump, now=13)
        self.assertTrue(done["ok"])
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 2)
        path.write_text("{", encoding="utf-8")
        restored = migrate_json(path, bump, now=14)
        self.assertTrue(restored["restored"])
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 1)


class CrashRestartTests(unittest.TestCase):
    def test_a_running_checkpoint_is_interrupted_after_restart(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        storage = Storage(Path(folder.name) / "friday.sqlite3")
        self.addCleanup(storage.close)
        storage.migrate()
        storage.create_task("task-x", "unfinished")
        storage.save_checkpoint(
            "task-x",
            {
                "goal": "unfinished",
                "plan": [{"title": "one", "tool": "read", "args": {}}],
                "stepIndex": 0,
                "state": "running",
                "modelIds": [],
                "results": [],
            },
        )
        planner = Planner(FakeRouter("{}"), FlakyTools(), FakeMemory(), storage)
        recovered = planner.recover()
        self.assertEqual(recovered[0]["state"], "interrupted")
        self.assertEqual(storage.load_checkpoint("task-x")["state"], "interrupted")
        events = asyncio.run(drain(planner.resume("task-x")))
        self.assertEqual(events[-1]["type"], "done")


if __name__ == "__main__":
    unittest.main()
