"""Each model gets the thinking field its provider takes, and a model with no control gets the old request."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import reasoning_control as rc
import router
from router import Model, ModelRouter


def opts(control: str, keep: bool = False) -> dict:
    return {"capabilities": {"reasoningControl": {"control": control, "keepAcrossToolTurns": keep}}}


def test_spec_reads_the_record_and_falls_back_to_none() -> None:
    assert rc.spec_for(opts("effort"), "high") == rc.Spec("effort", "high", 16000, False)
    assert rc.spec_for(opts("effort"), "bogus").effort == "medium"
    assert rc.spec_for(opts("budget", True), "low") == rc.Spec("budget", "low", 1024, True)
    for bad in (None, {}, {"capabilities": {}}, opts("turbo"), {"capabilities": {"reasoningControl": "x"}}):
        assert rc.spec_for(bad, "high") is rc.NONE
    assert not rc.spec_for(opts("always"), "high").active
    assert not rc.spec_for(opts("none"), "high").active


def test_fields_per_wire() -> None:
    body = rc.anthropic_fields(rc.spec_for(opts("effort"), "high"), {"max_tokens": 2048})
    assert body["thinking"] == {"type": "adaptive"} and body["output_config"] == {"effort": "high"}
    assert body["max_tokens"] >= 16000 + 2048
    legacy = rc.anthropic_fields(rc.spec_for(opts("budget"), "medium"), {"max_tokens": 2048})
    assert legacy["thinking"] == {"type": "enabled", "budget_tokens": 4096}
    assert legacy["max_tokens"] > 4096  # the budget must stay below max_tokens
    assert rc.openai_fields(rc.spec_for(opts("effort"), "low"), {})["reasoning_effort"] == "low"
    assert rc.openai_fields(rc.spec_for(opts("enable_thinking"), "high"), {})["chat_template_kwargs"] == {
        "enable_thinking": True
    }
    assert rc.openai_fields(rc.spec_for(opts("enable_thinking"), "low"), {})["chat_template_kwargs"] == {
        "enable_thinking": False
    }
    assert rc.ollama_fields(rc.spec_for(opts("enable_thinking"), "high"), {})["think"] is True
    assert rc.ollama_fields(rc.spec_for(opts("effort"), "medium"), {})["think"] == "medium"
    untouched = {"model": "x"}
    for fn in (rc.anthropic_fields, rc.openai_fields, rc.ollama_fields):
        assert fn(rc.spec_for(opts("none"), "high"), dict(untouched)) == untouched
        assert fn(rc.spec_for(opts("always"), "high"), dict(untouched)) == untouched


class Store:
    def models(self):
        return []


class Tools:
    def model_schemas(self):
        return [
            {
                "type": "function",
                "function": {
                    "name": "fs_read",
                    "description": "Read a file.",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
                },
            }
        ]

    async def execute_for_model(self, name, args):
        return {"ok": True, "text": "file text"}


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


class Scripted:
    def __init__(self, rounds):
        self.rounds = rounds
        self.bodies: list[dict] = []

    def stream(self, method, url, json=None, headers=None):
        self.bodies.append(json or {})
        return Lines(self.rounds[min(len(self.bodies) - 1, len(self.rounds) - 1)])


def sse(*events: dict) -> list[str]:
    return [f"data: {json.dumps(e)}" for e in events]


@pytest.mark.asyncio
async def test_claude_thinking_is_sent_and_kept_across_a_tool_round(monkeypatch) -> None:
    first = sse(
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}},
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "I should read it."},
        },
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig123"}},
        {
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "tool_use", "id": "t1", "name": "fs_read"},
        },
        {
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": '{"path":"a.txt"}'},
        },
    )
    second = sse({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Done."}})
    client = Scripted([first, second])
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    engine.tools = Tools()
    model = Model(
        id="claude-opus-5-5",
        label="c",
        provider="anthropic",
        endpoint="https://api.anthropic.com/v1",
        api_key="k",
        options=opts("effort", keep=True),
    )
    out = "".join([c async for c in engine._stream_anthropic(model, [{"role": "user", "content": "read a"}], "high")])
    assert "Done." in out and "I should read it." not in out  # thinking is never answer text
    sent = client.bodies[0]
    assert sent["thinking"] == {"type": "adaptive"} and sent["output_config"] == {"effort": "high"}
    follow = client.bodies[1]["messages"]
    assistant = next(m for m in follow if m["role"] == "assistant")
    assert assistant["content"][0] == {"type": "thinking", "thinking": "I should read it.", "signature": "sig123"}
    assert assistant["content"][1]["type"] == "tool_use"


@pytest.mark.asyncio
async def test_a_model_without_a_control_gets_the_old_request(monkeypatch) -> None:
    client = Scripted([sse({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi"}})])
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    model = Model(
        id="claude-3-5-sonnet", label="c", provider="anthropic", endpoint="https://api.anthropic.com/v1", api_key="k"
    )
    chunks = [c async for c in engine._stream_anthropic(model, [{"role": "user", "content": "hi"}], "high")]
    assert chunks == ["Hi"]
    assert set(client.bodies[0]) == {"model", "max_tokens", "stream", "messages"}
    assert client.bodies[0]["max_tokens"] == 2048


@pytest.mark.asyncio
async def test_openai_compatible_thinking_is_sent_and_reasoning_text_is_not_the_answer(monkeypatch) -> None:
    frames = [
        f"data: {json.dumps({'choices': [{'delta': {'reasoning_content': 'let me think'}}]})}",
        f"data: {json.dumps({'choices': [{'delta': {'content': 'Answer.'}}]})}",
        "data: [DONE]",
    ]
    client = Scripted([frames])
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    model = Model(
        id="qwen3:8b",
        label="q",
        provider="openai",
        endpoint="http://127.0.0.1:8000/v1",
        options=opts("enable_thinking", True),
    )
    chunks = [c async for c in engine._stream_openai(model, [{"role": "user", "content": "hi"}], "low")]
    assert chunks == ["Answer."]
    assert client.bodies[0]["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.asyncio
async def test_ollama_think_field(monkeypatch) -> None:
    client = Scripted(
        [[json.dumps({"message": {"role": "assistant", "content": "Hi.", "thinking": "hmm"}, "done": True})]]
    )
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    model = Model(
        id="qwen3:8b", label="q", provider="ollama", endpoint="http://127.0.0.1:11434", options=opts("enable_thinking")
    )
    chunks = [c async for c in engine._stream_ollama(model, [{"role": "user", "content": "hi"}], "high")]
    assert chunks == ["Hi."] and client.bodies[0]["think"] is True
