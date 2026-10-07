"""Ollama chat uses the same read-only tools as the other wires.

Thinking is not the answer. A repeated tool frame is one lookup. The notice
prefix is not answer text.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router
from router import (
    TOOL_NOTICE,
    Model,
    ModelRouter,
    fold_stream_piece,
    ollama_calls_from_message,
)


class Store:
    def models(self):
        return []


class ReadTools:
    def __init__(self):
        self.calls = []

    def model_schemas(self):
        return [
            {
                "type": "function",
                "function": {
                    "name": "fs_read",
                    "description": "Read a workspace file.",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
                },
            }
        ]

    async def execute_for_model(self, name, args):
        self.calls.append((name, args))
        return {"ok": True, "text": "hello file"}


class Scripted:
    def __init__(self, rounds):
        self.rounds = rounds
        self.bodies = []
        self.n = 0

    def stream(self, method, url, json=None):
        self.bodies.append({"method": method, "url": url, "json": json})
        lines = self.rounds[min(self.n, len(self.rounds) - 1)]
        self.n += 1
        return _Lines(lines)


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


def test_fold_stream_piece_keeps_a_tool_notice_out_of_the_answer():
    assert fold_stream_piece("llama", f"{TOOL_NOTICE}fs_read") == {
        "modelId": "llama",
        "tool": "fs_read",
    }
    assert fold_stream_piece("llama", "Hello") == {"modelId": "llama", "delta": "Hello"}
    assert fold_stream_piece("llama", "") is None
    assert fold_stream_piece("llama", f"{TOOL_NOTICE}   ") is None


def test_ollama_calls_collapse_a_repeated_frame_and_keep_objects():
    message = {
        "tool_calls": [
            {
                "type": "function",
                "function": {"index": 0, "name": "fs_read", "arguments": {"path": "notes.txt"}},
            },
            {
                "type": "function",
                "function": {"index": 0, "name": "fs_read", "arguments": {"path": "notes.txt"}},
            },
            {
                "function": {"name": "bluetooth_list", "arguments": "{}"},
            },
        ]
    }
    calls = ollama_calls_from_message(message)
    assert calls == [
        {"name": "fs_read", "arguments": {"path": "notes.txt"}},
        {"name": "bluetooth_list", "arguments": {}},
    ]


@pytest.mark.asyncio
async def test_stream_ollama_runs_one_read_only_tool_and_skips_thinking(monkeypatch):
    tools = ReadTools()
    first = [
        json.dumps(
            {
                "message": {"role": "assistant", "content": "", "thinking": "secret plan"},
                "done": False,
            }
        ),
        json.dumps(
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "index": 0,
                                "name": "fs_read",
                                "arguments": {"path": "notes.txt"},
                            },
                        }
                    ],
                },
                "done": False,
            }
        ),
        json.dumps(
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "index": 0,
                                "name": "fs_read",
                                "arguments": {"path": "notes.txt"},
                            },
                        }
                    ],
                },
                "done": True,
            }
        ),
    ]
    second = [
        json.dumps(
            {"message": {"role": "assistant", "content": "The file says hello."}, "done": True}
        )
    ]
    client = Scripted([first, second])
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    engine.tools = tools
    model = Model(
        id="llama",
        label="llama",
        provider="ollama",
        endpoint="http://127.0.0.1:11434",
    )
    chunks = [
        piece
        async for piece in engine._stream_ollama(
            model, [{"role": "user", "content": "read notes"}]
        )
    ]
    text = "".join(chunks)
    assert "secret plan" not in text
    assert f"{TOOL_NOTICE}fs_read" in chunks
    assert "The file says hello." in text
    assert tools.calls == [("fs_read", {"path": "notes.txt"})]
    assert "tools" in client.bodies[0]["json"]
    follow = client.bodies[1]["json"]["messages"]
    assistant = next(row for row in follow if row.get("tool_calls"))
    assert assistant["tool_calls"][0]["function"]["arguments"] == {"path": "notes.txt"}
    tool_row = next(row for row in follow if row.get("role") == "tool")
    assert tool_row["tool_name"] == "fs_read"
    assert "hello file" in tool_row["content"]


@pytest.mark.asyncio
async def test_stream_ollama_without_tools_still_yields_content(monkeypatch):
    client = Scripted(
        [
            [
                json.dumps(
                    {"message": {"role": "assistant", "content": "Hi.", "thinking": "nope"}, "done": True}
                )
            ]
        ]
    )
    monkeypatch.setattr(router, "_client", lambda: client)
    engine = ModelRouter(Store())
    model = Model(id="llama", label="llama", provider="ollama", endpoint="http://127.0.0.1:11434")
    chunks = [
        piece
        async for piece in engine._stream_ollama(model, [{"role": "user", "content": "hi"}])
    ]
    assert chunks == ["Hi."]
    assert "tools" not in client.bodies[0]["json"]
