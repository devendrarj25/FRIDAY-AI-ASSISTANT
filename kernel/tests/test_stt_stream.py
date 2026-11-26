"""The STT worker's streaming-ear ops (stream-open, stream-feed, stream-close): off by default, nothing changes
for the existing ops, unload and idle behave, and the serve loop answers them. Fake model, injected clock."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

import pytest

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import stt  # noqa: E402
from fake_transducer import install_fake_engine, pcm_bytes  # noqa: E402
from stream_ear import ENGINE_NAME, STREAM_OPS, StreamHost  # noqa: E402

SPEECH = pcm_bytes(0.9, 0.3)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


@pytest.fixture
def worker(monkeypatch, tmp_path):
    """A clean worker with the fake streaming engine installed and a fake clock."""
    now = [1_000.0]
    monkeypatch.setattr(stt, "_now", lambda: now[0])
    monkeypatch.setattr(stt, "_model", None)
    monkeypatch.setattr(stt, "_model_name", None)
    monkeypatch.setattr(stt, "_last_used", None)
    monkeypatch.setattr(stt, "_idle_limit_s", stt.IDLE_UNLOAD_S)
    monkeypatch.setattr(stt, "_unloads", 0)
    monkeypatch.setattr(stt.hindi_ear, "_model", None)
    monkeypatch.setattr(stt.hindi_ear, "_timed", None)
    monkeypatch.setattr(stt.stream_ear, "HOST", StreamHost())
    model = install_fake_engine(monkeypatch, tmp_path)
    return now, model


def test_the_three_ops_are_known_and_the_open_and_feed_count_as_use():
    assert STREAM_OPS == {"stream-open", "stream-feed", "stream-close"}
    assert {"stream-open", "stream-feed"} <= stt.USE_OPS and "stream-close" not in stt.USE_OPS
    assert {"load", "transcribe", "flush", "self-test", "hearing-self-test"} <= stt.USE_OPS  # nothing was dropped


def test_the_streaming_ear_is_off_unless_the_setting_asks_for_it(worker):
    _, model = worker
    for req in ({}, {"streamEngine": "off"}, {"streamEngine": None}):
        reply = stt.handle_request({"op": "stream-open", "locale": "en-US", **req})
        assert reply["ok"] is False and reply["reason"] == "stream-engine-off" and reply["fallback"] is True
    assert stt.loaded_names() == [] and model.opened == [] and stt._last_used is None


def test_with_the_setting_on_and_the_pin_there_a_stream_runs_and_is_a_resident_model(worker):
    now, model = worker
    opened = stt.handle_request({"op": "stream-open", "streamEngine": "auto", "locale": "en-US", "streamId": "u"})
    assert opened["ok"] and opened["engine"] == ENGINE_NAME
    assert stt.loaded_names() == [ENGINE_NAME] and stt._last_used == now[0]
    now[0] += 5
    fed = stt.handle_request({"op": "stream-feed", "streamId": "u", "pcm": b64(SPEECH)})
    assert fed["ok"] and stt._last_used == now[0]  # a feed restarts the idle clock
    closed = stt.handle_request({"op": "stream-close", "streamId": "u"})
    assert closed["final"] is True and closed["text"] == "Open Chrome, please"
    assert stt.loaded_names() == [ENGINE_NAME] and len(model.opened) == 3


def test_unload_models_drops_the_streaming_model_and_reports_it(worker):
    stt.handle_request({"op": "stream-open", "streamEngine": "auto"})
    assert stt.unload_models() == [ENGINE_NAME]
    assert stt.loaded_names() == [] and stt.stream_ear.HOST.active is None
    assert stt.handle_request({"op": "stream-feed", "pcm": b64(SPEECH)})["reason"] == "no-stream"


def test_the_idle_unload_takes_the_streaming_model_too(worker):
    now, _ = worker
    stt.handle_request({"op": "stream-open", "streamEngine": "auto"})
    stt.handle_request({"op": "stream-close", "finalize": False})
    now[0] += stt.IDLE_UNLOAD_S + 1
    assert stt.idle_seconds() is not None and stt.unload_idle() == [ENGINE_NAME]
    assert stt.loaded_names() == []


def test_a_live_stream_is_not_idle_unloaded_while_audio_keeps_coming(worker):
    now, _ = worker
    stt.handle_request({"op": "stream-open", "streamEngine": "auto"})
    for _ in range(3):
        now[0] += stt.IDLE_UNLOAD_S - 1
        assert stt.handle_request({"op": "stream-feed", "pcm": b64(SPEECH)})["ok"] is True
    assert stt.loaded_names() == [ENGINE_NAME]


def test_the_status_says_whether_the_streaming_ear_is_ready_and_loaded(worker):
    status = stt.handle_request({"op": "status"})
    assert status["streamEar"] == {"engines": [ENGINE_NAME], "pinReady": True, "loaded": False, "active": None}
    stt.handle_request({"op": "stream-open", "streamEngine": "auto", "streamId": "z"})
    assert stt.handle_request({"op": "status"})["streamEar"]["active"] == "z"
    assert stt.handle_request({"op": "status"})["modelLoaded"] is False  # the whisper cache is untouched


def test_an_existing_op_and_an_unknown_op_behave_as_before(worker):
    assert stt.handle_request({"op": "wat"})["reason"] == "unknown-op"
    assert stt.handle_request({"op": "transcribe", "audio": "/no/such.wav"})["reason"] == "no-audio"
    assert stt.handle_request({"op": "partial-plan", "duration": 3})["ok"] is True
    assert stt.handle_request({"op": "shutdown"})["op"] == "shutdown"


def test_the_serve_loop_answers_the_stream_ops_with_the_request_id(tmp_path):
    proc = subprocess.Popen(
        [sys.executable, str(KERNEL / "stt.py"), "--serve"],
        cwd=str(KERNEL),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={"PATH": "/usr/bin:/bin", "FRIDAY_ROOT": str(tmp_path)},
    )
    try:
        assert proc.stdin and proc.stdout
        for rid, req in enumerate(
            [{"op": "stream-open", "locale": "en-US"}, {"op": "stream-feed", "pcm": ""}, {"op": "stream-close"}], 1
        ):
            proc.stdin.write(json.dumps({"id": rid, **req}) + "\n")
            proc.stdin.flush()
            reply = json.loads(proc.stdout.readline())
            assert reply["id"] == rid and reply["ok"] is False
            assert reply["reason"] == ("stream-engine-off" if rid == 1 else "no-stream")
        proc.stdin.write(json.dumps({"id": 9, "op": "shutdown"}) + "\n")
        proc.stdin.flush()
        assert json.loads(proc.stdout.readline())["op"] == "shutdown"
    finally:
        proc.kill()
        proc.wait(timeout=10)
