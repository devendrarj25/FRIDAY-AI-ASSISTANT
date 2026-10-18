"""Registered local models that are not installed are not a chat route."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import ModelRouter


class FakeStorage:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def test_seed_row_marks_a_local_registry_entry_unavailable():
    seeded = ModelRouter.seed_row(
        {
            "id": "coder-ds",
            "label": "DeepSeek Coder V2 16B",
            "provider": "ollama",
            "endpoint": "http://127.0.0.1:11434",
        }
    )
    assert seeded["status"] == "unavailable"
    ready = ModelRouter.seed_row(
        {
            "id": "coder-ds",
            "provider": "ollama",
            "endpoint": "http://127.0.0.1:11434",
            "status": "ready",
        }
    )
    assert ready["status"] == "ready"


def test_best_available_skips_uninstalled_local_models():
    router = ModelRouter(FakeStorage())
    router.register(
        ModelRouter.seed_row(
            {
                "id": "brain-qwen",
                "label": "Qwen2.5 32B Instruct",
                "provider": "llamacpp",
                "endpoint": "http://127.0.0.1:8080/v1",
            }
        )
    )
    assert router.best_available("brain") is None
    assert router.uninstalled_local_detail() == "no installed local model"
