"""The ``echo-shadow`` worker op: measure the echo canceller on 160 ms chunks, report levels, never gate."""

from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path

import pytest

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import echo_canceller  # noqa: E402
import voice_runtime  # noqa: E402

np, _aec, _missing = echo_canceller._load()
pytestmark = pytest.mark.skipif(np is None or bool(_missing), reason="numpy or pyaec is not installed")

RATE = 16000
CHUNK = 2560  # 160 ms


def _speech_like(seconds: float, seed: int = 7):
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    x = np.convolve(rng.standard_normal(n), np.ones(8) / 8, "same")
    x *= 0.6 + 0.4 * np.sin(2 * np.pi * 3 * np.arange(n) / RATE)
    return x / np.max(np.abs(x)) * 9000


def _room(ref, delay_ms: float, gain: float):
    taps = np.zeros(400)
    taps[0] = gain
    taps[40] = gain * 0.4
    taps[150] = -gain * 0.2
    echo = np.convolve(ref, taps)[: len(ref)]
    return np.concatenate([np.zeros(int(delay_ms * RATE / 1000)), echo])[: len(ref)]


def _b64(samples) -> str:
    return base64.b64encode(np.asarray(samples, dtype="<i2").tobytes()).decode("ascii")


@pytest.fixture(autouse=True)
def fresh_shadow(monkeypatch):
    monkeypatch.setattr(voice_runtime, "_echo_shadow", None)


def _run_chunks(mic, ref):
    replies = []
    for start in range(0, len(mic) - CHUNK + 1, CHUNK):
        request = {
            "mic": _b64(mic[start : start + CHUNK]),
            "ref": _b64(ref[start : start + CHUNK]),
            "seq": start // CHUNK,
        }
        replies.append(voice_runtime.echo_shadow_payload(request))
    return replies


def test_reports_the_reduction_on_a_synthetic_room_and_returns_no_audio():
    ref = _speech_like(6).astype(np.int16)
    mic = _room(ref.astype(np.float64), 60, 0.5).astype(np.int16)
    replies = _run_chunks(mic, ref)
    assert all(r["ok"] and r["ready"] and r["gate"] is False for r in replies)
    assert [r["seq"] for r in replies] == list(range(len(replies)))
    assert not any("pcm" in key or "audio" in key for r in replies for key in r)
    settled = [r for r in replies[len(replies) // 2 :] if r["cancelled"]]
    assert len(settled) >= 5
    average = sum(r["reductionDb"] for r in settled) / len(settled)
    assert average >= 20.0, f"shadow reduction {average:.1f} dB"
    assert abs(replies[-1]["delayMs"] - 60.0) <= 1.0
    assert all(r["residualDb"] <= r["micDb"] + 0.5 for r in settled)


def test_nothing_playing_measures_levels_but_reports_no_reduction():
    mic = (_speech_like(1, 3) * 0.2).astype(np.int16)[:CHUNK]
    for ref in (None, np.zeros(CHUNK, dtype=np.int16)):
        reply = voice_runtime.echo_shadow_payload({"mic": _b64(mic), **({} if ref is None else {"ref": _b64(ref)})})
        assert reply["ok"] and reply["playing"] is False and reply["cancelled"] is False
        assert reply["reductionDb"] is None
        assert reply["micDb"] == reply["residualDb"]  # the chunk came back untouched


def test_reset_starts_over_and_a_bad_request_is_refused_not_raised():
    ref = _speech_like(3).astype(np.int16)
    mic = _room(ref.astype(np.float64), 40, 0.5).astype(np.int16)
    _run_chunks(mic, ref)
    first = voice_runtime.echo_shadow_payload({"mic": _b64(mic[:CHUNK]), "ref": _b64(ref[:CHUNK]), "reset": True})
    assert first["ok"] and first["delayMs"] is None
    cases = [
        ({"mic": "not base64!!"}, "bad-audio"),
        ({"mic": ""}, "bad-audio"),
        ({"mic": _b64(mic[:CHUNK]), "ref": _b64(ref[: CHUNK - 160])}, "length-mismatch"),
        ({"mic": base64.b64encode(b"\x00\x01\x02").decode()}, "bad-audio"),
        ({"mic": _b64(np.zeros(RATE + 160, dtype=np.int16))}, "too-long"),
    ]
    for request, reason in cases:
        reply = voice_runtime.echo_shadow_payload(request)
        assert reply["ok"] is False and reply["reason"] == reason


def test_unavailable_canceller_is_a_reason_not_an_error(monkeypatch):
    monkeypatch.setattr(echo_canceller, "_load", lambda: (None, None, "pyaec is not installed"))
    reply = voice_runtime.echo_shadow_payload({"mic": _b64(np.zeros(CHUNK, dtype=np.int16))})
    assert reply["ok"] is False and reply["ready"] is False
    assert "pyaec" in reply["reason"]


def test_the_worker_loop_answers_the_op_with_its_id(monkeypatch, capsys):
    ref = _speech_like(1, 5).astype(np.int16)[:CHUNK]
    mic = _room(ref.astype(np.float64), 30, 0.5).astype(np.int16)
    lines = [{"id": 9, "op": "echo-shadow", "mic": _b64(mic), "ref": _b64(ref), "seq": 3}, {"id": 10, "op": "status"}]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in lines)))
    assert voice_runtime.serve() == 0
    replies = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert replies[0]["id"] == 9 and replies[0]["seq"] == 3 and replies[0]["ok"] is True
    assert replies[1]["id"] == 10
