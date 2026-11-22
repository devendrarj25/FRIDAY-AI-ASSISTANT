"""Worker ops that stream: TTS ``speak-pcm`` (raw int16, nothing on disk) and STT provisional ``flush`` passes.

The speech model is faked unless the real Supertonic files and packages are on this machine.
"""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import types
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import stt  # noqa: E402
import voice_runtime  # noqa: E402

RATE = 22050


class FakeTTS:
    """Deterministic stand-in for supertonic.TTS: a tone whose length follows the text."""

    sample_rate = RATE
    seen: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    def get_voice_style(self, name):
        return name

    def synthesize(self, text, voice_style=None, total_steps=5, speed=1.0, lang="en", silence_duration=0.12):
        FakeTTS.seen.append(text)
        count = int(RATE * 0.01 * max(1, len(text)))
        wave_ = 0.9 * np.sin(np.linspace(0, 440 * np.pi, count))
        wave_[:3] = 1.5  # past full scale: both paths clip to the same sample
        return wave_.astype(np.float32), count / RATE


class FakeSoundfile(types.ModuleType):
    """Only used when libsndfile is not installed: float to PCM_16 the way libsndfile does it."""

    def write(self, buf, audio, rate, format="WAV"):  # noqa: A002
        pcm = np.clip(np.floor(audio * np.float32(32768.0)), -32768, 32767).astype("<i2")
        with wave.open(buf, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(rate)
            handle.writeframes(pcm.tobytes())


@pytest.fixture
def fake_engine(monkeypatch, tmp_path):
    FakeTTS.seen = []
    fake_pkg = types.ModuleType("supertonic")
    fake_pkg.TTS = FakeTTS  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "supertonic", fake_pkg)
    try:
        import soundfile  # noqa: F401
    except Exception:
        monkeypatch.setitem(sys.modules, "soundfile", FakeSoundfile("soundfile"))
    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: tmp_path)
    monkeypatch.setattr(voice_runtime, "_tts", None)
    monkeypatch.setattr(voice_runtime, "_tts_dir", None)
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path / "root"))
    return tmp_path


def _wav_samples(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as handle:
        assert handle.getsampwidth() == 2 and handle.getnchannels() == 1
        return np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")


def _serve(monkeypatch, lines: list[object]) -> list[dict]:
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in lines)))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    assert voice_runtime.serve() == 0
    return [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]


# ---------------------------------------------------------------- speak-pcm


def test_pcm_samples_equal_the_wav_path_within_one_sample(fake_engine):
    for text, lang in (("Open the calendar and read my next meeting", ""), ("नमस्ते open करो please", "hi-IN")):
        wav = voice_runtime.speak_wav_bytes(text, 1.0, lang)
        pcm = voice_runtime.speak_pcm16(text, 1.0, lang)
        assert wav is not None and pcm is not None
        data, rate = pcm
        assert rate == RATE
        mine = np.frombuffer(data, dtype="<i2")
        theirs = _wav_samples(wav)
        assert mine.shape == theirs.shape and mine.size > 0
        assert int(np.max(np.abs(mine.astype(np.int32) - theirs.astype(np.int32)))) <= 1


def test_speak_pcm_op_answers_with_base64_pcm_the_id_and_the_sequence(fake_engine, monkeypatch):
    replies = _serve(
        monkeypatch,
        [
            {
                "id": 7,
                "op": "speak-pcm",
                "text": "Good morning sir",
                "speed": 1.1,
                "lang": "en-IN",
                "style": "F2",
                "seq": 3,
            },
            {"id": 8, "op": "shutdown"},
        ],
    )
    first = replies[0]
    assert first["id"] == 7 and first["ok"] is True and first["seq"] == 3
    assert first["sampleRate"] == RATE and isinstance(first["ms"], int) and first["ms"] >= 0
    raw = base64.b64decode(first["pcm16"])
    assert len(raw) > 0 and len(raw) % 2 == 0
    assert replies[1] == {"id": 8, "ok": True}


def test_speak_pcm_writes_nothing_to_disk_and_never_caches(fake_engine, monkeypatch):
    before = sorted(p.name for p in fake_engine.rglob("*"))
    root = Path(os.environ["FRIDAY_ROOT"])
    _serve(monkeypatch, [{"id": 1, "op": "speak-pcm", "text": "One clause only", "out": str(fake_engine / "x.wav")}])
    assert sorted(p.name for p in fake_engine.rglob("*")) == before
    assert not root.exists()
    # The same clause twice is two syntheses: there is no cache to answer from.
    FakeTTS.seen = []
    _serve(
        monkeypatch,
        [{"id": 1, "op": "speak-pcm", "text": "Same clause"}, {"id": 2, "op": "speak-pcm", "text": "Same clause"}],
    )
    assert FakeTTS.seen == ["Same clause", "Same clause"]


