"""chat.stream runs beside the receive loop: a closed socket or chat.cancel stops it and closes the upstream stream."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

_root = Path(tempfile.mkdtemp(prefix="friday-chatcancel-"))
os.environ["FRIDAY_DATA_DIR"] = str(_root / "data")
os.environ["FRIDAY_WORKSPACE_ROOT"] = str(_root)
os.environ.setdefault("FRIDAY_BRIDGE_TOKEN", "contract-token")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import main  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

WAIT = 5.0


class Upstream:
    """A stand-in for the model stream: it opens, may yield, then waits like a model still reading the prompt."""

    def __init__(self, first_delta: bool):
        self.first_delta = first_delta
        self.opened = threading.Event()
        self.closed = threading.Event()
        self.kwargs: dict = {}

    async def stream(self, **kwargs):
        self.kwargs = kwargs
        self.opened.set()
        try:
            if self.first_delta:
                yield {"modelId": "local-fake", "delta": "Hel"}
            await asyncio.sleep(3600)
            yield {"modelId": "local-fake", "done": True}
        finally:
            self.closed.set()


@pytest.fixture
def upstream(monkeypatch):
    def install(first_delta: bool) -> Upstream:
        fake = Upstream(first_delta)
        monkeypatch.setattr(main.router, "stream", fake.stream)
        monkeypatch.setattr(main.storage, "append_chat", lambda *a, **k: None)

        async def no_broadcast(*args, **kwargs):
            return None

        monkeypatch.setattr(main, "phone_broadcast", no_broadcast)

        async def no_recall(*args, **kwargs):
            return []

        monkeypatch.setattr(main.memory, "recall", no_recall)
        return fake

    return install


def _open(client: TestClient):
    ws = client.websocket_connect("/bridge")
    sock = ws.__enter__()
    sock.send_text(json.dumps({"token": main.TOKEN}))
    assert json.loads(sock.receive_text())["type"] == "ready"
    return ws, sock


def _chat(sock, req_id="c1", **params):
    sock.send_text(
        json.dumps({"id": req_id, "method": "chat.stream", "params": {"prompt": "hello", "sessionId": "s", **params}})
    )


def test_closing_the_socket_before_the_first_delta_closes_the_upstream(upstream):
    fake = upstream(first_delta=False)
    with TestClient(main.app) as client:
        ws, sock = _open(client)
        _chat(sock)
        assert fake.opened.wait(WAIT)
        assert not fake.closed.is_set()
        # The client hangs up; the app is not torn down by the test harness until the block exits.
        sock.close()
        try:
            assert fake.closed.wait(WAIT), "the upstream stream stayed open after the socket closed"
        finally:
            ws.__exit__(None, None, None)


def test_closing_the_socket_mid_stream_closes_the_upstream(upstream):
    fake = upstream(first_delta=True)
    with TestClient(main.app) as client:
        ws, sock = _open(client)
        _chat(sock)
        frame = json.loads(sock.receive_text())
        assert frame["type"] == "chat.delta"
        sock.close()
        try:
            assert fake.closed.wait(WAIT), "the upstream stream stayed open after the socket closed"
        finally:
            ws.__exit__(None, None, None)


def test_chat_cancel_stops_the_stream_and_answers_both_requests(upstream):
    fake = upstream(first_delta=False)
    with TestClient(main.app) as client:
        ws, sock = _open(client)
        try:
            _chat(sock, req_id="c1")
            assert fake.opened.wait(WAIT)
            sock.send_text(json.dumps({"id": "x9", "method": "chat.cancel", "params": {}}))
            assert fake.closed.wait(WAIT)
            frames = {}
            while len(frames) < 2:
                frame = json.loads(sock.receive_text())
                if frame.get("id") in ("c1", "x9"):
                    frames[frame["id"]] = frame
            assert frames["x9"]["data"] == {"cancelled": 1}
            assert frames["c1"]["data"]["done"] is False
            assert frames["c1"]["data"]["cancelled"] is True
        finally:
            ws.__exit__(None, None, None)


def test_chat_cancel_can_name_the_request(upstream):
    fake = upstream(first_delta=False)
    with TestClient(main.app) as client:
        ws, sock = _open(client)
        try:
            _chat(sock, req_id="c1")
            assert fake.opened.wait(WAIT)
            sock.send_text(json.dumps({"id": "x1", "method": "chat.cancel", "params": {"requestId": "nope"}}))
            reply = json.loads(sock.receive_text())
            assert reply["id"] == "x1" and reply["data"] == {"cancelled": 0}
            assert not fake.closed.is_set()
            sock.send_text(json.dumps({"id": "x2", "method": "chat.cancel", "params": {"requestId": "c1"}}))
            assert fake.closed.wait(WAIT)
        finally:
            ws.__exit__(None, None, None)


def test_the_receive_loop_stays_free_while_a_chat_runs(upstream):
    upstream(first_delta=False)
    with TestClient(main.app) as client:
        ws, sock = _open(client)
        try:
            _chat(sock)
            sock.send_text(json.dumps({"id": "k1", "method": "task.list", "params": {}}))
            frame = json.loads(sock.receive_text())
            assert frame["id"] == "k1" and frame["type"] == "result"
        finally:
            ws.__exit__(None, None, None)


def test_max_tokens_and_owner_text_reach_the_router_only_when_set(upstream, monkeypatch):
    seen: list[dict] = []

    async def stream(**kwargs):
        seen.append(kwargs)
        yield {"modelId": "m", "delta": "ok"}
        yield {"modelId": "m", "done": True}

    upstream(first_delta=True)
    monkeypatch.setattr(main.router, "stream", stream)

    async def go(**params):
        async def send(_payload):
            return None

        return await main.dispatch("chat.stream", {"prompt": "hi", "sessionId": "s", **params}, send)

    asyncio.run(go())
    assert "max_tokens" not in seen[-1] and "owner_text" not in seen[-1]
    asyncio.run(go(maxTokens=180, ownerText="attached file text"))
    assert seen[-1]["max_tokens"] == 180 and seen[-1]["owner_text"] == "attached file text"


def test_cancelling_a_turn_closes_the_httpx_response(monkeypatch):
    """The real Ollama wire: cancelling the task leaves `async with client.stream(...)`, which closes the response."""
    import router as router_mod
    from router import Model, ModelRouter

    class Hanging:
        status_code = 200
        headers: dict = {}
        exited = False

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            Hanging.exited = True
            return False

        async def aiter_lines(self):
            await asyncio.sleep(3600)
            yield ""

    class Client:
        def stream(self, method, url, json=None, headers=None):
            return Hanging()

    class Store:
        def models(self):
            return []

        def upsert_model(self, _row):
            return None

    monkeypatch.setattr(router_mod, "_client", lambda: Client())
    engine = ModelRouter(Store())
    model = Model(
        "ollama:q", "q", "ollama", "http://127.0.0.1:11434", options={"type": "local", "access": "free", "model": "q"}
    )

    async def go():
        async def consume():
            async for _ in engine._stream_ollama(model, [{"role": "user", "content": "hi"}]):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.05)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(go())
    assert Hanging.exited is True
