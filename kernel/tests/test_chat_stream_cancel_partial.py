"""A cancelled chat keeps the partial reply the owner had read, and a chat that will not unwind cannot hold the
read loop: chat.cancel answers after a bounded wait."""

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

_root = Path(tempfile.mkdtemp(prefix="friday-chatpartial-"))
os.environ["FRIDAY_DATA_DIR"] = str(_root / "data")
os.environ["FRIDAY_WORKSPACE_ROOT"] = str(_root)
os.environ.setdefault("FRIDAY_BRIDGE_TOKEN", "contract-token")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import main  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

WAIT = 5.0


class Upstream:
    """Yields one delta, then waits like a model still generating. `stubborn` swallows the first cancellation."""

    def __init__(self, stubborn: bool = False):
        self.stubborn = stubborn
        self.opened = threading.Event()
        self.release = threading.Event()

    async def stream(self, **kwargs):
        self.opened.set()
        yield {"modelId": "local-fake", "delta": "Hel"}
        yield {"modelId": "local-fake", "delta": "lo"}
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            if not self.stubborn:
                raise
            while not self.release.is_set():
                await asyncio.sleep(0.01)
            raise
        yield {"modelId": "local-fake", "done": True}


@pytest.fixture
def install(monkeypatch):
    rows: list[tuple] = []
    mirrored: list[dict] = []

    def setup(fake: Upstream):
        monkeypatch.setattr(main.router, "stream", fake.stream)
        monkeypatch.setattr(main.storage, "append_chat", lambda *a, **k: rows.append((a, k)))

        async def capture(payload, **kwargs):
            mirrored.append(payload)

        monkeypatch.setattr(main, "phone_broadcast", capture)

        async def no_recall(*args, **kwargs):
            return []

        monkeypatch.setattr(main.memory, "recall", no_recall)
        return rows, mirrored

    return setup


def _open(client: TestClient):
    ws = client.websocket_connect("/bridge")
    sock = ws.__enter__()
    sock.send_text(json.dumps({"token": main.TOKEN}))
    assert json.loads(sock.receive_text())["type"] == "ready"
    return ws, sock


def _await_deltas(sock, count: int) -> None:
    seen = 0
    while seen < count:
        if json.loads(sock.receive_text()).get("type") == "chat.delta":
            seen += 1


def _frames(sock, wanted: set[str]) -> dict:
    found: dict = {}
    while set(found) != wanted:
        frame = json.loads(sock.receive_text())
        if frame.get("id") in wanted:
            found[frame["id"]] = frame
    return found


def test_chat_cancel_keeps_the_partial_reply_in_the_store_and_the_mirror(install):
    rows, mirrored = install(Upstream())
    with TestClient(main.app) as client:
        ws, sock = _open(client)
        try:
            sock.send_text(
                json.dumps({"id": "c1", "method": "chat.stream", "params": {"prompt": "hi", "sessionId": "s"}})
            )
            _await_deltas(sock, 2)
            sock.send_text(json.dumps({"id": "x9", "method": "chat.cancel", "params": {}}))
            frames = _frames(sock, {"c1", "x9"})
        finally:
            ws.__exit__(None, None, None)
    assert frames["c1"]["data"]["cancelled"] is True
    assistant = [a for a, _k in rows if a[1] == "assistant"]
    assert assistant == [("s", "assistant", "Hello", "local-fake")]  # was: only the user row was kept
    assert any(p.get("role") == "assistant" and p.get("text") == "Hello" for p in mirrored)


def test_a_cancelled_draft_leaves_no_row(install):
    rows, _mirrored = install(Upstream())
    with TestClient(main.app) as client:
        ws, sock = _open(client)
        try:
            params = {"prompt": "hi", "sessionId": "s", "ephemeral": True}
            sock.send_text(json.dumps({"id": "c1", "method": "chat.stream", "params": params}))
            _await_deltas(sock, 2)
            sock.send_text(json.dumps({"id": "x9", "method": "chat.cancel", "params": {}}))
            _frames(sock, {"c1", "x9"})
        finally:
            ws.__exit__(None, None, None)
    assert rows == []


def test_a_chat_that_will_not_unwind_does_not_hold_the_cancel_answer(monkeypatch, install):
    fake = Upstream(stubborn=True)
    install(fake)
    monkeypatch.setattr(main, "CANCEL_UNWIND_SECONDS", 0.2)
    with TestClient(main.app) as client:
        ws, sock = _open(client)
        try:
            sock.send_text(
                json.dumps({"id": "c1", "method": "chat.stream", "params": {"prompt": "hi", "sessionId": "s"}})
            )
            _await_deltas(sock, 2)
            sock.send_text(json.dumps({"id": "x9", "method": "chat.cancel", "params": {}}))
            frames = _frames(sock, {"c1", "x9"})  # blocked for ever before the bounded wait
        finally:
            fake.release.set()
            ws.__exit__(None, None, None)
    assert frames["x9"]["data"] == {"cancelled": 1}
    assert frames["c1"]["data"] == {"done": False, "cancelled": True}