@pytest.mark.parametrize("text", ["", "   \n", None, 42, ["a"]])
def test_speak_pcm_empty_or_bad_text_is_a_refusal_not_a_crash(fake_engine, monkeypatch, text):
    replies = _serve(monkeypatch, [{"id": 5, "op": "speak-pcm", "text": text}, {"id": 6, "op": "status"}])
    assert replies[0] == {"id": 5, "ok": False, "reason": "empty-text"}
    assert replies[1]["id"] == 6 and replies[1]["ok"] is True
    assert FakeTTS.seen == []


def test_speak_pcm_text_is_capped_like_speak(fake_engine, monkeypatch):
    long_text = "word " * 400
    replies = _serve(monkeypatch, [{"id": 1, "op": "speak-pcm", "text": long_text}])
    assert replies[0]["ok"] is True
    assert FakeTTS.seen and max(len(item) for item in FakeTTS.seen) <= 500
    FakeTTS.seen = []
    voice_runtime.speak_wav_bytes(long_text)
    assert max(len(item) for item in FakeTTS.seen) <= 500


def test_speak_pcm_bad_speed_and_seq_are_tolerated(fake_engine, monkeypatch):
    replies = _serve(
        monkeypatch,
        [
            {"id": 1, "op": "speak-pcm", "text": "hello", "speed": "fast", "seq": "x"},
            {"id": 2, "op": "speak-pcm", "text": "hello", "seq": True},
        ],
    )
    assert replies[0]["ok"] is True and "seq" not in replies[0]
    assert replies[1]["ok"] is True and "seq" not in replies[1]


def test_old_ops_keep_their_shapes(fake_engine, monkeypatch):
    out = fake_engine / "speak.wav"
    replies = _serve(
        monkeypatch,
        [
            {"id": 1, "op": "speak", "text": "hello there", "out": str(out)},
            {"id": 2, "op": "nope"},
            {"id": 3, "op": "speak", "text": "hello there"},
        ],
    )
    assert replies[0]["ok"] is True and replies[0]["mime"] == "audio/wav" and out.is_file()
    assert replies[1] == {"id": 2, "ok": False, "reason": "unknown-op"}
    assert replies[2] == {"id": 3, "ok": False, "reason": "no output path"}


def test_speak_pcm_without_a_model_is_a_clear_refusal(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.setattr(voice_runtime, "_tts", None)
    replies = _serve(monkeypatch, [{"id": 1, "op": "speak-pcm", "text": "hello"}])
    assert replies[0]["ok"] is False and replies[0]["reason"] == voice_runtime.LOCAL_TTS_REASON


def test_the_real_worker_process_answers_speak_pcm_without_a_model(tmp_path):
    proc = subprocess.run(
        [sys.executable, str(KERNEL / "voice_runtime.py"), "--serve"],
        input=json.dumps({"id": 1, "op": "speak-pcm", "text": "hi"}) + "\n{broken\n",
        cwd=str(KERNEL),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        env={**os.environ, "FRIDAY_ROOT": str(tmp_path)},
    )
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert lines[0]["id"] == 1 and lines[0]["ok"] is False
    assert lines[1]["reason"] == "bad-request"


def _real_model_ready() -> bool:
    try:
        import soundfile  # noqa: F401
        import supertonic  # noqa: F401
    except Exception:
        return False
    return voice_runtime.supertonic_dir() is not None


@pytest.mark.skipif(not _real_model_ready(), reason="the Supertonic model or its packages are not on this machine")
def test_real_model_pcm_matches_wav_and_costs_no_more():
    text = "Good evening, your meeting starts soon"
    voice_runtime.speak_wav_bytes(text)  # warm
    # Supertonic draws its starting noise at random: the same seed makes the two calls comparable.
    np.random.seed(7)
    wav = voice_runtime.speak_wav_bytes(text)
    np.random.seed(7)
    pcm = voice_runtime.speak_pcm16(text)
    assert wav is not None and pcm is not None
    theirs = _wav_samples(wav)
    mine = np.frombuffer(pcm[0], dtype="<i2")
    assert mine.shape == theirs.shape
    assert int(np.max(np.abs(mine.astype(np.int32) - theirs.astype(np.int32)))) <= 1


# ---------------------------------------------------------------- STT provisional


def _seg(text, ns=0.02, lp=-0.2):
    return SimpleNamespace(text=text, no_speech_prob=ns, avg_logprob=lp)


@pytest.fixture
def fake_whisper(monkeypatch, tmp_path):
    state: dict = {"segments": [_seg("open the calendar")], "duration": 4.0, "kwargs": [], "recorded": 0}

    class FakeModel:
        def transcribe(self, payload, **kwargs):
            state["kwargs"].append(kwargs)
            info = SimpleNamespace(
                duration=state["duration"],
                language=kwargs.get("language") or "en",
                language_probability=0.99,
                duration_after_vad=state["duration"],
            )
            return iter(state["segments"]), info

    audio = tmp_path / "u.wav"
    audio.write_bytes(b"RIFF")
    state["audio"] = str(audio)
    hearing = {"durationMs": 4000, "rmsDbfs": -30.0, "peakDbfs": -6.0}
    monkeypatch.setattr(stt, "prepare_audio", lambda path: (path, None, None, dict(hearing)))
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: FakeModel())
    monkeypatch.setattr(stt, "_record_hearing", lambda *a, **k: state.__setitem__("recorded", state["recorded"] + 1))
    monkeypatch.setattr(stt, "_counters", {"heard": 0, "dropped": {}})
    emitted: list[dict] = []
    monkeypatch.setattr(stt, "emit", emitted.append)
    state["emitted"] = emitted
    return state


