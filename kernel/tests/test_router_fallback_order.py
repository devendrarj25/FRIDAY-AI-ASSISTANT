"""Stream fallbacks follow the surface score; a desktop order stays; a dead local engine is skipped fast."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import Model, ModelRouter  # noqa: E402


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def build(*specs) -> ModelRouter:
    """specs: (id, provider, endpoint, kind, access, extra options) in registration (dict) order."""
    router = ModelRouter(Store())
    for mid, provider, endpoint, kind, access, extra in specs:
        router._models[mid] = Model(
            id=mid,
            label=mid,
            provider=provider,
            endpoint=endpoint,
            role="brain",
            options={"type": kind, "access": access, **extra},
        )
    return router


OLLAMA = "http://127.0.0.1:11434"
LMSTUDIO = "http://127.0.0.1:1234/v1"
GEMINI = "https://generativelanguage.googleapis.com"


def drive(router: ModelRouter, behaviours: dict, **kwargs):
    """Run router.stream with fake providers; `behaviours` maps a model id to an exception (else answers 'ok')."""
    attempted: list[str] = []

    async def fake(model, _messages, _explicit=False, **_kw):
        attempted.append(model.id)
        problem = behaviours.get(model.id)
        if problem is not None:
            raise problem
        yield "ok"

    setattr(router, "_stream_one", fake)  # noqa: B010 — a fake provider call, not a typed override

    async def run():
        return [event async for event in router.stream(prompt="hello", **kwargs)]

    return attempted, asyncio.run(run())


def test_voice_fallbacks_are_ranked_latency_first_not_in_dict_order():
    router = build(
        ("ollama:slow", "ollama", OLLAMA, "local", "free", {"avg_ms": 900, "quality": 0.9}),
        ("gemini:flash", "gemini", GEMINI, "cloud", "free", {"avg_ms": 50}),
        ("lmstudio:fast", "lmstudio", LMSTUDIO, "local", "free", {"avg_ms": 100, "quality": 0.1}),
        ("groq:primary", "groq", "https://api.groq.com", "cloud", "free", {}),
    )
    attempted, _ = drive(
        router,
        {
            "groq:primary": RuntimeError("HTTP 500"),
            "lmstudio:fast": RuntimeError("down"),
            "ollama:slow": RuntimeError("x"),
        },
        model_ids=["groq:primary"],
        surface="voice",
    )
    assert attempted == ["groq:primary", "lmstudio:fast", "ollama:slow", "gemini:flash"]


def test_chat_fallbacks_are_ranked_quality_first():
    router = build(
        ("ollama:fast", "ollama", OLLAMA, "local", "free", {"avg_ms": 100, "quality": 0.2}),
        ("lmstudio:deep", "lmstudio", LMSTUDIO, "local", "free", {"avg_ms": 900, "quality": 0.9}),
        ("groq:primary", "groq", "https://api.groq.com", "cloud", "free", {}),
    )
    attempted, _ = drive(
        router,
        {"groq:primary": RuntimeError("HTTP 500"), "lmstudio:deep": RuntimeError("down")},
        model_ids=["groq:primary"],
        surface="chat",
    )
    assert attempted == ["groq:primary", "lmstudio:deep", "ollama:fast"]


def test_desktop_order_is_primary_and_only_the_tail_is_ranked():
    router = build(
        ("ollama:a", "ollama", OLLAMA, "local", "free", {"avg_ms": 100}),
        ("lmstudio:b", "lmstudio", LMSTUDIO, "local", "free", {"avg_ms": 900}),
        ("gemini:d", "gemini", GEMINI, "cloud", "free", {"avg_ms": 20}),
        ("groq:c", "groq", "https://api.groq.com", "cloud", "free", {"avg_ms": 10}),
    )
    boom = RuntimeError("HTTP 500")
    # The desktop ranked b before a (it knows things the kernel does not); both fail, so the tail is reached.
    attempted, _ = drive(
        router,
        {"lmstudio:b": boom, "ollama:a": boom, "groq:c": boom},
        model_ids=["lmstudio:b", "ollama:a"],
        parallel=False,
        surface="voice",
    )
    assert attempted == ["lmstudio:b", "ollama:a", "groq:c", "gemini:d"]


def test_private_never_reaches_cloud_even_when_cloud_ranks_best():
    router = build(
        ("ollama:a", "ollama", OLLAMA, "local", "free", {"avg_ms": 900}),
        ("groq:c", "groq", "https://api.groq.com", "cloud", "free", {"avg_ms": 1, "quality": 1.0}),
        ("lmstudio:b", "lmstudio", LMSTUDIO, "local", "free", {"avg_ms": 100}),
    )
    attempted, events = drive(
        router,
        {"ollama:a": RuntimeError("down")},
        model_ids=["ollama:a", "groq:c"],
        privacy="private",
        surface="voice",
    )
    assert attempted == ["ollama:a", "lmstudio:b"]
    assert any(e.get("delta") == "ok" for e in events)


def test_paid_models_stay_blocked_in_the_ranked_tail():
    router = build(
        ("ollama:a", "ollama", OLLAMA, "local", "free", {}),
        ("openai:paid", "openai", "https://api.openai.com/v1", "cloud", "paid", {"avg_ms": 1, "quality": 1.0}),
        ("groq:c", "groq", "https://api.groq.com", "cloud", "free", {"avg_ms": 500}),
    )
    attempted, _ = drive(router, {"ollama:a": RuntimeError("x")}, model_ids=["ollama:a"], surface="chat")
    assert "openai:paid" not in attempted
    assert attempted == ["ollama:a", "groq:c"]


def test_dead_local_engine_is_skipped_for_the_rest_of_the_turn_and_next_turns():
    router = build(
        ("ollama:a", "ollama", OLLAMA, "local", "free", {"avg_ms": 100}),
        ("ollama:b", "ollama", OLLAMA, "local", "free", {"avg_ms": 120}),
        ("gemini:d", "gemini", GEMINI, "cloud", "free", {"avg_ms": 300}),
    )
    refused = httpx.ConnectError("All connection attempts failed")
    attempted, events = drive(
        router, {"ollama:a": refused, "ollama:b": refused}, model_ids=["ollama:a"], surface="voice"
    )
    # b shares the dead engine, so the live cloud model answers before it is retried.
    assert attempted == ["ollama:a", "gemini:d"]
    assert any(e.get("delta") == "ok" for e in events)
    # The next turn does not spend a connect attempt on the dead engine first.
    attempted, events = drive(
        router, {"ollama:a": refused, "ollama:b": refused}, model_ids=["ollama:a"], surface="voice"
    )
    assert attempted[0] == "gemini:d"
    assert any(e.get("delta") == "ok" for e in events)


def test_dead_engine_mark_expires_and_a_last_resort_still_tries_it():
    router = build(("ollama:a", "ollama", OLLAMA, "local", "free", {}))
    now = [1000.0]
    router._dead_clock = lambda: now[0]
    refused = httpx.ConnectError("All connection attempts failed")
    attempted, events = drive(router, {"ollama:a": refused}, model_ids=["ollama:a"])
    assert attempted == ["ollama:a"]
    assert len([e for e in events if e.get("error")]) == 1
    # Owner started Ollama a moment later: the only candidate is tried again, never silently dropped.
    attempted, events = drive(router, {}, model_ids=["ollama:a"])
    assert attempted == ["ollama:a"]
    assert any(e.get("delta") == "ok" for e in events)
    # And the success cleared the mark: it leads the chain again.
    router2 = build(
        ("ollama:a", "ollama", OLLAMA, "local", "free", {}),
        ("gemini:d", "gemini", GEMINI, "cloud", "free", {}),
    )
    router2._dead_clock = lambda: now[0]
    drive(router2, {"ollama:a": refused}, model_ids=["ollama:a"])
    now[0] += 3600
    attempted, _ = drive(router2, {}, model_ids=["ollama:a"])
    assert attempted == ["ollama:a"]


def test_a_missing_model_404_skips_that_model_not_the_whole_engine():
    router = build(
        ("ollama:gone", "ollama", OLLAMA, "local", "free", {"avg_ms": 100}),
        ("ollama:here", "ollama", OLLAMA, "local", "free", {"avg_ms": 200}),
        ("gemini:d", "gemini", GEMINI, "cloud", "free", {"avg_ms": 300}),
    )
    missing = RuntimeError("HTTP 404 — the provider does not expose this model id: model 'gone' not found")
    attempted, events = drive(router, {"ollama:gone": missing}, model_ids=["ollama:gone"], surface="voice")
    assert attempted == ["ollama:gone", "ollama:here"]
    assert any(e.get("delta") == "ok" for e in events)
    attempted, _ = drive(router, {"ollama:gone": missing}, model_ids=["ollama:gone"], surface="voice")
    assert attempted[0] == "ollama:here"


def test_one_clear_error_only_when_nothing_is_left():
    router = build(
        ("ollama:a", "ollama", OLLAMA, "local", "free", {}),
        ("gemini:d", "gemini", GEMINI, "cloud", "free", {}),
    )
    refused = httpx.ConnectError("All connection attempts failed")
    attempted, events = drive(
        router, {"ollama:a": refused, "gemini:d": RuntimeError("HTTP 500")}, model_ids=["ollama:a"]
    )
    errors = [e for e in events if e.get("error")]
    assert len(errors) == 1
    assert "ollama:a" in errors[0]["error"] and "gemini:d" in errors[0]["error"]
    assert not any(e.get("delta") for e in events)
