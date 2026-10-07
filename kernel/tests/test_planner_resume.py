"""Approval must resume the SAME task, from disk, after a restart."""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import Storage  # noqa: E402
from planner import Planner  # noqa: E402


class FakeRouter:
    def __init__(self, plan_json: str):
        self.plan_json = plan_json

    def by_role(self, role: str):
        return object()

    async def complete(self, model, messages, explicit_paid: bool = False) -> str:
        return self.plan_json


class FakeAuthority:
    """Stands in for the shared signing authority the planner mints with."""

    def issue(self, tool, args=None, risk="exec", requester="planner"):
        return f"token:{tool}"


class FakeTools:
    def __init__(self):
        self.calls: list[str] = []
        self.authority = FakeAuthority()
        self.authorizations: list[str | None] = []

    def describe(self):
        return [{"name": "read", "risk": "safe"}, {"name": "write", "risk": "mutating"}]

    def risk(self, name: str) -> str:
        return "safe" if name == "read" else "mutating"

    async def execute(self, name, args, authorization=None):
        self.calls.append(name)
        self.authorizations.append(authorization)
        if self.risk(name) != "safe" and not authorization:
            return {"ok": False, "error": "approval required"}
        return {"ok": True, "name": name}


class FakeMemory:
    async def recall(self, goal):
        return []

    async def add_lesson(self, text, context=""):
        return None


PLAN = (
    '{"steps":[{"title":"look","tool":"read","args":{}},'
    '{"title":"change","tool":"write","args":{}},'
    '{"title":"confirm","tool":"read","args":{}}]}'
)


async def drain(gen):
    return [event async for event in gen]


class PlannerResumeTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = Path(self.dir.name) / "friday.sqlite3"
        self.storage = Storage(self.db)
        self.storage.migrate()
        self.tools = FakeTools()
        self.planner = Planner(FakeRouter(PLAN), self.tools, FakeMemory(), self.storage)

    def tearDown(self):
        self.storage.close()
        for extra in getattr(self, "_extra_storage", []):
            extra.close()
        self.dir.cleanup()

    def test_pause_persists_and_approval_finishes_the_same_task(self):
        events = asyncio.run(drain(self.planner.run("do the thing")))
        kinds = [e["type"] for e in events]
        self.assertIn("approval-required", kinds)
        task_id = events[0]["taskId"]
        self.assertEqual(self.tools.calls, ["read"])  # stopped before the risky step

        # The pause is on disk, not in memory.
        checkpoint = self.storage.load_checkpoint(task_id)
        self.assertEqual(checkpoint["state"], "waiting-approval")
        self.assertEqual(checkpoint["stepIndex"], 1)
        self.assertEqual(len(checkpoint["plan"]), 3)
        self.assertEqual([c["taskId"] for c in self.planner.pending()], [task_id])

        # Simulate a kernel restart: a brand new planner over the same file.
        restarted_storage = Storage(self.db)
        self._extra_storage = [restarted_storage]
        restarted = Planner(
            FakeRouter(PLAN), self.tools, FakeMemory(), restarted_storage
        )
        decision = restarted.approve(task_id, "s2", True)
        self.assertTrue(decision["ok"])

        resumed = asyncio.run(drain(restarted.resume(task_id)))
        kinds = [e["type"] for e in resumed]
        self.assertEqual(kinds[0], "resumed")
        self.assertIn("done", kinds)
        # The remaining steps really executed, in order, exactly once.
        self.assertEqual(self.tools.calls, ["read", "write", "read"])
        self.assertIsNone(self.storage.load_checkpoint(task_id))
        state = [t for t in self.storage.tasks() if t["id"] == task_id][0]["state"]
        self.assertEqual(state, "done")

    def test_denial_cancels_instead_of_pretending(self):
        events = asyncio.run(drain(self.planner.run("do the thing")))
        task_id = events[0]["taskId"]
        self.planner.approve(task_id, "s2", False)
        resumed = asyncio.run(drain(self.planner.resume(task_id)))
        self.assertEqual([e["type"] for e in resumed], ["cancelled"])
        self.assertEqual(self.tools.calls, ["read"])
        state = [t for t in self.storage.tasks() if t["id"] == task_id][0]["state"]
        self.assertEqual(state, "cancelled")

    def test_approval_without_a_pending_step_is_rejected(self):
        self.assertFalse(self.planner.approve("task-nope", "s1", True)["ok"])


if __name__ == "__main__":
    unittest.main()