def _ask(state: dict, **fields) -> dict:
    return stt.handle_request({"op": "transcribe", "id": 9, "audio": state["audio"], "model": "base", **fields})


def test_a_final_request_keeps_its_shape_counts_and_records(fake_whisper):
    result = _ask(fake_whisper)
    assert result["ok"] is True and result["text"] == "open the calendar"
    assert "final" not in result and "audioMs" not in result and "utteranceId" not in result
    assert stt._counters["heard"] == 1
    assert fake_whisper["recorded"] == 1


def test_a_provisional_request_says_not_final_and_is_never_counted_or_recorded(fake_whisper):
    result = _ask(fake_whisper, provisional=True, utteranceId="utt-1")
    assert result["ok"] is True and result["text"] == "open the calendar"
    assert result["final"] is False and result["audioMs"] == 4000 and result["utteranceId"] == "utt-1"
    assert result["engine"] == "faster-whisper"
    assert stt._counters["heard"] == 0 and stt._counters["dropped"] == {}
    assert fake_whisper["recorded"] == 0
    assert stt._provisional_pass is False
    # The next final request is counted and recorded as before.
    _ask(fake_whisper)
    assert stt._counters["heard"] == 1 and fake_whisper["recorded"] == 1


def test_flush_is_a_provisional_pass_and_streams_the_same_partials(fake_whisper):
    fake_whisper["segments"] = [_seg("open the"), _seg("calendar please")]
    result = stt.handle_request({"op": "flush", "id": 12, "audio": fake_whisper["audio"], "utteranceId": "u2"})
    assert result["final"] is False and result["text"] == "open the calendar please"
    streams = [row for row in fake_whisper["emitted"] if row.get("stream")]
    assert [row["text"] for row in streams] == ["open the", "open the calendar please"]
    assert all(row["id"] == 12 for row in streams)
    assert stt._counters["heard"] == 0 and fake_whisper["recorded"] == 0


def test_the_hallucination_gates_run_on_a_provisional_pass(fake_whisper):
    fake_whisper["segments"] = [_seg("Thank you.", ns=0.3, lp=-0.9)]
    fake_whisper["duration"] = 1.2
    result = _ask(fake_whisper, provisional=True)
    assert result["text"] == "" and result["final"] is False
    assert result["dropCode"] == "no-speech"
    fake_whisper["segments"] = [_seg("subtitles by the community", ns=0.9, lp=-1.4)]
    quiet = _ask(fake_whisper, provisional=True)
    assert quiet["text"] == "" and quiet["dropCode"] == "low-confidence"
    assert stt._counters["dropped"] == {}


def test_language_lock_is_unchanged_on_a_provisional_pass(fake_whisper):
    # Hindi and English stay auto-detect (Hinglish), any other language is locked: a provisional pass does the same.
    for language in ("hi", "fr"):
        fake_whisper["kwargs"].clear()
        _ask(fake_whisper, provisional=True, language=language)
        _ask(fake_whisper, language=language)
        provisional, final = (call.get("language") for call in fake_whisper["kwargs"])
        assert provisional == final == stt.resolve_language(language)
    assert stt.resolve_language("fr") == "fr"


def test_bad_provisional_requests_are_refused_or_ignored(fake_whisper, tmp_path):
    missing = stt.handle_request({"op": "flush", "id": 1, "audio": str(tmp_path / "gone.wav")})
    assert missing["ok"] is False and missing["reason"] == "no-audio" and "final" not in missing
    assert stt.handle_request({"op": "flush", "id": 2})["reason"] == "no-audio"
    # A string "true" is not provisional; a non-string or empty utterance id is dropped; a long one is cut.
    text = _ask(fake_whisper, provisional="true")
    assert "final" not in text and stt._counters["heard"] == 1
    assert "utteranceId" not in _ask(fake_whisper, provisional=True, utteranceId=5)
    assert "utteranceId" not in _ask(fake_whisper, provisional=True, utteranceId="   ")
    assert len(_ask(fake_whisper, provisional=True, utteranceId="x" * 200)["utteranceId"]) == 64


def test_a_failed_provisional_pass_does_not_leave_the_flag_set(fake_whisper, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("decoder fell over")

    monkeypatch.setattr(stt, "_consume_whisper", boom)
    result = _ask(fake_whisper, provisional=True)
    assert result["ok"] is False and "final" not in result
    assert stt._provisional_pass is False
