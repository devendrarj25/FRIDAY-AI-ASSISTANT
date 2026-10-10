"""Voice and chat surfaces share spendable models and rank latency only when asked."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import ModelRouter


class FakeStorage:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def _router():
    router = ModelRouter(FakeStorage())
    router.register(
        {
            "id": "local-slow",
            "label": "local-slow",
            "provider": "ollama",
            "endpoint": "http://127.0.0.1:11434",
            "role": "brain",
            "options": {"type": "local", "access": "free", "latency_ms": 900, "quality": 0.9},
        }
    )
    router.register(
        {
            "id": "local-fast",
            "label": "local-fast",
            "provider": "ollama",
            "endpoint": "http://127.0.0.1:11434",
            "role": "brain",
            "options": {"type": "local", "access": "free", "latency_ms": 80, "quality": 0.2},
        }
    )
    return router


def test_voice_surface_prefers_lower_latency():
    pick = _router().best_available("brain", surface="voice")
    assert pick is not None
    assert pick.id == "local-fast"


def test_default_surface_stays_role_and_local():
    pick = _router().best_available("brain")
    assert pick is not None
    assert pick.id in {"local-slow", "local-fast"}


def test_chat_surface_can_prefer_quality():
    pick = _router().best_available("brain", surface="chat")
    assert pick is not None
    assert pick.id == "local-slow"


def test_paid_cloud_stays_out_of_both_surfaces():
    router = _router()
    router.register(
        {
            "id": "paid-fast",
            "label": "paid-fast",
            "provider": "openai",
            "endpoint": "https://api.openai.com/v1",
            "role": "brain",
            "options": {"type": "cloud", "access": "paid", "latency_ms": 10, "quality": 1.0},
        }
    )
    voice = router.best_available("brain", surface="voice")
    chat = router.best_available("brain", surface="chat")
    assert voice is not None and voice.id == "local-fast"
    assert chat is not None and chat.id == "local-slow"
