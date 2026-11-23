"""The end-of-turn score runs inside a worker that already holds the model, and never costs the decode a second run."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import pytest
import stt
import voice_runtime


@pytest.fixture(autouse=True)
def _root(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    voice_runtime._turn_model.clear()
    yield
    voice_runtime._turn_model.clear()


def _install_model_file(root: Path) -> None:
    folder = root / "models" / "smart-turn"
    folder.mkdir(parents=True)
    (folder / voice_runtime.SMART_TURN_NAME).write_bytes(b"x")


def _fake_runtime(monkeypatch, probability: float = 0.9):
    """A stand-in onnxruntime and feature extractor that count how often they are opened."""
    opened = {"sessions": 0, "extractors": 0, "runs": 0}

    class Session:
        def __init__(self, path, providers=None):
            opened["sessions"] += 1

        def run(self, _names, feeds):
            opened["runs"] += 1
            assert feeds["input_features"].shape == (1, 80, 800)
            return [np.array([[probability]], dtype=np.float32)]

    class Extractor:
        n_samples = 128000

        def __init__(self, feature_size=80, chunk_length=8):
            opened["extractors"] += 1

        def __call__(self, audio, padding=0):
            return np.zeros((80, 800), dtype=np.float32)

    ort = types.ModuleType("onnxruntime")
    ort.InferenceSession = Session  # type: ignore[attr-defined]
    fe = types.ModuleType("faster_whisper.feature_extractor")
    fe.FeatureExtractor = Extractor  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    monkeypatch.setitem(sys.modules, "faster_whisper.feature_extractor", fe)
    return opened


def test_the_session_and_extractor_are_opened_once_for_many_turns(monkeypatch, tmp_path):
    _install_model_file(tmp_path)
    opened = _fake_runtime(monkeypatch)
    samples = np.full(16000, 0.1, dtype=np.float32)
    answers = [voice_runtime.score_turn(samples, 16000) for _ in range(4)]
    assert all(a["ready"] and abs(a["probability"] - 0.9) < 1e-6 and a["complete"] for a in answers)
    assert opened == {"sessions": 1, "extractors": 1, "runs": 4}


def test_a_failed_open_is_not_kept_and_is_not_a_cut_off(monkeypatch, tmp_path):
    _install_model_file(tmp_path)
    opened = _fake_runtime(monkeypatch)
    ort = sys.modules["onnxruntime"]

    def broken(*_a, **_k):
        raise RuntimeError("bad model")

    good = ort.InferenceSession
    monkeypatch.setattr(ort, "InferenceSession", broken)
    failed = voice_runtime.score_turn(np.full(16000, 0.1, dtype=np.float32), 16000)
    assert failed["ready"] is False and failed["probability"] is None
    assert voice_runtime._turn_model == {}
    monkeypatch.setattr(ort, "InferenceSession", good)
    assert voice_runtime.score_turn(np.full(16000, 0.1, dtype=np.float32), 16000)["ready"] is True
    assert opened["sessions"] == 1


def test_the_score_op_reads_a_clip_by_path_and_answers_like_the_one_shot(monkeypatch, tmp_path):
    _install_model_file(tmp_path)
    _fake_runtime(monkeypatch, 0.3)
    clip = tmp_path / "turn.wav"
    clip.write_bytes(b"RIFF")
    monkeypatch.setattr(voice_runtime, "load_pcm", lambda path: np.full(16000, 0.1, dtype=np.float32))
    out = stt.handle_request({"op": "score-turn", "audio": str(clip)})
    assert out["ok"] is True and out["ready"] is True
    assert abs(out["probability"] - 0.3) < 1e-6 and out["complete"] is False


@pytest.mark.parametrize(
    "audio",
    [
        None,
        5,
        1.5,
        [],
        {},
        True,
        "",
        " ",
        "x" * 5000,
        "a\x00b",
        "../../etc/passwd",
        "C:\\no\\such\\file.wav",
        "\u0939\u093f\u0928\u094d\u0926\u0940.wav",
    ],
)
def test_hostile_payloads_never_raise_and_never_score(monkeypatch, tmp_path, audio):
    _install_model_file(tmp_path)
    opened = _fake_runtime(monkeypatch)
    out = voice_runtime.score_turn_payload({"op": "score-turn", "audio": audio})
    assert out == {"ok": True, "ready": False, "probability": None, "reason": "no audio"}
    assert opened["runs"] == 0


def test_a_folder_and_an_oversized_file_are_not_clips(monkeypatch, tmp_path):
    _install_model_file(tmp_path)
    opened = _fake_runtime(monkeypatch)
    assert voice_runtime.score_turn_payload({"audio": str(tmp_path)})["reason"] == "no audio"
    big = tmp_path / "big.wav"
    with big.open("wb") as handle:
        handle.truncate(voice_runtime.MAX_SCORE_BYTES + 1)
    assert voice_runtime.score_turn_payload({"audio": str(big)})["reason"] == "no audio"
    assert opened["runs"] == 0


def test_a_non_object_request_is_safe():
    for req in (None, [], "x", 3):
        assert voice_runtime.score_turn_payload(req)["ready"] is False  # type: ignore[arg-type]


def test_the_decode_does_not_wait_for_a_score_unless_one_is_asked_for(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: calls.append(1) or {"probability": 0.8})
    monkeypatch.setattr(
        stt,
        "_consume_whisper",
        lambda *a, **k: {
            "text": "hello there",
            "language": "en",
            "languageProbability": 0.99,
            "avgLogprob": -0.2,
            "noSpeechProb": 0.0,
            "noSpeechNote": "",
            "policyCode": "",
            "vadMs": 900,
            "durationMs": 1000,
        },
    )
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: object())
    samples = np.zeros(16000, dtype=np.float32)
    plain = stt._transcribe_prepared(
        "x.wav", samples, "small", "en", "", None, "en", "", "", {"rmsDbfs": -30.0}, samples, {}
    )
    assert calls == [] and plain["turnProbability"] is None
    asked = stt._transcribe_prepared(
        "x.wav", samples, "small", "en", "", None, "en", "", "", {"rmsDbfs": -30.0}, samples, {"turn_score": True}
    )
    assert calls == [1] and asked["turnProbability"] == 0.8
