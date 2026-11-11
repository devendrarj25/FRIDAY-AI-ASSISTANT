"""A model reloaded from the kernel database must still be called by its provider name."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import Model, ModelRouter


class RowStorage:
    def __init__(self, rows):
        self.rows = rows

    def models(self):
        return self.rows

    def upsert_model(self, _row):
        return None


def test_reloaded_ollama_row_sends_the_bare_tag():
    row = {
        "id": "ollama:qwen3:4b",
        "label": "Ollama · qwen3:4b",
        "provider": "ollama",
        "endpoint": "http://127.0.0.1:11434",
        "role": "brain",
        "api_key": None,
        "params": "",
        "context_k": 8,
        "status": "ready",
    }
    router = ModelRouter(RowStorage([row]))
    assert router._models["ollama:qwen3:4b"].wire_model == "qwen3:4b"


def test_desktop_named_model_wins_and_other_ids_stay_whole():
    named = Model("ollama:x", "x", "ollama", "http://h", options={"model": "x:1b"})
    assert named.wire_model == "x:1b"
    cloud = Model("gpt-4o", "g", "online", "http://h")
    assert cloud.wire_model == "gpt-4o"
