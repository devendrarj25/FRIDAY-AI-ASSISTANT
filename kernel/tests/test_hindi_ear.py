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


def _english_model(monkeypatch):
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


def test_english_and_other_languages_never_reach_the_hindi_ear(monkeypatch):
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: pytest.fail("not Hindi"))
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    _english_model(monkeypatch)
    for language in ("en", "en-IN", "en-US", "hinglish", "hi-Latn", "fr"):
        result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", language, "", None, language)
        assert result["engine"] == "faster-whisper"


def test_auto_tries_the_ear_but_only_keeps_a_line_it_is_sure_of(monkeypatch):
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    _english_model(monkeypatch)
    seen: list[int] = []
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: seen.append(1) or "ओपन क्रोम")
    for pref in ("auto", "mixed", ""):
        monkeypatch.setattr(stt.hindi_ear, "_last_confidence", -0.9)  # English read as Devanagari: unsure
        result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "", "", None, pref)
        assert result["engine"] == "faster-whisper" and result["text"] == "open chrome"
        assert "unsure" in result["languageNote"]
    assert len(seen) == 3
    monkeypatch.setattr(stt.hindi_ear, "_last_confidence", -0.1)  # a clear Hindi line
    result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "", "", None, "auto")
    assert result["engine"] == "hindi-ear" and result["language"] == "hi"


def test_hindi_chosen_is_more_lenient_than_auto(monkeypatch):
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    _english_model(monkeypatch)
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: "मुझे चाय चाहिए")
    monkeypatch.setattr(stt.hindi_ear, "_last_confidence", -0.37)
    assert stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi-IN")["engine"] == "hindi-ear"
    assert stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "", "", None, "auto")["engine"] == "faster-whisper"
    monkeypatch.setattr(stt.hindi_ear, "_last_confidence", -1.4)  # garbled even for a Hindi owner
    assert (
        stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi-IN")["engine"] == "faster-whisper"
    )


@pytest.mark.parametrize(
    ("language", "pref", "mode"),
    [
        ("hi", "", "hi"),
        ("hi-IN", "", "hi"),
        ("en", "hi", "hi"),
        ("hi", "en", "en"),
        ("en-IN", "", "en"),
        ("en-US", "", "en"),
        ("", "", "auto"),
        ("auto", "", "auto"),
        ("mixed", "", "auto"),
        ("", "AUTO", "auto"),
        ("hi-Latn", "", "roman"),
        ("hi_latn_in", "", "roman"),
        ("hinglish-roman", "", "roman"),
        ("fr", "", "other"),
        ("hinglish", "", "other"),
        ("he", "", "other"),
    ],
)
def test_the_listening_mode_table(language, pref, mode):
    assert hindi_ear.listen_mode(language, pref) == mode
    assert hindi_ear.tries_ear(language, pref) is (mode in {"hi", "auto"})


def test_the_ear_keeps_a_line_by_its_own_scores(tmp_path):
    assert hindi_ear.confident("hi", None) and hindi_ear.confident("auto", None)  # unmeasured: today's behaviour
    assert hindi_ear.confident("auto", -0.27) and not hindi_ear.confident("auto", -0.36)
    assert hindi_ear.confident("hi", -0.37) and not hindi_ear.confident("hi", -0.5)
    assert hindi_ear.confident("en", -5.0)  # no other mode is ever judged here


def test_the_ear_reports_its_mean_token_score_when_the_runtime_gives_one(monkeypatch, tmp_path):
    _stage(tmp_path)

    class Heard:
        text = "आज मौसम अच्छा है"
        logprobs = [-0.1, -0.3, -0.2]

    class Timed:
        def recognize(self, audio, sample_rate=16000):
            return Heard()

    class Model:
        def with_timestamps(self):
            return Timed()

    monkeypatch.setitem(sys.modules, "onnx_asr", types.SimpleNamespace(load_model=lambda *a, **k: Model()))
    assert hindi_ear.transcribe([0.01] * 16000) == "आज मौसम अच्छा है"
    assert hindi_ear.last_confidence() == pytest.approx(-0.2)
    monkeypatch.setitem(
        sys.modules,
        "onnx_asr",
        types.SimpleNamespace(load_model=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x"))),
    )
    monkeypatch.setattr(hindi_ear, "_model", None)
    assert hindi_ear.transcribe([0.01] * 16000) is None
    assert hindi_ear.last_confidence() is None  # a failed reading carries no score


def test_unload_drops_the_model_the_reader_and_the_folder_and_reports_it(monkeypatch):
    monkeypatch.setattr(hindi_ear, "_model", object())
    monkeypatch.setattr(hindi_ear, "_timed", (object(), object()))
    monkeypatch.setattr(hindi_ear, "_model_dir", "C:\\ears\\hi")
    assert hindi_ear.loaded() is True
    assert hindi_ear.unload() is True
    assert (hindi_ear._model, hindi_ear._timed, hindi_ear._model_dir) == (None, None, "")
    assert hindi_ear.loaded() is False
    assert hindi_ear.unload() is False  # nothing open: a second call is a quiet no-op
