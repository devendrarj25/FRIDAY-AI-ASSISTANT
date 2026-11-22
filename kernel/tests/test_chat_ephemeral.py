"""An ephemeral chat.stream (the Brain's speculative draft) leaves no trace and can call no tool.

The desktop sends `ephemeral: true` for a draft started before the owner finished speaking. The turn is
text-only and disposable: no chat rows, no active session, no phone mirror, no memory write, no tool.
Only a strict boolean `true` counts, and a phone turn is never ephemeral.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

_root = Path(tempfile.mkdtemp(prefix="friday-ephemeral-"))
os.environ["FRIDAY_DATA_DIR"] = str(_root / "data")
os.environ["FRIDAY_WORKSPACE_ROOT"] = str(_root)
os.environ.setdefault("FRIDAY_BRIDGE_TOKEN", "contract-token")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import main  # noqa: E402
import router as router_mod  # noqa: E402
from router import Model, ModelRouter  # noqa: E402


class Spy:
    """Everything a normal turn writes, recorded instead of performed."""

    def __init__(self, monkeypatch, seen_no_tools: list[bool] | None = None, answer: str = "A guess."):
        self.chat_rows: list[tuple] = []
        self.broadcasts: list[dict] = []
        self.memory_writes: list[tuple] = []
        self.sent: list[dict] = []
        self.no_tools_during_stream = seen_no_tools if seen_no_tools is not None else []

        def append_chat(session_id, role, text, *args, **kwargs):
            self.chat_rows.append((session_id, role, text))

        async def phone_broadcast(payload, **kwargs):
            self.broadcasts.append(payload)

        async def memory_add(*args, **kwargs):
            self.memory_writes.append(args)

        async def stream(**kwargs):
            self.no_tools_during_stream.append(router_mod.NO_TOOLS.get())
            yield {"modelId": "local-fake", "delta": answer}
            yield {"modelId": "local-fake", "done": True}

        monkeypatch.setattr(main.storage, "append_chat", append_chat)
        monkeypatch.setattr(main, "phone_broadcast", phone_broadcast)
        monkeypatch.setattr(main.memory, "add", memory_add)
        monkeypatch.setattr(main.router, "stream", stream)
        monkeypatch.setattr(main, "ACTIVE_SESSION", "before")

    async def send(self, payload: dict) -> None:
        self.sent.append(payload)


async def _chat(spy: Spy, **extra):
    params = {"prompt": "what is on my calendar", "sessionId": "draft-1", **extra}
    return await main.dispatch("chat.stream", params, spy.send)


@pytest.mark.asyncio
async def test_ephemeral_turn_writes_nothing(monkeypatch):
    spy = Spy(monkeypatch)
    result = await _chat(spy, ephemeral=True)
    assert result == {"done": True, "answers": 1}
    assert spy.chat_rows == []
    assert spy.broadcasts == []
    assert spy.memory_writes == []
    assert main.ACTIVE_SESSION == "before"
    # The caller still receives the streamed text: the draft is only useless if nobody sees it.
    assert [m["data"].get("delta") for m in spy.sent if m["type"] == "chat.delta"][0] == "A guess."


@pytest.mark.asyncio
async def test_normal_turn_still_writes_everything(monkeypatch):
    spy = Spy(monkeypatch)
    result = await _chat(spy)
    assert result == {"done": True, "answers": 1}
    assert spy.chat_rows == [
        ("draft-1", "user", "what is on my calendar"),
        ("draft-1", "assistant", "A guess."),
    ]
    assert [b["role"] for b in spy.broadcasts] == ["user", "assistant"]
    assert main.ACTIVE_SESSION == "draft-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["true", 1, "yes", None, [], {}, 0, False])
async def test_only_a_strict_true_is_ephemeral(monkeypatch, value):
    spy = Spy(monkeypatch)
    await _chat(spy, ephemeral=value)
    assert len(spy.chat_rows) == 2
    assert main.ACTIVE_SESSION == "draft-1"


@pytest.mark.asyncio
async def test_a_phone_session_is_never_ephemeral(monkeypatch):
    spy = Spy(monkeypatch)
    monkeypatch.setitem(main._PHONE_COGNIZE, "draft-1", asyncio.Queue())
    await _chat(spy, ephemeral=True)
    # The phone turn keeps its normal path: the assistant row is written and mirrored.
    assert ("draft-1", "assistant", "A guess.") in spy.chat_rows
    assert any(b.get("role") == "assistant" for b in spy.broadcasts)


@pytest.mark.asyncio
async def test_tools_are_off_only_while_an_ephemeral_turn_streams(monkeypatch):
    seen: list[bool] = []
    spy = Spy(monkeypatch, seen)
    await _chat(spy, ephemeral=True)
    await _chat(spy)
    assert seen == [True, False]
    assert router_mod.NO_TOOLS.get() is False


@pytest.mark.asyncio
async def test_a_failing_ephemeral_turn_still_resets_tools(monkeypatch):
    spy = Spy(monkeypatch)

    async def broken(**kwargs):
        assert router_mod.NO_TOOLS.get() is True
        raise RuntimeError("model fell over")
        yield  # pragma: no cover

    monkeypatch.setattr(main.router, "stream", broken)
    with pytest.raises(RuntimeError):
        await main.dispatch("chat.stream", {"prompt": "hi", "sessionId": "draft-2", "ephemeral": True}, spy.send)
    assert router_mod.NO_TOOLS.get() is False


class _Lines:
    def __init__(self, lines):
        self.status_code = 200
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _Scripted:
    def __init__(self, rounds):
        self.rounds = rounds
        self.bodies: list[dict] = []
        self.n = 0

    def stream(self, method, url, json=None):
        self.bodies.append(json)
        lines = self.rounds[min(self.n, len(self.rounds) - 1)]
        self.n += 1
        return _Lines(lines)


class _Tools:
    def __init__(self):
        self.calls: list[tuple] = []

    def model_schemas(self):
        return [{"type": "function", "function": {"name": "fs_read", "parameters": {"type": "object"}}}]

    async def execute_for_model(self, name, args):
        self.calls.append((name, args))
        return {"ok": True, "text": "secret file"}


class _NoStore:
    def models(self):
        return []


def _tool_call_round():
    call = {"type": "function", "function": {"index": 0, "name": "fs_read", "arguments": {"path": "a.txt"}}}
    return [json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": [call]}, "done": True})]


@pytest.mark.asyncio
async def test_a_tool_calling_model_runs_no_tool_in_an_ephemeral_turn(monkeypatch):
    tools = _Tools()
    answer = [json.dumps({"message": {"role": "assistant", "content": "No lookup needed."}, "done": True})]
    client = _Scripted([_tool_call_round(), answer])
    monkeypatch.setattr(router_mod, "_client", lambda: client)
    engine = ModelRouter(_NoStore())
    engine.tools = tools
    model = Model(id="llama", label="llama", provider="ollama", endpoint="http://127.0.0.1:11434")

    token = router_mod.NO_TOOLS.set(True)
    try:
        chunks = [p async for p in engine._stream_ollama(model, [{"role": "user", "content": "read a.txt"}])]
    finally:
        router_mod.NO_TOOLS.reset(token)

    assert tools.calls == []
    assert "tools" not in client.bodies[0]
    assert "secret file" not in "".join(chunks)
    # The model asked anyway; the refusal went back to it as the tool result, not as a run.
    refusal = next(row for row in client.bodies[1]["messages"] if row.get("role") == "tool")
    assert "text-only" in refusal["content"]


@pytest.mark.asyncio
async def test_the_same_model_still_runs_its_tool_in_a_normal_turn(monkeypatch):
    tools = _Tools()
    answer = [json.dumps({"message": {"role": "assistant", "content": "It says secret."}, "done": True})]
    client = _Scripted([_tool_call_round(), answer])
    monkeypatch.setattr(router_mod, "_client", lambda: client)
    engine = ModelRouter(_NoStore())
    engine.tools = tools
    model = Model(id="llama", label="llama", provider="ollama", endpoint="http://127.0.0.1:11434")
    [p async for p in engine._stream_ollama(model, [{"role": "user", "content": "read a.txt"}])]
    assert tools.calls == [("fs_read", {"path": "a.txt"})]
    assert "tools" in client.bodies[0]
