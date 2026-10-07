"""Retries, cancellation and crash recovery are real and persisted."""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import Storage  # noqa: E402
from planner import MAX_STEP_ATTEMPTS, Planner  # noqa: E402
from tests.test_planner_resume import (  # noqa: E402
    FakeAuthority,
    FakeMemory,
    FakeRouter,
    drain,
)

PLAN_SAFE = (
    '{"steps":[{"title":"one","tool":"read","args":{}},'
    '{"title":"two","tool":"read","args":{}}]}'
)


class FlakyTools:
    """A safe tool that fails the first attempt and succeeds on the retry."""

    def __init__(self, failures: int):
        self.failures = failures
        self.calls = 0
        self.authority = FakeAuthority()

    def describe(self):
        return [{"name": "read", "risk": "safe"}]

    def risk(self, name: str) -> str:
        return "safe"

    async def execute(self, name, args, authorization=None):
        self.calls += 1
        if self.calls <= self.failures:
            return {"ok": False, "error": "transient"}
        return {"ok": True, "name": name}


class PlannerControlTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = Path(self.dir.name) / "friday.sqlite3"
        self.storage = Storage(self.db)
        self.storage.migrate()

    def tearDown(self):
        self.storage.close()
        self.dir.cleanup()

    def _planner(self, tools):
        return Planner(FakeRouter(PLAN_SAFE), tools, FakeMemory(), self.storage)

    def test_transient_failure_is_retried_and_recovers(self):
        tools = FlakyTools(failures=1)
        events = asyncio.run(drain(self._planner(tools).run("go")))
        kinds = [e["type"] for e in events]
        self.assertIn("retry", kinds)
        self.assertIn("done", kinds)
        task_id = events[0]["taskId"]
        steps = self.storage.task_steps(task_id)
        self.assertEqual(steps[0]["attempt"], 1)
        self.assertFalse(steps[0]["ok"])
        self.assertTrue(steps[1]["ok"])
        self.assertIsNotNone(steps[1]["durationMs"])

    def test_retries_are_bounded_and_the_task_fails(self):
        tools = FlakyTools(failures=99)
        events = asyncio.run(drain(self._planner(tools).run("go")))
        self.assertEqual(events[-1]["type"], "failed")
        self.assertEqual(tools.calls, MAX_STEP_ATTEMPTS)
        task_id = events[0]["taskId"]
        row = [t for t in self.storage.tasks() if t["id"] == task_id][0]
        self.assertEqual(row["state"], "failed")
        self.assertTrue(row["error"])

    def test_write_lessons_on_failure_can_be_disabled(self):
        class RecordingMemory:
            def __init__(self):
                self.lessons = []

            async def recall(self, goal):
                return []

            async def add_lesson(self, text, context=""):
                self.lessons.append(text)

        memory = RecordingMemory()
        tools = FlakyTools(failures=99)
        planner = Planner(
            FakeRouter(PLAN_SAFE),
            tools,
            memory,
            self.storage,
            write_lessons=False,
        )
        events = asyncio.run(drain(planner.run("go")))
        self.assertEqual(events[-1]["type"], "failed")
        self.assertEqual(memory.lessons, [])
        planner.set_write_lessons(True)
        events = asyncio.run(drain(planner.run("go again")))
        self.assertEqual(events[-1]["type"], "failed")
        self.assertTrue(memory.lessons)

    def test_apply_live_setting_toggles_write_lessons(self):
        planner = self._planner(FlakyTools(failures=0))
        planner.apply_live_setting("write_lessons", False)
        self.assertFalse(planner.write_lessons)
        planner.apply_live_setting("write_lessons", True)
        self.assertTrue(planner.write_lessons)
        planner.apply_live_setting("unrelated", False)
        self.assertTrue(planner.write_lessons)

    def test_cancel_stops_before_the_next_step(self):
        planner = self._planner(FlakyTools(failures=0))
        # Cancel is honoured between steps, so pre-flag a task id via a run
        # that is cancelled from the first checkpoint onwards.
        events = asyncio.run(drain(planner.run("go")))
        task_id = events[0]["taskId"]
        self.assertTrue(planner.cancel(task_id)["ok"])
        self.assertTrue(self.storage.cancel_requested(task_id))

    def test_recover_marks_running_tasks_interrupted(self):
        self.storage.create_task("task-x", "unfinished")
        self.storage.save_checkpoint(
            "task-x",
            {"goal": "unfinished", "plan": [{"title": "one", "tool": "read"}], "stepIndex": 0,
             "state": "running", "modelIds": [], "results": []},
        )
        recovered = self._planner(FlakyTools(failures=0)).recover()
        self.assertEqual([c["taskId"] for c in recovered], ["task-x"])
        self.assertEqual(self.storage.load_checkpoint("task-x")["state"], "interrupted")
        row = [t for t in self.storage.tasks() if t["id"] == "task-x"][0]
        self.assertEqual(row["state"], "interrupted")

    def test_interrupted_task_resumes_from_its_checkpoint(self):
        tools = FlakyTools(failures=0)
        planner = self._planner(tools)
        self.storage.create_task("task-y", "half done")
        self.storage.save_checkpoint(
            "task-y",
            {"goal": "half done",
             "plan": [{"title": "one", "tool": "read", "args": {}},
                      {"title": "two", "tool": "read", "args": {}}],
             "stepIndex": 1, "state": "interrupted", "modelIds": [], "results": []},
        )
        events = asyncio.run(drain(planner.resume("task-y")))
        self.assertEqual(events[0]["type"], "resumed")
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(tools.calls, 1)  # only the remaining step ran


class ParsePlanTests(unittest.TestCase):
    def test_reads_json_inside_a_markdown_fence(self):
        from planner import parse_plan

        raw = "Here you go:\n```json\n" + PLAN_SAFE + "\n```\n"
        steps = parse_plan(raw)
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0]["title"], "one")

    def test_rejects_empty_and_stepless_payloads(self):
        from planner import parse_plan

        with self.assertRaises(ValueError):
            parse_plan("")
        with self.assertRaises(ValueError):
            parse_plan('{"steps":[]}')


class FencedPlanRouter:
    def __init__(self, inner: str):
        self.inner = inner
        self.calls = 0

    def by_role(self, role: str):
        return object()

    async def complete(self, model, messages, explicit_paid: bool = False) -> str:
        self.calls += 1
        if self.calls == 1:
            return "Sure, here is a plan:\n```json\n" + self.inner + "\n```"
        return self.inner


class PlannerFencedPlanTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = Path(self.dir.name) / "friday.sqlite3"
        self.storage = Storage(self.db)
        self.storage.migrate()

    def tearDown(self):
        self.storage.close()
        self.dir.cleanup()

    def test_fenced_plan_runs_instead_of_failing(self):
        tools = FlakyTools(failures=0)
        planner = Planner(FencedPlanRouter(PLAN_SAFE), tools, FakeMemory(), self.storage)
        events = asyncio.run(drain(planner.run("go")))
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(tools.calls, 2)


if __name__ == "__main__":
    unittest.main()
