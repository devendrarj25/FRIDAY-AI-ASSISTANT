"""Two local brains for voice: the small model listed under voice.tags in config/chat-tiers.json takes a quick
spoken side line; the main model answers the real work. Both firewalls still run on whatever is picked."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router as router_module  # noqa: E402
from router import ModelRouter, is_voice_fast_model, voice_fast_tags  # noqa: E402

TAGS = ["qwen3.5:0.8b", "qwen3.5:2b"]


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def local(mid: str, **extra) -> dict:
    return {
        "id": mid,
        "label": mid,
        "provider": "ollama",
        "endpoint": "http://127.0.0.1:11434",
        "role": extra.pop("role", "brain"),
        **extra,
    }


def cloud(mid: str, access: str = "free") -> dict:
    return {
        "id": mid,
        "label": mid,
        "provider": "openai",
        "endpoint": "https://api.example.test/v1",
        "role": "brain",
        "options": {"type": "cloud", "access": access},
    }


def build(tmp_path: Path, monkeypatch, *specs: dict, tags=TAGS) -> ModelRouter:
    plan = tmp_path / "chat-tiers.json"
    plan.write_text(json.dumps({"voice": {"tags": tags}} if tags is not None else {}), encoding="utf-8")
    monkeypatch.setattr(router_module, "_CHAT_TIERS_PATH", plan)
    router = ModelRouter(Store())
    for spec in specs:
        router.register(spec)
    return router


def test_tags_come_from_the_plan_file_and_garbage_gives_none(tmp_path, monkeypatch):
    build(tmp_path, monkeypatch)
    assert voice_fast_tags() == TAGS
    plan = tmp_path / "chat-tiers.json"
    for raw in ("{}", '{"voice": {"tags": "qwen3.5:2b"}}', '{"voice": {"tags": [3, null, ""]}}', "not json"):
        plan.write_text(raw, encoding="utf-8")
        assert voice_fast_tags() == []
    plan.unlink()
    assert voice_fast_tags() == []


def test_a_model_is_fast_only_by_exact_tag_and_only_when_local(tmp_path, monkeypatch):
    router = build(
        tmp_path,
        monkeypatch,
        local("ollama:qwen3.5:2b"),
        local("ollama:qwen3.5:9b"),
        local("ollama:myqwen3.5:2b"),
        local("ollama:qwen3.5:2b-instruct"),
        cloud("groq:qwen3.5:2b"),
    )
    by_id = {m.id: m for m in router.models()}
    assert is_voice_fast_model(by_id["ollama:qwen3.5:2b"])
    for other in ("ollama:qwen3.5:9b", "ollama:myqwen3.5:2b", "ollama:qwen3.5:2b-instruct", "groq:qwen3.5:2b"):
        assert not is_voice_fast_model(by_id[other]), other
    assert not is_voice_fast_model(by_id["ollama:qwen3.5:2b"], [])


def test_an_installed_voice_tag_model_has_role_fast(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:2b"), local("ollama:qwen3.5:9b"))
    roles = {m.id: m.role for m in router.models()}
    assert roles == {"ollama:qwen3.5:2b": "fast", "ollama:qwen3.5:9b": "brain"}


def test_quick_voice_lane_prefers_the_fast_model(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:9b"), local("ollama:qwen3.5:2b"))
    pick = router.pick_voice_fast({}, surface="voice", lane="quick")
    assert pick is not None and pick.id == "ollama:qwen3.5:2b"


def test_the_full_lane_chat_surface_and_no_lane_never_take_it(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:9b"), local("ollama:qwen3.5:2b"))
    for surface, lane in (("voice", "full"), ("voice", None), ("chat", "quick"), (None, "quick"), ("voice", "x")):
        assert router.pick_voice_fast({}, surface=surface, lane=lane) is None, (surface, lane)


def test_a_turn_escalate_sends_up_never_goes_to_the_fast_model(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:9b"), local("ollama:qwen3.5:2b"))
    hard = ({"hard_reasoning": True}, {"code_beyond_core": True}, {"context_tokens": 40000}, {"audio_seconds": 90})
    for meta in hard:
        assert router.pick_voice_fast(meta, surface="voice", lane="quick") is None, meta


def test_no_fast_model_installed_means_no_change(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:9b"), cloud("groq:x"))
    assert router.pick_voice_fast({}, surface="voice", lane="quick") is None
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:2b"), tags=[])
    assert router.pick_voice_fast({}, surface="voice", lane="quick") is None


def test_an_unready_or_non_chat_fast_model_is_never_picked(tmp_path, monkeypatch):
    router = build(
        tmp_path,
        monkeypatch,
        local("ollama:qwen3.5:9b"),
        local("ollama:qwen3.5:2b", status="unavailable"),
        local("ollama:qwen3.5:0.8b", options={"capabilities": {"chat": False}}),
    )
    assert router.pick_voice_fast({}, surface="voice", lane="quick") is None


def drive(router: ModelRouter, prompt: str, **kw):
    called: list[str] = []

    async def wire(model, _messages, _effort=None, **_kw):
        called.append(model.id)
        yield "ok"

    setattr(router, "_stream_ollama", wire)  # noqa: B010 — a fake local wire; the guards stay real

    async def run():
        return [e async for e in router.stream(prompt=prompt, **kw)]

    return called, asyncio.run(run())


def test_stream_routes_a_quick_voice_line_to_the_fast_model_and_the_real_turn_to_the_main_one(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:9b"), local("ollama:qwen3.5:2b"))
    quick, _ = drive(router, "ek minute, kya time hua?", surface="voice", lane="quick")
    assert quick == ["ollama:qwen3.5:2b"]
    full, _ = drive(router, "ek minute, kya time hua?", surface="voice", lane="full")
    assert full == ["ollama:qwen3.5:9b"]


def test_stream_sensitive_quick_line_stays_off_cloud_and_a_fast_model_does_not_change_that(tmp_path, monkeypatch):
    router = build(tmp_path, monkeypatch, local("ollama:qwen3.5:2b"), cloud("groq:big"))
    called, _ = drive(
        router, "my password is hunter2 and my card number is 4111 1111 1111 1111", surface="voice", lane="quick"
    )
    assert called == ["ollama:qwen3.5:2b"]
