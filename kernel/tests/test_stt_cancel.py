"""A provisional decode can be cancelled between segments and passes; a cancelled decode is never "heard"."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

KERNEL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KERNEL))

import stt  # noqa: E402


def _wav(path: Path, seconds: float = 1.0) -> str:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(b"\x10\x00" * int(16000 * seconds))
    return str(path)


def _segment(text: str):
    return SimpleNamespace(text=text, no_speech_prob=0.01, avg_logprob=-0.2)


class FakeModel:
    """A model whose segments arrive one by one, so a cancel can land between them."""

    def __init__(self, on_segment=None, pieces=("open chrome", "and the mail", "please")):
        self.on_segment = on_segment
        self.pieces = pieces
        self.yielded = 0

    def transcribe(self, payload, **kwargs):
        def gen():
            for index, piece in enumerate(self.pieces):
                if self.on_segment:
                    self.on_segment(index)  # a cancel lands while this segment is being computed
                self.yielded += 1
                yield _segment(piece)

        info = SimpleNamespace(language="en", language_probability=0.99, duration=3.0, duration_after_vad=2.5)
        return gen(), info


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setattr(stt, "_cancelled_keys", type(stt._cancelled_keys)(maxlen=32), raising=False)
    before = dict(stt._counters["dropped"]), stt._counters["heard"]
    yield
    stt._counters["dropped"] = before[0]
    stt._counters["heard"] = before[1]


def _request(tmp_path: Path, **extra) -> dict:
    return {"op": "transcribe", "audio": _wav(tmp_path / "a.wav"), "provisional": True, **extra}


def test_a_cancel_between_segments_stops_the_decode_and_is_never_heard(monkeypatch, tmp_path):
    seen = {"records": 0}
    model = FakeModel(on_segment=lambda index: stt.request_cancel("u-1") if index == 1 else None)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: model)
    monkeypatch.setattr(stt, "_record_hearing", lambda *a, **k: seen.__setitem__("records", seen["records"] + 1))
    heard = stt._counters["heard"]
    faults = stt._counters["dropped"].get("stt-fault", 0)
    result = stt.handle_request(_request(tmp_path, utteranceId="u-1", id=7))
    assert result["ok"] is False
    assert result["reason"] == "cancelled"
    assert result["cancelled"] is True
    assert result["utteranceId"] == "u-1"
    assert model.yielded == 2, "the segment in flight finishes; the next one is never computed"
    assert stt._counters["heard"] == heard
    assert seen["records"] == 0
    assert stt._counters["dropped"].get("stt-fault", 0) == faults


def test_a_cancel_that_arrives_before_the_decode_starts_is_remembered(monkeypatch, tmp_path):
    model = FakeModel()
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: model)
    answer = stt.request_cancel("u-early")
    assert answer["cancelled"] is False and answer["queued"] is True
    result = stt.handle_request(_request(tmp_path, utteranceId="u-early"))
    assert result["reason"] == "cancelled"
    assert model.yielded == 0
    # the memory is spent: the same key is not cancelled twice, so a new decode under it runs
    again = stt.handle_request(_request(tmp_path, utteranceId="u-early"))
    assert again["ok"] is True and again["text"].startswith("open chrome")


def test_a_cancel_for_another_utterance_leaves_the_running_decode_alone(monkeypatch, tmp_path):
    model = FakeModel(on_segment=lambda index: stt.request_cancel("somebody-else") if index == 0 else None)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: model)
    result = stt.handle_request(_request(tmp_path, utteranceId="u-2"))
    assert result["ok"] is True
    assert result["final"] is False
    assert result["text"] == "open chrome and the mail please"


def test_a_final_decode_is_never_cancelled(monkeypatch, tmp_path):
    model = FakeModel(on_segment=lambda index: stt.request_cancel("u-3") if index == 0 else None)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: model)
    request = _request(tmp_path, utteranceId="u-3")
    request.pop("provisional")
    stt.request_cancel("u-3")  # a stale cancel for a key that belongs to a final
    result = stt.handle_request(request)
    assert result["ok"] is True
    assert "cancelled" not in result
    assert model.yielded == 3


def test_an_empty_key_cancels_the_provisional_decode_that_is_running(monkeypatch, tmp_path):
    model = FakeModel(on_segment=lambda index: stt.request_cancel("") if index == 1 else None)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: model)
    result = stt.handle_request(_request(tmp_path, utteranceId="u-4"))
    assert result["reason"] == "cancelled"
    assert model.yielded == 2


def test_the_cancel_does_not_look_like_a_fault_to_the_ladder(monkeypatch, tmp_path):
    """A cancel inside a later pass must not fall through to the Windows recogniser or an `except Exception`."""
    calls: list[str] = []

    def fake_consume(model, payload, kwargs, on_partial):
        calls.append(str(kwargs.get("language")))
        if len(calls) == 1:
            return {
                "text": "I'm going to get a car.",
                "language": "en",
                "languageProbability": 0.62,
                "avgLogprob": -1.2,
                "noSpeechProb": 0.01,
                "noSpeechNote": "",
                "policyCode": "",
                "vadMs": 1800,
                "durationMs": 2000,
            }
        stt.request_cancel("u-5")
        stt.check_cancel()
        raise AssertionError("the second pass must not run after a cancel")

    monkeypatch.setattr(stt, "get_model", lambda *a, **k: object())
    monkeypatch.setattr(stt, "_consume_whisper", fake_consume)
    monkeypatch.setattr(stt, "transcribe_windows", lambda audio: pytest.fail("windows recogniser must not run"))
    result = stt.handle_request(_request(tmp_path, utteranceId="u-5", language=""))
    assert result["reason"] == "cancelled"
    assert len(calls) == 2


def test_cancel_during_the_hindi_ear_stops_before_whisper_opens(monkeypatch, tmp_path):
    opened: list[str] = []
    monkeypatch.setattr(stt.hindi_ear, "tries_ear", lambda *a: True)
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: stt.request_cancel("u-6") and None)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: opened.append("whisper") or FakeModel())
    result = stt.handle_request(_request(tmp_path, utteranceId="u-6", speech_pref="hi-IN"))
    assert result["reason"] == "cancelled"
    assert opened == []


def test_the_cancel_op_answers_at_once_while_a_decode_is_running_in_the_worker(tmp_path):
    """The worker reads its input on its own thread: a cancel is answered while a decode holds the main one."""
    code = (
        "import sys, time, threading\n"
        f"sys.path.insert(0, {str(KERNEL)!r})\n"
        "import stt\n"
        "def slow(req):\n"
        "    if req.get('op') == 'transcribe':\n"
        "        for _ in range(200):\n"
        "            time.sleep(0.01)\n"
        "            try:\n"
        "                stt.check_cancel()\n"
        "            except stt.DecodeCancelled:\n"
        "                return {'ok': False, 'reason': 'cancelled', 'cancelled': True}\n"
        "        return {'ok': True, 'text': 'finished'}\n"
        "    return {'ok': True, 'op': req.get('op')}\n"
        "orig = stt._handle_op\n"
        "def wrapped(req):\n"
        "    if req.get('op') == 'transcribe':\n"
        "        stt.begin_decode(str(req.get('utteranceId') or ''), req.get('provisional') is True)\n"
        "        try:\n"
        "            return slow(req)\n"
        "        finally:\n"
        "            stt.end_decode()\n"
        "    return orig(req)\n"
        "stt._handle_op = wrapped\n"
        "sys.argv = ['stt.py', '--serve']\n"
        "raise SystemExit(stt.main())\n"
    )
    proc = subprocess.Popen(  # noqa: S603
        [sys.executable, "-c", code],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stdin and proc.stdout
        started = time.monotonic()
        proc.stdin.write(json.dumps({"id": 1, "op": "transcribe", "provisional": True, "utteranceId": "w-1"}) + "\n")
        proc.stdin.flush()
        time.sleep(0.15)
        proc.stdin.write(json.dumps({"id": 2, "op": "cancel", "utteranceId": "w-1"}) + "\n")
        proc.stdin.flush()
        rows = [json.loads(proc.stdout.readline()), json.loads(proc.stdout.readline())]
        by_id = {row["id"]: row for row in rows}
        assert by_id[2]["ok"] is True and by_id[2]["cancelled"] is True
        assert by_id[1]["reason"] == "cancelled"
        assert time.monotonic() - started < 1.5, "the decode would have run 2 s without the cancel"
        proc.stdin.write(json.dumps({"id": 3, "op": "shutdown"}) + "\n")
        proc.stdin.flush()
        proc.wait(timeout=10)
        assert proc.returncode == 0
    finally:
        if proc.poll() is None:
            proc.kill()


def test_the_emit_lock_keeps_lines_whole_when_two_threads_write(capsys):
    def spam(tag: str):
        for number in range(200):
            stt.emit({"tag": tag, "n": number, "pad": "x" * 200})

    threads = [threading.Thread(target=spam, args=(tag,)) for tag in "ab"]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    lines = [line for line in capsys.readouterr().out.splitlines() if line]
    assert len(lines) == 400
    assert all(json.loads(line)["pad"] == "x" * 200 for line in lines)


def test_the_pending_cancel_memory_is_bounded():
    for number in range(100):
        stt.request_cancel(f"gone-{number}")
    assert len(stt._cancelled_keys) <= 32
