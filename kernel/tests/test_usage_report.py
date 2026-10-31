"""Token counts a provider itself reports travel on the delta channel; nothing is invented when it reports none."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router
from router import Model, ModelRouter, fold_stream_piece, usage_notice


class Store:
    def models(self):
        return []


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
    def __init__(self, lines):
        self.lines = lines
        self.bodies: list[dict] = []

    def stream(self, method, url, json=None, headers=None):
        self.bodies.append(json or {})
        return Lines(self.lines)


def pieces(raw: list) -> list[dict]:
    out = []
    for item in raw:
        piece = fold_stream_piece("m", item)
        if piece:
            out.append(piece)
    return out


def test_the_notice_round_trips_and_rejects_nonsense() -> None:
    assert fold_stream_piece("m", usage_notice(12, 34)) == {
        "modelId": "m",
        "usage": {"promptTokens": 12, "completionTokens": 34},
    }
    assert fold_stream_piece("m", usage_notice(0, 0)) is None
    assert fold_stream_piece("m", "\x1eusage:abc") is None
    assert fold_stream_piece("m", "\x1eusage:-3,4") is None
    assert fold_stream_piece("m", "plain text") == {"modelId": "m", "delta": "plain text"}


@pytest.mark.asyncio
async def test_openai_usage_frame_is_reported_and_requested_only_where_it_is_documented(monkeypatch) -> None:
    frames = [
        f"data: {json.dumps({'choices': [{'delta': {'content': 'Hi'}}]})}",
        f"data: {json.dumps({'choices': [], 'usage': {'prompt_tokens': 11, 'completion_tokens': 3}})}",
        "data: [DONE]",
    ]
    client = Scripted(frames)
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    openai = Model(id="gpt", label="g", provider="openai", endpoint="https://api.openai.com/v1", api_key="k")
    out = pieces([c async for c in engine._stream_openai(openai, [{"role": "user", "content": "hi"}])])
    assert out == [
        {"modelId": "m", "delta": "Hi"},
        {"modelId": "m", "usage": {"promptTokens": 11, "completionTokens": 3}},
    ]
    assert client.bodies[0]["stream_options"] == {"include_usage": True}

    other = Model(id="x", label="x", provider="openai", endpoint="http://127.0.0.1:8000/v1")
    client.bodies.clear()
    [c async for c in engine._stream_openai(other, [{"role": "user", "content": "hi"}])]
    assert "stream_options" not in client.bodies[0]


@pytest.mark.asyncio
async def test_no_usage_means_no_notice(monkeypatch) -> None:
    client = Scripted([f"data: {json.dumps({'choices': [{'delta': {'content': 'Hi'}}]})}", "data: [DONE]"])
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    model = Model(id="x", label="x", provider="openai", endpoint="http://127.0.0.1:8000/v1")
    assert [c async for c in engine._stream_openai(model, [{"role": "user", "content": "hi"}])] == ["Hi"]


@pytest.mark.asyncio
async def test_anthropic_reports_input_and_output_tokens(monkeypatch) -> None:
    events = [
        {"type": "message_start", "message": {"usage": {"input_tokens": 25}}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Yes"}},
        {"type": "message_delta", "usage": {"output_tokens": 7}},
    ]
    client = Scripted([f"data: {json.dumps(e)}" for e in events])
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    model = Model(id="c", label="c", provider="anthropic", endpoint="https://api.anthropic.com/v1", api_key="k")
    out = pieces([c async for c in engine._stream_anthropic(model, [{"role": "user", "content": "hi"}])])
    assert out[-1] == {"modelId": "m", "usage": {"promptTokens": 25, "completionTokens": 7}}


@pytest.mark.asyncio
async def test_ollama_reports_eval_counts_on_the_last_frame(monkeypatch) -> None:
    lines = [
        json.dumps({"message": {"role": "assistant", "content": "Hi"}, "done": False}),
        json.dumps(
            {"message": {"role": "assistant", "content": ""}, "done": True, "prompt_eval_count": 9, "eval_count": 4}
        ),
    ]
    client = Scripted(lines)
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    model = Model(id="q", label="q", provider="ollama", endpoint="http://127.0.0.1:11434")
    out = pieces([c async for c in engine._stream_ollama(model, [{"role": "user", "content": "hi"}])])
    assert out[-1] == {"modelId": "m", "usage": {"promptTokens": 9, "completionTokens": 4}}
