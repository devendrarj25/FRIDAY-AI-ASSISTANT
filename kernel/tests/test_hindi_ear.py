"""FRIDAY's Hindi ear: Hindi only, only with its pinned files on disk; faster-whisper answers otherwise."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import hindi_ear  # noqa: E402
import stt  # noqa: E402


def _stage(root: Path, big: bool = True) -> Path:
    folder = root / "models" / hindi_ear.MODEL_DIR
    folder.mkdir(parents=True)
    (folder / "vocab.txt").write_text("x", encoding="utf-8")
    (folder / "config.json").write_text("{}", encoding="utf-8")
    model = folder / hindi_ear.MODEL_FILE
    with model.open("wb") as handle:
        handle.truncate(hindi_ear.MIN_MODEL_BYTES + 1 if big else 10)  # a sparse file: no real bytes written
    return folder


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.setattr(hindi_ear, "_model", None)
    monkeypatch.setattr(hindi_ear, "_model_dir", "")


def _fake_onnx_asr(monkeypatch, text="आज मौसम अच्छा है", fail=False):
    loads: list[dict] = []

    class Model:
        def recognize(self, audio, sample_rate=16000):
            if fail:
                raise RuntimeError("the runtime failed")
            self.seen = (len(audio), sample_rate)
            return text

    def load_model(kind, path=None, quantization=None):
        loads.append({"kind": kind, "path": path, "quantization": quantization})
        return Model()

    monkeypatch.setitem(sys.modules, "onnx_asr", types.SimpleNamespace(load_model=load_model))
    return loads


def test_it_is_ready_only_with_all_three_files_and_a_whole_model(tmp_path):
    assert hindi_ear.model_dir() is None and hindi_ear.ready() is False
    _stage(tmp_path, big=False)
    assert hindi_ear.ready() is False  # a partial download is not ready
    (tmp_path / "models" / hindi_ear.MODEL_DIR / hindi_ear.MODEL_FILE).unlink()
    with (tmp_path / "models" / hindi_ear.MODEL_DIR / hindi_ear.MODEL_FILE).open("wb") as handle:
        handle.truncate(hindi_ear.MIN_MODEL_BYTES + 1)
    assert hindi_ear.ready() is True
    (tmp_path / "models" / hindi_ear.MODEL_DIR / "vocab.txt").unlink()
    assert hindi_ear.ready() is False


@pytest.mark.parametrize(
    ("language", "pref", "expected"),
    [
        ("hi", "", True),
        ("hi-IN", "", True),
        ("hi_IN", "", True),
        ("en", "hi", True),
        ("hi", "en", False),
        ("auto", "", False),
        ("mixed", "", False),
        ("", "", False),
        ("hinglish", "", False),
        ("he", "", False),
    ],
)
def test_it_hears_only_when_hindi_is_chosen(language, pref, expected):
    assert hindi_ear.wants_hindi(language, pref) is expected


def test_it_loads_the_int8_file_once_and_hears_devanagari(monkeypatch, tmp_path):
    folder = _stage(tmp_path)
    loads = _fake_onnx_asr(monkeypatch)
    one_second = [0.01] * 16000
    assert hindi_ear.transcribe(one_second) == "आज मौसम अच्छा है"
    assert hindi_ear.transcribe(one_second) == "आज मौसम अच्छा है"
    assert loads == [{"kind": "nemo-conformer-ctc", "path": str(folder), "quantization": "int8"}]


def test_it_gives_way_to_faster_whisper_when_it_cannot_hear(monkeypatch, tmp_path):
    one_second = [0.01] * 16000
    assert hindi_ear.transcribe(one_second) is None  # nothing on disk
    _stage(tmp_path)
    _fake_onnx_asr(monkeypatch, fail=True)
    assert hindi_ear.transcribe(one_second) is None  # the runtime failed
    _fake_onnx_asr(monkeypatch, text="hello there")
    assert hindi_ear.transcribe(one_second) is None  # no Devanagari: not Hindi
    _fake_onnx_asr(monkeypatch, text="")
    assert hindi_ear.transcribe(one_second) is None
    _fake_onnx_asr(monkeypatch)
    assert hindi_ear.transcribe([0.01] * 100) is None  # under 0.2 s
    monkeypatch.delitem(sys.modules, "onnx_asr")
    monkeypatch.setitem(sys.modules, "onnx_asr", None)  # the package is not installed
    assert hindi_ear.transcribe(one_second) is None


def test_a_long_recording_is_cut_to_sixty_seconds(monkeypatch, tmp_path):
    _stage(tmp_path)
    sizes: list[int] = []

    class Model:
        def recognize(self, audio, sample_rate=16000):
            sizes.append(len(audio))
            return "ठीक है"

    monkeypatch.setitem(sys.modules, "onnx_asr", types.SimpleNamespace(load_model=lambda *a, **k: Model()))
    assert hindi_ear.transcribe([0.0] * (16000 * 90)) == "ठीक है"
    assert sizes == [16000 * 60]


def test_the_worker_uses_it_for_hindi_and_reports_the_engine(monkeypatch):
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: "मुझे चाय चाहिए")
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: pytest.fail("faster-whisper must not run"))
    result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi")
    assert result["text"] == "मुझे चाय चाहिए"
    assert result["engine"] == "hindi-ear"
    assert result["language"] == "hi"


def test_the_worker_falls_back_to_faster_whisper_when_the_ear_hears_nothing(monkeypatch):
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: None)
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    seen: list[object] = []

    class FakeModel:
        pass

    def fake_consume(model, payload, kwargs, on_partial):
        seen.append(kwargs.get("language"))
        return {
            "text": "मुझे चाय चाहिए",
            "language": "hi",
            "languageProbability": 0.99,
            "avgLogprob": -0.2,
            "noSpeechProb": 0.01,
            "noSpeechNote": "",
            "policyCode": "",
            "vadMs": 1000,
            "durationMs": 1000,
        }

    monkeypatch.setattr(stt, "get_model", lambda *a, **k: FakeModel())
    monkeypatch.setattr(stt, "_consume_whisper", fake_consume)
    result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi")
    assert result["engine"] == "faster-whisper"
    assert seen  # faster-whisper heard it


def test_other_languages_never_reach_the_hindi_ear(monkeypatch):
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: pytest.fail("not Hindi"))
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})

    class FakeModel:
        pass

    monkeypatch.setattr(stt, "get_model", lambda *a, **k: FakeModel())
    monkeypatch.setattr(
        stt,
        "_consume_whisper",
        lambda *a, **k: {
            "text": "open chrome",
            "language": "en",
            "languageProbability": 0.99,
            "avgLogprob": -0.1,
            "noSpeechProb": 0.01,
            "noSpeechNote": "",
            "policyCode": "",
            "vadMs": 1000,
            "durationMs": 1000,
        },
    )
    for language in ("en", "auto", "hinglish"):
        result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", language, "", None, language)
        assert result["engine"] == "faster-whisper"


def test_the_status_says_whether_the_ear_is_installed(tmp_path):
    assert stt.status_payload()["hindiEarReady"] is False
    _stage(tmp_path)
    assert stt.status_payload()["hindiEarReady"] is True


def test_the_voice_check_has_a_hindi_ear_line(monkeypatch, tmp_path):
    import voice_runtime

    assert voice_runtime._hindi_ear_line() == "OPTIONAL hindi-ear optional - not installed"
    _stage(tmp_path)
    monkeypatch.setitem(sys.modules, "onnx_asr", None)  # not importable, so not found either
    monkeypatch.setattr("importlib.util.find_spec", lambda name: None)
    assert voice_runtime._hindi_ear_line().startswith("FAIL hindi-ear")
    monkeypatch.setattr("importlib.util.find_spec", lambda name: object())
    assert voice_runtime._hindi_ear_line() == "PASS hindi-ear int8 weights present"
