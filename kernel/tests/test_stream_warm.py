"""The stream-warm op: it loads the streaming ear without opening a stream, is idempotent, and in the serve loop runs
on its own thread outside the cache lock, so a transcribe or a status sent during a long warm is still answered at
once. Fake model, no network, no real weights."""

from __future__ import annotations

import io
import json
import os
import queue
import sys
import threading
from pathlib import Path

import pytest

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import stt  # noqa: E402
from fake_transducer import install_fake_engine  # noqa: E402
from stream_ear import ENGINE_NAME, STREAM_OPS, StreamHost  # noqa: E402


@pytest.fixture
def worker(monkeypatch, tmp_path):
    now = [1_000.0]
    monkeypatch.setattr(stt, "_now", lambda: now[0])
    monkeypatch.setattr(stt, "_model", None)
    monkeypatch.setattr(stt, "_model_name", None)
    monkeypatch.setattr(stt, "_last_used", None)
    monkeypatch.setattr(stt.hindi_ear, "_model", None)
    monkeypatch.setattr(stt.hindi_ear, "_timed", None)
    monkeypatch.setattr(stt.stream_ear, "HOST", StreamHost())
    model = install_fake_engine(monkeypatch, tmp_path)
    return now, model


def test_the_warm_op_is_not_a_stream_op():
    assert "stream-warm" not in STREAM_OPS and stt.stream_ear.WARM_OP == "stream-warm"


def test_a_warm_loads_the_ear_without_opening_a_stream(worker):
    now, model = worker
    reply = stt.handle_request({"op": "stream-warm", "streamEngine": "auto", "locale": "en-US"})
    assert reply["ok"] is True and reply["op"] == "stream-warm" and reply["engine"] == ENGINE_NAME
    assert isinstance(reply["loadedMs"], int) and reply["loadedMs"] >= 0 and reply["already"] is False
    assert stt.stream_ear.HOST.active is None  # no stream is open
    assert stt.loaded_names() == [ENGINE_NAME] and stt._last_used == now[0]
    assert stt.handle_request({"op": "stream-feed", "pcm": ""})["reason"] == "no-stream"
    loads = len(model.opened)
    assert loads >= 1


def test_a_second_warm_is_a_no_op_and_the_next_open_reuses_the_model(worker):
    _, model = worker
    stt.handle_request({"op": "stream-warm", "streamEngine": "auto", "locale": "en-US"})
    loads = len(model.opened)
    again = stt.handle_request({"op": "stream-warm", "streamEngine": "auto", "locale": "en-US"})
    assert again["ok"] is True and again["already"] is True and again["loadedMs"] == 0
    assert len(model.opened) == loads
    opened = stt.handle_request({"op": "stream-open", "streamEngine": "auto", "locale": "en-US", "streamId": "u"})
    assert opened["ok"] is True and opened["loadMs"] == 0 and len(model.opened) == loads


def test_a_warm_with_the_ear_off_refuses_and_loads_nothing(worker):
    _, model = worker
    reply = stt.handle_request({"op": "stream-warm", "streamEngine": "off"})
    assert reply["ok"] is False and reply["reason"] == "stream-engine-off" and reply["fallback"] is True
    assert model.opened == [] and stt.loaded_names() == []


def test_a_warm_during_a_live_stream_leaves_the_stream_alone(worker):
    stt.handle_request({"op": "stream-open", "streamEngine": "auto", "locale": "en-US", "streamId": "u"})
    reply = stt.handle_request({"op": "stream-warm", "streamEngine": "auto", "locale": "en-US"})
    assert reply["ok"] is True and reply["already"] is True
    assert stt.stream_ear.HOST.active == "u"


class _Out:
    """A stdout stand-in: every written line goes on a queue the test reads with a deadline."""

    def __init__(self) -> None:
        self.lines: queue.Queue[dict] = queue.Queue()
        self._buf = ""

    def write(self, text: str) -> int:
        self._buf += text
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.startswith("{"):
                self.lines.put(json.loads(line))
        return len(text)

    def flush(self) -> None:
        return None


def test_a_transcribe_sent_during_a_slow_warm_answers_at_once(monkeypatch):
    release = threading.Event()
    entered = threading.Event()
    lock_free: list[bool] = []

    def slow_warm(req):
        entered.set()
        release.wait(30)
        return {"ok": True, "op": "stream-warm", "engine": "fake", "loadedMs": 120000, "already": False}

    real = stt._handle_op

    def quick(req):
        if req.get("op") == "transcribe":
            return {"ok": True, "text": "hello"}
        return real(req)

    monkeypatch.setattr(stt.stream_ear, "HOST", StreamHost())
    monkeypatch.setattr(stt.stream_ear.HOST, "warm", slow_warm)
    monkeypatch.setattr(stt, "_handle_op", quick)
    monkeypatch.setattr(stt, "start_idle_watch", lambda *a, **k: None)
    read_fd, write_fd = os.pipe()
    reader = io.TextIOWrapper(io.FileIO(read_fd, "r"), encoding="utf-8")
    writer = io.TextIOWrapper(io.FileIO(write_fd, "w"), encoding="utf-8", write_through=True)
    out = _Out()
    monkeypatch.setattr(sys, "stdin", reader)
    monkeypatch.setattr(sys, "stdout", out)
    done: list[int] = []
    loop = threading.Thread(target=lambda: done.append(stt.serve()), daemon=True)
    loop.start()

    def send(obj: dict) -> None:
        writer.write(json.dumps(obj) + "\n")

    try:
        send({"id": 1, "op": "stream-warm", "streamEngine": "auto"})
        assert entered.wait(5)
        send({"id": 2, "op": "transcribe", "audio": "x.wav"})
        first = out.lines.get(timeout=1.0)
        assert first["id"] == 2 and first["text"] == "hello"
        send({"id": 3, "op": "status"})
        second = out.lines.get(timeout=1.0)
        assert second["id"] == 3 and second["ok"] is True
        lock_free.append(stt._cache_lock.acquire(timeout=0.5))
        if lock_free[-1]:
            stt._cache_lock.release()
        assert lock_free == [True]  # the warm does not hold the cache lock
        send({"id": 4, "op": "stream-warm", "streamEngine": "auto"})  # a second warm joins the first
        release.set()
        warmed = sorted((out.lines.get(timeout=5.0) for _ in range(2)), key=lambda r: r["id"])
        assert [r["id"] for r in warmed] == [1, 4]
        assert all(r["ok"] is True and r["loadedMs"] == 120000 for r in warmed)
        send({"id": 5, "op": "shutdown"})
        assert out.lines.get(timeout=5.0)["id"] == 5
        loop.join(5)
        assert done == [0]
    finally:
        release.set()
        writer.close()
