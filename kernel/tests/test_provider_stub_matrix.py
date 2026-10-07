"""Every provider wire answers a local stub: list, SSE chat, and a tool call.

The desktop router decides who is eligible. This test is the next hop: the
kernel streams that choice through PROVIDER_SURFACES to a stub, with a key
present and paid access left off. The model is marked free so the billing
firewall allows the call. The stub never sees a real provider.
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router  # noqa: E402
from router import ModelRouter  # noqa: E402


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


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


SEEN: list[dict] = []
TOOL_ROUND: dict[str, int] = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def _json(self, payload: dict, status: int = 200):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        SEEN.append({"method": "GET", "path": self.path.split("?")[0]})
        if self.path.split("?")[0].endswith("/models") or self.path.endswith("/api/tags"):
            self._json({"data": [{"id": "stub-model"}], "models": [{"name": "stub-model"}]})
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode() or "{}")
        except ValueError:
            payload = {}
        path = self.path.split("?")[0]
        auth = self.headers.get("Authorization") or ""
        xkey = self.headers.get("x-api-key") or ""
        SEEN.append(
            {
                "method": "POST",
                "path": path,
                "model": payload.get("model"),
                "tools": bool(payload.get("tools")),
                "auth": "present" if auth.startswith("Bearer ") and len(auth) > 12 else "absent",
                "x-api-key": "present" if xkey else "absent",
                "secret": auth.replace("Bearer ", "") if auth.startswith("Bearer ") else xkey,
            }
        )
        round_key = path
        round_n = TOOL_ROUND.get(round_key, 0)
        wants_tool = bool(payload.get("tools")) and round_n == 0
        if wants_tool:
            TOOL_ROUND[round_key] = 1
        if path.endswith("/api/chat"):
            if wants_tool:
                body = json.dumps(
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "function": {
                                        "name": "fs_read",
                                        "arguments": {"path": "a.txt"},
                                    }
                                }
                            ],
                        },
                        "done": True,
                    }
                )
            else:
                body = json.dumps({"message": {"role": "assistant", "content": "ok"}, "done": True})
            raw_body = (body + "\n").encode()
        elif path.endswith("/messages"):
            if wants_tool:
                frames = [
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"fs_read"}}',
                    'data: {"type":"content_block_delta","index":0,"delta":{"partial_json":"{\\"path\\":\\"a.txt\\"}"}}',
                ]
            else:
                frames = [
                    'data: {"type":"content_block_delta","index":0,"delta":{"text":"ok"}}',
                ]
            raw_body = ("\n".join(frames) + "\n").encode()
        else:
            if wants_tool:
                frames = [
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
                    "data: [DONE]",
                ]
            else:
                frames = [
                    'data: {"choices":[{"delta":{"content":"ok"}}]}',
                    "data: [DONE]",
                ]
            raw_body = ("\n".join(frames) + "\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(raw_body)))
        self.end_headers()
        self.wfile.write(raw_body)


@pytest.fixture(scope="module")
def stub():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


def _endpoint(provider: str, base: str) -> str:
    spec = router.PROVIDER_SURFACES[provider]
    official = spec.get("base") or ""
    if provider == "ollama":
        return base
    if not official:
        return f"{base}/v1"
    path = official.split("://", 1)[-1]
    slash = path.find("/")
    suffix = path[slash:] if slash >= 0 else ""
    return f"{base}{suffix}"


def _drain(engine: ModelRouter, model_ids: list[str]) -> dict[str, str]:
    """One event loop for every call. The kernel keeps a process-wide HTTP
    client, and a fresh asyncio.run() per provider closes that loop underneath it.
    """
    import asyncio

    async def run() -> dict[str, str]:
        texts: dict[str, str] = {}
        try:
            for model_id in model_ids:
                parts: list[str] = []
                async for piece in engine.stream(
                    "Hi", [model_id], allow_fallback=False, privacy_confirmed=True
                ):
                    if isinstance(piece, dict) and piece.get("delta"):
                        parts.append(str(piece["delta"]))
                    elif isinstance(piece, dict) and piece.get("error"):
                        parts.append(f"ERROR {piece['error']}")
                texts[model_id] = "".join(parts)
        finally:
            await router.close_client()
        return texts

    return asyncio.run(run())


def test_every_provider_lists_and_streams(stub):
    with urlopen(f"{stub}/v1/models", timeout=5) as res:
        listed = json.loads(res.read().decode())
    assert listed["data"][0]["id"] == "stub-model"

    engine = ModelRouter(Store())
    order: list[str] = []
    for provider in router.PROVIDER_SURFACES:
        endpoint = _endpoint(provider, stub)
        model_id = f"{provider}:stub-model"
        surface = router.PROVIDER_SURFACES[provider]
        options = {"model": "stub-model"}
        if surface.get("chat_path") and surface.get("wire") != "ollama":
            options["chat_path"] = surface["chat_path"]
        engine.register(
            {
                "id": model_id,
                "label": f"{provider} stub",
                "provider": provider,
                "endpoint": endpoint,
                "role": "brain",
                "api_key": "test-key-not-a-secret",
                "contextK": 8,
                "status": "ready",
                "type": "local" if provider in {"ollama", "lmstudio", "llamacpp", "vllm", "localai", "jan", "mlx", "local"} else "cloud",
                "access": "free",
                "options": options,
            }
        )
        order.append(model_id)
    texts = _drain(engine, order)
    for model_id in order:
        engine.unregister(model_id)

    for model_id, text in texts.items():
        assert "ok" in text, f"{model_id} answered {text!r}"
        assert "test-key-not-a-secret" not in text

    posts = [row for row in SEEN if row["method"] == "POST"]
    assert any(row["path"].endswith("/api/chat") for row in posts)
    assert any(row["path"].endswith("/messages") for row in posts)
    assert any(row["path"].endswith("/chat/completions") for row in posts)
    # Perplexity's documented path is the host root, not /v1/chat/completions.
    assert any(row["path"] == "/chat/completions" for row in posts)
    for row in posts:
        secret = row.get("secret") or ""
        assert secret in {"", "test-key-not-a-secret"}
        if row["path"].endswith("/api/chat"):
            assert secret == ""
        else:
            assert secret == "test-key-not-a-secret"


def test_openai_anthropic_and_ollama_accept_a_tool_call(stub):
    SEEN.clear()
    TOOL_ROUND.clear()
    engine = ModelRouter(Store())
    tools = ReadTools()
    engine.tools = tools
    order = []
    for provider, endpoint in (
        ("openai", f"{stub}/v1"),
        ("anthropic", f"{stub}/v1"),
        ("ollama", stub),
    ):
        model_id = f"{provider}:stub-model"
        engine.register(
            {
                "id": model_id,
                "label": provider,
                "provider": provider,
                "endpoint": endpoint,
                "api_key": "test-key-not-a-secret",
                "status": "ready",
                "type": "local" if provider == "ollama" else "cloud",
                "access": "free",
                "options": {"model": "stub-model"},
            }
        )
        order.append(model_id)
    texts = _drain(engine, order)
    for model_id in order:
        assert "ok" in texts[model_id], f"{model_id} answered {texts[model_id]!r}"
        engine.unregister(model_id)
    assert tools.calls
    assert tools.calls[0][0] == "fs_read"
