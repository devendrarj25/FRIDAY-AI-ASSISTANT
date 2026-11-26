"""A ready local chat model of role "fast" (the setup tiers are all <= 4B) must still plan and answer."""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import Storage  # noqa: E402
from planner import Planner  # noqa: E402
from router import ModelRouter  # noqa: E402
from tests.test_planner_resume import FakeAuthority, FakeMemory, drain  # noqa: E402


class FakeStorage:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def local(mid: str, role: str, **extra) -> dict:
    return {
        "id": mid,
        "label": mid,
        "provider": "ollama",
        "endpoint": "http://127.0.0.1:11434",
        "role": role,
        **extra,
    }


def cloud(mid: str, role: str = "brain", **extra) -> dict:
    return {
        "id": mid,
        "label": mid,
        "provider": "openai",
        "endpoint": "https://api.openai.com/v1",
        "role": role,
        "options": {"type": "cloud", "access": "free"},
        **extra,
    }


class FastLocalBrainTests(unittest.TestCase):
    def test_by_role_brain_falls_back_to_ready_local_fast_model(self):
        router = ModelRouter(FakeStorage())
        router.register(local("ollama:qwen3:4b", "fast"))
        pick = router.by_role("brain")
        assert pick is not None
        assert pick.id == "ollama:qwen3:4b"

    def test_by_role_brain_never_picks_embed_or_unready_fast_model(self):
        router = ModelRouter(FakeStorage())
        router.register(local("ollama:nomic-embed-text", "embed"))
        router.register(local("ollama:qwen3:1.7b", "fast", status="unavailable"))
        assert router.by_role("brain") is None

    def test_by_role_brain_prefers_a_real_brain_role_model(self):
        router = ModelRouter(FakeStorage())
        router.register(local("ollama:qwen3:4b", "fast"))
        router.register(local("ollama:qwen3:14b", "brain"))
        pick = router.by_role("brain")
        assert pick is not None
        assert pick.id == "ollama:qwen3:14b"

    def test_by_role_other_roles_do_not_fall_back(self):
        router = ModelRouter(FakeStorage())
        router.register(local("ollama:qwen3:4b", "fast"))
        assert router.by_role("coder") is None

    def test_by_role_brain_fallback_respects_the_billing_firewall(self):
        router = ModelRouter(FakeStorage())
        router.register(cloud("cloud-fast", "fast", options={"type": "cloud", "access": "paid"}))
        assert router.by_role("brain") is None

    def test_auto_pick_keeps_local_first_when_cloud_brain_and_local_fast_exist(self):
        router = ModelRouter(FakeStorage())
        router.register(cloud("cloud-brain"))
        router.register(local("ollama:qwen3:4b", "fast"))
        pick = router.best_available("brain")
        assert pick is not None
        assert pick.id == "ollama:qwen3:4b"

    def test_auto_pick_still_takes_a_cloud_brain_when_the_local_fast_model_is_not_ready(self):
        router = ModelRouter(FakeStorage())
        router.register(cloud("cloud-brain"))
        router.register(local("ollama:qwen3:4b", "fast", status="unavailable"))
        pick = router.best_available("brain")
        assert pick is not None
        assert pick.id == "cloud-brain"

    def test_paid_cloud_brain_stays_hidden_so_local_fast_wins(self):
        router = ModelRouter(FakeStorage())
        router.register(cloud("cloud-brain", options={"type": "cloud", "access": "paid"}))
        router.register(local("ollama:qwen3:4b", "fast"))
        pick = router.best_available("brain")
        assert pick is not None
        assert pick.id == "ollama:qwen3:4b"

    def test_coder_role_local_model_does_not_count_as_brain_match(self):
        router = ModelRouter(FakeStorage())
        router.register(cloud("cloud-brain"))
        router.register(local("ollama:qwen2.5-coder:7b", "coder"))
        pick = router.best_available("brain")
        assert pick is not None
        assert pick.id == "cloud-brain"


class RoutedFakeRouter(ModelRouter):
    """The real model table with a scripted completion."""

    def __init__(self, plan_json: str):
        super().__init__(FakeStorage())
        self.plan_json = plan_json
        self.used: list[str] = []

    async def complete(self, model, messages, explicit_paid: bool = False, **_kw) -> str:
        self.used.append(model.id)
        return self.plan_json


class FakeTools:
    def __init__(self):
        self.authority = FakeAuthority()

    def describe(self):
        return [{"name": "read", "risk": "safe"}]

    def risk(self, name: str) -> str:
        return "safe"

    async def execute(self, name, args, authorization=None):
        return {"ok": True, "name": name}


class PlannerFastLocalTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.storage = Storage(Path(self.dir.name) / "friday.sqlite3")
        self.storage.migrate()

    def tearDown(self):
        self.dir.cleanup()

    def planner(self, router) -> Planner:
        return Planner(router, FakeTools(), FakeMemory(), self.storage)

    def test_planner_runs_with_only_a_fast_local_model(self):
        router = RoutedFakeRouter('{"steps":[{"title":"one","tool":"read","args":{}}]}')
        router.register(local("ollama:qwen3:4b", "fast"))
        events = asyncio.run(drain(self.planner(router).run("look")))
        assert not [e for e in events if e.get("type") == "failed"], events
        assert router.used and router.used[0] == "ollama:qwen3:4b"

    def test_planner_still_fails_clearly_with_no_ready_chat_model(self):
        router = RoutedFakeRouter("{}")
        router.register(local("ollama:nomic-embed-text", "embed"))
        events = asyncio.run(drain(self.planner(router).run("look")))
        assert events[-1]["type"] == "failed"
        assert "no ready model" in events[-1]["error"]


if __name__ == "__main__":
    unittest.main()
