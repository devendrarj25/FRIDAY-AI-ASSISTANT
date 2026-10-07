"""best_available ranks ready models; FRIDAY stays the intelligence owner."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import ModelRouter


class FakeStorage:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def test_best_available_prefers_matching_role_then_local():
    router = ModelRouter(FakeStorage())
    router.register(
        {
            "id": "cloud-brain",
            "label": "cloud-brain",
            "provider": "openai",
            "endpoint": "https://api.openai.com/v1",
            "role": "brain",
            "options": {"type": "cloud", "access": "free"},
        }
    )
    router.register(
        {
            "id": "local-coder",
            "label": "local-coder",
            "provider": "ollama",
            "endpoint": "http://127.0.0.1:11434",
            "role": "coder",
        }
    )
    router.register(
        {
            "id": "local-brain",
            "label": "local-brain",
            "provider": "ollama",
            "endpoint": "http://127.0.0.1:11434",
            "role": "brain",
        }
    )
    pick = router.best_available("brain")
    assert pick is not None
    assert pick.id == "local-brain"


def test_best_available_returns_none_when_empty():
    router = ModelRouter(FakeStorage())
    assert router.best_available("brain") is None
