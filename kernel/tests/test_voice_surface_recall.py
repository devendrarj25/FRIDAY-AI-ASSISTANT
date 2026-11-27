"""A spoken turn recalls memory on the short voice budget, boot starts the fallback merge, and the persona
is not sent twice on the voice surface."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router
from router import Model, ModelRouter


def test_chat_stream_recalls_with_the_voice_budget_on_the_voice_surface():
    source = MAIN.read_text(encoding="utf-8")
    assert 'memory.recall(params["prompt"], voice=' in source
    assert 'params.get("routingSurface") == "voice"' in source


def test_startup_starts_the_fallback_merge_without_awaiting_it():
    source = MAIN.read_text(encoding="utf-8")
    start = source.index("async def on_startup")
    body = source[start : source.index("\nasync def ", start + 10)]
    assert "merge_fallback()" in body
    assert "await memory.merge_fallback" not in body


MAIN = Path(__file__).resolve().parents[1] / "main.py"


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def _messages(monkeypatch, **kwargs) -> list[dict]:
    engine = ModelRouter(Store())
    model = Model(
        id="ollama:qwen3-8b",
        label="qwen3",
        provider="ollama",
        endpoint="http://127.0.0.1:11434",
        role="brain",
        options={"type": "local", "access": "free", "model": "qwen3:8b"},
    )
    engine._models[model.id] = model
    seen: list[list[dict]] = []

    async def fake_one(self, mdl, messages, explicit_paid=False, **extra):
        seen.append(list(messages))
        yield "ok"

    monkeypatch.setattr(ModelRouter, "_stream_one", fake_one)

    async def run():
        return [c async for c in engine.stream(model_ids=[model.id], **kwargs)]

    asyncio.run(run())
    return seen[0]


def test_voice_surface_does_not_prepend_the_kernel_persona(monkeypatch):
    messages = _messages(monkeypatch, prompt="hi", system="Lean voice prompt.", surface="voice")
    systems = [m["content"] for m in messages if m["role"] == "system"]
    assert systems == ["Lean voice prompt."]


def test_other_surfaces_keep_the_persona(monkeypatch):
    for surface in ("chat", None):
        messages = _messages(monkeypatch, prompt="hi", system="Only a tool list.", surface=surface)
        systems = [m["content"] for m in messages if m["role"] == "system"]
        assert systems[0] == router.friday_persona()


def test_voice_surface_without_any_system_text_still_has_an_identity(monkeypatch):
    messages = _messages(monkeypatch, prompt="hi", surface="voice")
    systems = [m["content"] for m in messages if m["role"] == "system"]
    assert systems == [router.friday_persona()]
