"""A model reloaded from the kernel database must still be called by its provider name."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import privacy
import router
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


# --- the request body: reply cap and context window -------------------------------------------------------


class _Lines:
    status_code = 200
    headers: dict = {}

    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _Client:
    def __init__(self, lines):
        self.lines = lines
        self.bodies: list[dict] = []

    def stream(self, method, url, json=None, headers=None):
        self.bodies.append(json or {})
        return _Lines(self.lines)


class _Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def _ollama() -> Model:
    return Model(
        id="ollama:qwen3-8b",
        label="q",
        provider="ollama",
        endpoint="http://127.0.0.1:11434",
        options={"type": "local", "access": "free", "model": "qwen3:8b"},
    )


def _run(coro):
    return asyncio.run(coro)


async def _ollama_body(monkeypatch, **extra) -> dict:
    client = _Client([json.dumps({"message": {"role": "assistant", "content": "Hi."}, "done": True})])
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(_Store())
    [c async for c in engine._stream_ollama(_ollama(), [{"role": "user", "content": "hi"}], None, **extra)]
    return client.bodies[0]


def test_ollama_max_tokens_becomes_num_predict(monkeypatch):
    monkeypatch.setenv("FRIDAY_OLLAMA_NUM_CTX", "off")
    body = _run(_ollama_body(monkeypatch, max_tokens=180))
    assert body["options"] == {"num_predict": 180}


def test_ollama_without_a_cap_sends_no_num_predict(monkeypatch):
    monkeypatch.setenv("FRIDAY_OLLAMA_NUM_CTX", "off")
    body = _run(_ollama_body(monkeypatch))
    assert "options" not in body


def test_ollama_num_ctx_is_merged_into_the_gpu_options_not_over_them(monkeypatch):
    monkeypatch.delenv("FRIDAY_OLLAMA_NUM_CTX", raising=False)
    monkeypatch.setattr(router, "total_ram_gb", lambda: 32.0)
    body = _run(_ollama_body(monkeypatch, hardware_hint={"offload": "cpu"}, max_tokens=200))
    assert body["options"]["num_gpu"] == 0
    assert body["options"]["num_predict"] == 200
    window = router.ollama_num_ctx(32.0)
    assert window is not None and window >= 4096
    assert body["options"]["num_ctx"] == window


def test_num_ctx_comes_from_the_shared_config_and_is_clamped_by_ram(monkeypatch):
    monkeypatch.delenv("FRIDAY_OLLAMA_NUM_CTX", raising=False)
    configured = json.loads(
        (Path(router.__file__).resolve().parents[1] / "config" / "chat-tiers.json").read_text("utf-8")
    )["ollamaSettings"]["options"]["num_ctx"]
    assert router.ollama_num_ctx(64.0) == configured
    assert router.ollama_num_ctx(16.0) == configured
    at8, at4 = router.ollama_num_ctx(8.0), router.ollama_num_ctx(4.0)
    assert at8 is not None and at4 is not None
    assert at8 < configured
    assert at4 <= at8
    assert router.ollama_num_ctx(None) == configured  # RAM unknown: the configured value stands


def test_num_ctx_env_overrides_and_can_turn_it_off(monkeypatch):
    monkeypatch.setenv("FRIDAY_OLLAMA_NUM_CTX", "12288")
    assert router.ollama_num_ctx(8.0) == 12288
    for off in ("0", "off", "none"):
        monkeypatch.setenv("FRIDAY_OLLAMA_NUM_CTX", off)
        assert router.ollama_num_ctx(64.0) is None
    monkeypatch.setenv("FRIDAY_OLLAMA_NUM_CTX", "junk")
    assert router.ollama_num_ctx(64.0) is not None  # an unreadable value falls back to the config


@pytest.mark.parametrize("bad", [0, -5, "x", None, True, 1.5])
def test_a_bad_max_tokens_is_ignored(monkeypatch, bad):
    monkeypatch.setenv("FRIDAY_OLLAMA_NUM_CTX", "off")
    assert router.clean_max_tokens(bad) is None


def test_max_tokens_is_clamped_to_a_sane_ceiling():
    assert router.clean_max_tokens(180) == 180
    assert router.clean_max_tokens("200") == 200
    assert router.clean_max_tokens(10**9) == router.MAX_REPLY_TOKENS


def test_anthropic_body_carries_max_tokens(monkeypatch):
    client = _Client(
        [
            "data: "
            + json.dumps({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "A"}}),
        ]
    )
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(_Store())
    model = Model("claude-x", "c", "anthropic", "https://api.anthropic.com/v1", api_key="k")

    async def go(**kw):
        return [c async for c in engine._stream_anthropic(model, [{"role": "user", "content": "hi"}], None, **kw)]

    _run(go())
    assert client.bodies[-1]["max_tokens"] == 2048  # the old default is unchanged
    _run(go(max_tokens=180))
    assert client.bodies[-1]["max_tokens"] == 180


def test_openai_body_carries_max_tokens(monkeypatch):
    client = _Client(["data: " + json.dumps({"choices": [{"delta": {"content": "A"}}]}), "data: [DONE]"])
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(_Store())
    model = Model("gpt-x", "g", "openai-compatible", "http://127.0.0.1:8080/v1")

    async def go(**kw):
        return [c async for c in engine._stream_openai(model, [{"role": "user", "content": "hi"}], None, **kw)]

    _run(go())
    assert "max_tokens" not in client.bodies[-1]
    _run(go(max_tokens=180))
    assert client.bodies[-1]["max_tokens"] == 180


def test_stream_passes_the_cap_and_owner_text_down_only_when_set(monkeypatch):
    engine = ModelRouter(_Store())
    model = _ollama()
    engine._models[model.id] = model
    seen: list[dict] = []

    async def fake_one(self, mdl, messages, explicit_paid=False, **extra):
        seen.append(extra)
        yield "ok"

    monkeypatch.setattr(ModelRouter, "_stream_one", fake_one)

    async def go(**kw):
        return [c async for c in engine.stream(prompt="hi", model_ids=[model.id], **kw)]

    _run(go())
    assert "max_tokens" not in seen[-1] and "owner_text" not in seen[-1]
    _run(go(max_tokens=180, owner_text="file text"))
    assert seen[-1]["max_tokens"] == 180 and seen[-1]["owner_text"] == "file text"


def test_the_egress_check_reads_owner_text(monkeypatch):
    """A sensitive attachment with an innocent prompt must not reach a cloud model."""
    engine = ModelRouter(_Store())
    cloud = Model("gpt-5", "g", "openai", "https://api.openai.com/v1", api_key="k", options={"type": "cloud"})
    sentinel = "my pass" + "word is hunter2"

    async def go(owner_text):
        return [
            c
            async for c in engine._stream_one(
                cloud,
                [{"role": "user", "content": "summarise this"}],
                True,
                privacy_confirmed=True,
                owner_text=owner_text,
            )
        ]

    with pytest.raises(privacy.PrivacyBlocked):
        _run(go(sentinel))
