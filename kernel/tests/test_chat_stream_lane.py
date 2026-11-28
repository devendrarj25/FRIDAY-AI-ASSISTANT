"""chat.stream hands the voice lane to the router, and the one small voice model of a small PC answers every lane."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router as router_module
from router import ModelRouter

MAIN = Path(__file__).resolve().parents[1] / "main.py"
TAGS = ["qwen3.5:0.8b", "qwen3.5:2b"]


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def local(mid: str) -> dict:
    return {"id": mid, "label": mid, "provider": "ollama", "endpoint": "http://127.0.0.1:11434", "role": "brain"}


def build(tmp_path: Path, monkeypatch, *specs: dict) -> ModelRouter:
    plan = tmp_path / "chat-tiers.json"
    plan.write_text(json.dumps({"voice": {"tags": TAGS}}), encoding="utf-8")
    monkeypatch.setattr(router_module, "_CHAT_TIERS_PATH", plan)
    router = ModelRouter(Store())
    for spec in specs:
        router.register(spec)
    return router


def drive(router: ModelRouter, **kw) -> list[str]:
    called: list[str] = []

    async def wire(model, _messages, _effort=None, **_kw):
        called.append(model.id)
        yield "ok"

    setattr(router, "_stream_ollama", wire)  # noqa: B010 - a fake local wire; the guards stay real

    async def run():
        return [e async for e in router.stream(prompt="ek minute, kya time hua?", surface="voice", **kw)]

    asyncio.run(run())
    return called


def test_chat_stream_passes_only_a_known_lane_to_the_router():
    source = MAIN.read_text(encoding="utf-8")
    assert 'lane=params.get("lane") if params.get("lane") in ("quick", "full") else None,' in source
    call = source[source.index("async for delta in router.stream(") :]
    assert call.index("surface=") < call.index("lane=") < call.index("reasoning_effort=")


def test_the_only_local_model_is_a_voice_tag_and_answers_every_lane(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:2b"))
    for lane in ("quick", "full", None):
        assert drive(router, lane=lane) == ["ollama:qwen3.5:2b"], lane


def test_a_twin_splits_the_lanes_and_no_lane_keeps_the_main_model(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:9b"), local("ollama:qwen3.5:2b"))
    assert drive(router, lane="quick") == ["ollama:qwen3.5:2b"]
    assert drive(router, lane="full") == ["ollama:qwen3.5:9b"]
    assert drive(router, lane=None) == drive(router, lane="full")
