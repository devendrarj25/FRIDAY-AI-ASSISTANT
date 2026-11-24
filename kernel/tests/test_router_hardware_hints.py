"""The desktop's per-model hardware hint reaches the local engine request, and only where that engine takes it."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router
from router import Model, ModelRouter, gpu_options_for, normalise_hardware_hints


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


class Lines:
    status_code = 200

    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line


ANSWER = json.dumps({"message": {"role": "assistant", "content": "Hi."}, "done": True})


class Capture:
    """A fake Ollama: records every request body and answers once."""

    def __init__(self):
        self.bodies: list[dict] = []

    def stream(self, method, url, json=None, headers=None):
        self.bodies.append(json or {})
        return Lines([ANSWER])


def ollama_model(mid: str = "ollama:qwen3-8b") -> Model:
    return Model(
        id=mid,
        label=mid,
        provider="ollama",
        endpoint="http://127.0.0.1:11434",
        role="brain",
        options={"type": "local", "access": "free", "model": "qwen3:8b"},
    )


async def run_ollama(monkeypatch, hint) -> dict:
    client = Capture()
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    chunks = [
        c
        async for c in engine._stream_ollama(
            ollama_model(),
            [{"role": "user", "content": "hi"}],
            None,
            **({} if hint is None else {"hardware_hint": hint}),
        )
    ]
    assert chunks == ["Hi."]
    return client.bodies[0]


@pytest.mark.asyncio
async def test_cpu_hint_sets_num_gpu_zero_and_keeps_keep_alive(monkeypatch) -> None:
    body = await run_ollama(monkeypatch, {"offload": "cpu", "fit": "cpu", "needGb": 5.2})
    assert body["options"] == {"num_gpu": 0}
    assert body["keep_alive"] == router.ollama_keep_alive()
    assert body["stream"] is True and body["model"] == "qwen3:8b"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "hint",
    [
        None,
        {},
        {"offload": "gpu"},
        {"offload": "gpu-if-supported"},
        {"offload": None},
        {"offload": "CPU"},
        {"offload": " cpu"},
        {"offload": 0},
        {"offload": True},
        {"offload": ["cpu"]},
        {"offload": "turbo"},
        "cpu",
        ["cpu"],
        7,
    ],
)
async def test_other_or_invalid_hints_leave_the_request_exactly_as_today(monkeypatch, hint) -> None:
    body = await run_ollama(monkeypatch, hint)
    baseline = await run_ollama(monkeypatch, None)
    assert body == baseline
    assert "options" not in body


@pytest.mark.asyncio
async def test_thinking_field_and_gpu_option_coexist(monkeypatch) -> None:
    client = Capture()
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    model = ollama_model()
    model.options["capabilities"] = {"reasoningControl": {"control": "enable_thinking"}}
    _ = [
        c
        async for c in engine._stream_ollama(
            model, [{"role": "user", "content": "hi"}], "high", hardware_hint={"offload": "cpu"}
        )
    ]
    assert client.bodies[0]["think"] is True
    assert client.bodies[0]["options"] == {"num_gpu": 0}


def test_gpu_options_for_never_forces_a_gpu() -> None:
    assert gpu_options_for({"offload": "cpu"}) == {"num_gpu": 0}
    for hint in ({"offload": "gpu"}, {"offload": "gpu-if-supported"}, {}, None, "cpu", {"offload": "x"}):
        assert gpu_options_for(hint) == {}


def test_normalise_keeps_only_known_offload_values_and_bounded_ids() -> None:
    raw = {
        "a": {"offload": "cpu", "fit": "cpu", "needGb": 4.1, "secret": "drop me"},
        "b": {"offload": "gpu"},
        "c": {"offload": "gpu-if-supported"},
        "d": {"offload": "weird"},
        "e": {"offload": None},
        "f": "cpu",
        7: {"offload": "cpu"},
        "x" * 400: {"offload": "cpu"},
        "": {"offload": "cpu"},
    }
    assert normalise_hardware_hints(raw) == {
        "a": {"offload": "cpu"},
        "b": {"offload": "gpu"},
        "c": {"offload": "gpu-if-supported"},
    }
    for junk in (None, [], "cpu", 3, {"a": None}):
        assert normalise_hardware_hints(junk) == {}
    big = {f"m{i}": {"offload": "cpu"} for i in range(500)}
    assert len(normalise_hardware_hints(big)) <= 64


def _router_with(*models: Model) -> ModelRouter:
    engine = ModelRouter(Store())
    for model in models:
        engine._models[model.id] = model
    return engine


def _drive(engine: ModelRouter, **kwargs):
    seen: list[tuple[str, tuple, dict]] = []

    async def fake_ollama(model, messages, effort=None, **kw):
        seen.append((model.id, (effort,), kw))
        yield "ok"

    async def fake_openai(model, messages, *args, **kw):
        seen.append((model.id, args, kw))
        yield "ok"

    setattr(engine, "_stream_ollama", fake_ollama)  # noqa: B010 — a fake engine call, not a typed override
    setattr(engine, "_stream_openai", fake_openai)  # noqa: B010

    async def run():
        return [event async for event in engine.stream(prompt="hello", **kwargs)]

    events = asyncio.run(run())
    return seen, events


def test_stream_hands_the_hint_only_to_the_model_it_names() -> None:
    engine = _router_with(ollama_model("ollama:a"), ollama_model("ollama:b"))
    seen, events = _drive(
        engine,
        model_ids=["ollama:a"],
        allow_fallback=False,
        hardware_hints={"ollama:a": {"offload": "cpu"}, "ollama:b": {"offload": "cpu"}, "ghost": {"offload": "cpu"}},
    )
    assert [row[0] for row in seen] == ["ollama:a"]
    assert seen[0][2] == {"hardware_hint": {"offload": "cpu"}}
    assert not any(e.get("error") for e in events)
    assert "ghost" not in engine._models and len(engine._models) == 2


def test_stream_without_a_hint_calls_the_engine_with_the_old_shape() -> None:
    engine = _router_with(ollama_model("ollama:a"))
    seen, _ = _drive(engine, model_ids=["ollama:a"], allow_fallback=False)
    assert seen == [("ollama:a", (None,), {})]
    seen, _ = _drive(
        _router_with(ollama_model("ollama:a")),
        model_ids=["ollama:a"],
        allow_fallback=False,
        hardware_hints={"ollama:a": {"offload": "turbo"}},
    )
    assert seen == [("ollama:a", (None,), {})]


def test_openai_wire_engines_are_untouched_by_a_hint() -> None:
    """llama.cpp server and LM Studio set GPU offload at launch or load time, never per request."""
    llama = Model(
        id="llamacpp:q",
        label="q",
        provider="llamacpp",
        endpoint="http://127.0.0.1:8080/v1",
        role="brain",
        options={"type": "local", "access": "free"},
    )
    lms = Model(
        id="lmstudio:q",
        label="q",
        provider="lmstudio",
        endpoint="http://127.0.0.1:1234/v1",
        role="brain",
        options={"type": "local", "access": "free"},
    )
    for model in (llama, lms):
        seen, _ = _drive(
            _router_with(model),
            model_ids=[model.id],
            allow_fallback=False,
            hardware_hints={model.id: {"offload": "cpu"}},
        )
        assert seen == [(model.id, (None,), {})]


def test_a_hint_never_widens_a_private_or_local_only_turn() -> None:
    cloud = Model(
        id="openai:gpt",
        label="gpt",
        provider="openai",
        endpoint="https://api.openai.com/v1",
        role="brain",
        options={"type": "cloud", "access": "free"},
    )
    engine = _router_with(ollama_model("ollama:a"), cloud)
    seen, _ = _drive(
        engine,
        model_ids=["openai:gpt"],
        allow_fallback=False,
        privacy="private",
        hardware_hints={"openai:gpt": {"offload": "cpu"}, "ollama:a": {"offload": "cpu"}},
    )
    assert all(row[0] != "openai:gpt" for row in seen)


def test_main_reads_hardware_hints_from_the_request() -> None:
    text = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    assert 'hardware_hints=params.get("hardwareHints")' in text
