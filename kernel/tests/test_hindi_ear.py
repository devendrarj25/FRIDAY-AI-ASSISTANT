"""FRIDAY's Hindi ear: Hindi only, only with its pinned files on disk; faster-whisper answers otherwise."""

from __future__ import annotations

import math
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import hindi_ear  # noqa: E402
import nemo_ear  # noqa: E402
import stream_ear  # noqa: E402
import stt  # noqa: E402
from test_nemo_ear import CtcSession  # noqa: E402


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


def test_the_owners_words_reach_the_hindi_ear_reading(monkeypatch):
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: "देवेंदर को कॉल करो।")
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: pytest.fail("faster-whisper must not run"))
    hot = {"hotwords": ["देवेंद्र", "Jarvis"]}
    result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi", extras=hot)
    assert result["text"] == "देवेंद्र को कॉल करो।"
    plain = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi")
    assert plain["text"] == "देवेंदर को कॉल करो।"  # no words asked for: the ear's line as heard


# ---- the CTC head: log probabilities for the chunked CTC reader ------------------------------------------------------

VOCAB = {0: "<blk>", 1: " आज", 2: "मौसम", 3: " अच्छा", 4: "▁है"}  # the runtime swaps the word mark for a space


def _fake_ctc_model(monkeypatch, frames=6, scale=1.0, preprocessed=None, vocab=None):
    """An onnx-asr adapter whose engine has the private steps the real CTC model has."""
    seen: dict = {}

    def preprocessor(waveforms, lens):
        seen["pre"] = (waveforms.shape, waveforms.dtype, lens.tolist())
        return waveforms, lens

    def encode(features, lens):
        raw = np.random.default_rng(1).normal(size=(1, frames + 2, len(VOCAB))).astype(np.float32)
        shifted = raw - raw.max(axis=-1, keepdims=True)
        logp = shifted - np.log(np.exp(shifted).sum(axis=-1, keepdims=True))
        return logp * scale, np.asarray([frames], dtype=np.int64)

    asr = types.SimpleNamespace(
        _vocab=dict(VOCAB if vocab is None else vocab),
        _preprocessor=preprocessed or preprocessor,
        _encode=encode,
        window_step=0.01,
        _subsampling_factor=8,
    )
    model = types.SimpleNamespace(asr=asr, recognize=lambda audio, sample_rate=16000: "आज")
    monkeypatch.setitem(sys.modules, "onnx_asr", types.SimpleNamespace(load_model=lambda *a, **k: model))
    return seen


def _clip(seconds=1.0):
    return np.zeros(int(16000 * seconds), dtype=np.float32)


def test_log_probs_gives_frames_pieces_and_frame_seconds(monkeypatch, tmp_path):
    _stage(tmp_path)
    seen = _fake_ctc_model(monkeypatch, frames=6)
    got = hindi_ear.log_probs(_clip())
    assert got is not None
    lp, pieces, frame_s = got
    assert lp.shape == (6, len(VOCAB)) and lp.dtype == np.float32  # cut to the real frames, not the padding
    assert np.allclose(np.exp(lp).sum(axis=1), 1.0, atol=1e-4)
    assert pieces == ["<blk>", "▁आज", "मौसम", "▁अच्छा", "▁है"]
    assert frame_s == pytest.approx(0.08)
    assert seen["pre"] == ((1, 16000), np.dtype("float32"), [16000])
    assert hindi_ear.ctc_head() == (pieces, pytest.approx(0.08))


@pytest.mark.parametrize("seconds", [0.05, 0.0])
def test_log_probs_is_none_for_a_clip_too_short_to_read(monkeypatch, tmp_path, seconds):
    _stage(tmp_path)
    _fake_ctc_model(monkeypatch)
    assert hindi_ear.log_probs(_clip(seconds)) is None


def test_log_probs_is_none_without_the_files(monkeypatch):
    _fake_ctc_model(monkeypatch)
    assert hindi_ear.log_probs(_clip()) is None and hindi_ear.ctc_head() is None


def test_log_probs_is_none_when_the_runtime_does_not_expose_the_head(monkeypatch, tmp_path):
    _stage(tmp_path)
    _fake_onnx_asr(monkeypatch)  # text-only fake: no engine behind it
    assert hindi_ear.log_probs(_clip()) is None and hindi_ear.ctc_head() is None


def test_log_probs_is_none_when_the_vocabulary_has_no_blank(monkeypatch, tmp_path):
    _stage(tmp_path)
    _fake_ctc_model(monkeypatch, vocab={1: " आज", 2: "मौसम"})
    assert hindi_ear.ctc_head() is None and hindi_ear.log_probs(_clip()) is None


def test_log_probs_refuses_logits_and_survives_a_failing_run(monkeypatch, tmp_path):
    _stage(tmp_path)
    _fake_ctc_model(monkeypatch, scale=-1.0)  # all positive: these are not log probabilities
    assert hindi_ear.log_probs(_clip()) is None

    def broken(waveforms, lens):
        raise RuntimeError("the runtime failed")

    hindi_ear.unload()
    _fake_ctc_model(monkeypatch, preprocessed=broken)
    assert hindi_ear.log_probs(_clip()) is None


def test_log_probs_does_not_change_the_text_readers(monkeypatch, tmp_path):
    _stage(tmp_path)
    _fake_ctc_model(monkeypatch)
    assert hindi_ear.log_probs(_clip()) is not None
    assert hindi_ear.transcribe(_clip()) == "आज"
    assert hindi_ear.last_confidence() is None


def test_the_names_it_reads_exist_in_the_installed_runtime(tmp_path):
    """Contract with the real onnx-asr CTC class (skipped where the package is not installed): the private
    names ``_preprocessor``, ``_encode``, ``_vocab``, ``window_step``, ``_subsampling_factor`` are what this reads."""
    nemo = pytest.importorskip("onnx_asr.models.nemo")
    asr = nemo.NemoConformerCtc.__new__(nemo.NemoConformerCtc)
    asr.config = {}
    asr._vocab = {0: "<blk>", 1: "▁a".replace("▁", " ")}
    asr._preprocessor = lambda w, n: (w, n)
    asr._model = types.SimpleNamespace(run=lambda names, feed: [np.log(np.full((1, 5, 2), 0.5, dtype=np.float32))])
    found = hindi_ear._ctc_engine(types.SimpleNamespace(asr=asr))
    assert found is not None and found[1] == ["<blk>", "▁a"] and found[2] == pytest.approx(0.08)
    head, lens = asr._encode(np.zeros((1, 80, 40), dtype=np.float32), np.asarray([40], dtype=np.int64))
    assert head.shape == (1, 5, 2) and lens.tolist() == [5]


# ---- FRIDAY's own NeMo runner is first choice; the package answers only when it cannot open the folder ----------


def _stage_own(root: Path):
    """A folder the own runner can open (real vocab and config, a big sparse graph), with the session faked."""
    folder = _stage(root)
    pieces = ["<blk>", "▁आज", "मौ", "सम", "▁है"]
    (folder / "vocab.txt").write_text("\n".join(f"{p} {i}" for i, p in enumerate(pieces)), encoding="utf-8")
    (folder / "config.json").write_text('{"model_type": "nemo-conformer-ctc"}', encoding="utf-8")
    sessions: list = []

    def make(path):
        sessions.append(path.name)
        return CtcSession([0, 1, 1, 0, 2, 0, 2, 2, 3, 0, 0, 4, 0])

    return folder, sessions, make


def test_the_own_runner_hears_hindi_without_the_package(monkeypatch, tmp_path):
    _, opened, make = _stage_own(tmp_path)
    monkeypatch.setattr(nemo_ear, "_default_session", lambda path, threads: make(path))
    monkeypatch.setitem(sys.modules, "onnx_asr", None)  # an import of the package would fail the reading
    assert hindi_ear.transcribe(_clip()) == "आजमौमौसम है"
    assert opened == [hindi_ear.MODEL_FILE]  # the int8 graph, once
    assert hindi_ear.last_confidence() == pytest.approx(math.log(0.9) * 7 / 5, abs=1e-4)
    assert hindi_ear.transcribe(_clip()) == "आजमौमौसम है" and opened == [hindi_ear.MODEL_FILE]
    assert isinstance(hindi_ear._model, nemo_ear.NemoEar)


def test_the_own_runner_gives_timed_words_for_the_live_reading(monkeypatch, tmp_path):
    _, _, make = _stage_own(tmp_path)
    monkeypatch.setattr(nemo_ear, "_default_session", lambda path, threads: make(path))
    monkeypatch.setitem(sys.modules, "onnx_asr", None)
    heard = hindi_ear.transcribe_words(_clip())
    assert heard is not None and [w["text"] for w in heard["words"]] == ["आजमौमौसम", "है"]
    assert heard["words"][0]["start"] == pytest.approx(0.08) and heard["words"][1]["start"] == pytest.approx(0.88)
    assert heard["confidence"] == pytest.approx(math.log(0.9) * 7 / 5, abs=1e-4)


def test_the_own_runner_serves_the_ctc_head_for_the_chunked_reader(monkeypatch, tmp_path):
    _, _, make = _stage_own(tmp_path)
    monkeypatch.setattr(nemo_ear, "_default_session", lambda path, threads: make(path))
    monkeypatch.setitem(sys.modules, "onnx_asr", None)
    assert hindi_ear.ctc_head() == (["<blk>", "▁आज", "मौ", "सम", "▁है"], pytest.approx(0.08))
    heard = hindi_ear.log_probs(_clip())
    assert heard is not None and heard[0].shape == (13, 5) and heard[1][-1] == "▁है"
    assert heard[2] == pytest.approx(0.08)
    assert hindi_ear.log_probs(_clip(0.05)) is None  # too short to read


def test_the_package_answers_when_the_own_runner_cannot_open_the_folder(monkeypatch, tmp_path):
    _stage(tmp_path)  # a vocabulary of "x": the own runner refuses it
    loads = _fake_onnx_asr(monkeypatch)
    assert hindi_ear.transcribe(_clip()) == "आज मौसम अच्छा है"
    assert [load["quantization"] for load in loads] == ["int8"] and not isinstance(hindi_ear._model, nemo_ear.NemoEar)


def test_a_graph_the_runtime_refuses_falls_back_to_the_package_too(monkeypatch, tmp_path):
    _stage_own(tmp_path)

    def broken(path, threads):
        raise RuntimeError("onnxruntime cannot open it")

    monkeypatch.setattr(nemo_ear, "_default_session", broken)
    _fake_onnx_asr(monkeypatch)
    assert hindi_ear.transcribe(_clip()) == "आज मौसम अच्छा है"


def test_with_neither_runner_the_ear_gives_way_to_faster_whisper(monkeypatch, tmp_path):
    _stage(tmp_path)
    monkeypatch.setitem(sys.modules, "onnx_asr", None)
    assert hindi_ear.transcribe(_clip()) is None and hindi_ear.last_confidence() is None
    assert hindi_ear.transcribe_words(_clip()) is None and hindi_ear.log_probs(_clip()) is None


def test_the_own_runner_is_not_asked_for_a_head_the_package_has_to_give(monkeypatch, tmp_path):
    _stage(tmp_path)
    _fake_ctc_model(monkeypatch)  # the package path: no ctc_head on the object, the private names are read
    assert hindi_ear.ctc_head() == (["<blk>", " आज".replace(" ", "▁"), "मौसम", "▁अच्छा", "▁है"], pytest.approx(0.08))


def test_the_package_import_is_the_only_one_left_in_the_kernel():
    source = Path(hindi_ear.__file__).read_text(encoding="utf-8")
    assert source.count("import onnx_asr") == 1
    others = [p for p in Path(hindi_ear.__file__).parent.glob("*.py") if p.name != "hindi_ear.py"]
    assert not [p.name for p in others if "import onnx_asr" in p.read_text(encoding="utf-8")]


def test_the_hindi_engine_needs_the_own_runner_modules_not_the_pip_package():
    spec = next(s for s in map(stream_ear.engine_spec, stream_ear.engine_names()) if s and "hindi-ear" in s.aliases)
    assert spec.modules == ("numpy", "onnxruntime")
    assert "onnx_asr" not in spec.modules


def test_the_doctor_line_passes_on_the_own_runner_without_onnx_asr(monkeypatch):
    import importlib.util

    import voice_runtime

    real = importlib.util.find_spec
    monkeypatch.setattr(hindi_ear, "ready", lambda *a, **k: True)
    monkeypatch.setattr(importlib.util, "find_spec", lambda n, *a: None if n == "onnx_asr" else real(n, *a))
    assert voice_runtime._hindi_ear_line() == "PASS hindi-ear int8 weights present (own runner)"
    monkeypatch.setattr(importlib.util, "find_spec", lambda n, *a: None if n == "onnxruntime" else real(n, *a))
    assert voice_runtime._hindi_ear_line().startswith("FAIL hindi-ear")
    assert "onnxruntime" in voice_runtime._hindi_ear_line()


# ---- the owner's words bias the ear (a context graph of the words and their spellings) -----------------------------


class _BiasableModel:
    """A stand-in for FRIDAY's own runner: a timed reader that records what it is asked, plus ``hotword_bias``."""

    def __init__(self):
        self.asked: list[dict] = []
        self.built: list[list[str]] = []

    def hotword_bias(self, words):
        self.built.append(list(words))
        return ("graph", tuple(words))

    def with_timestamps(self):
        outer = self

        class Reader:
            def recognize(self, audio, sample_rate=16000, **kwargs):
                outer.asked.append(kwargs)
                return nemo_ear.NemoReading("आज", [" आज"], [0.0], [-0.1])

        return Reader()


def _biasable(monkeypatch, tmp_path, model=None):
    _stage(tmp_path)
    monkeypatch.setattr(hindi_ear, "_last_confidence", None)  # restored after the test: no score leaks on
    model = model or _BiasableModel()
    monkeypatch.setattr(hindi_ear, "_load", lambda folder: model)
    monkeypatch.setattr(hindi_ear, "_timed", None)
    monkeypatch.setattr(hindi_ear, "_bias", None)
    return model


def test_with_hotwords_scopes_the_words_and_restores_the_earlier_ones():
    assert hindi_ear._owner_words == ()
    with hindi_ear.with_hotwords(["Devendra", " ", "Friday"]):
        assert hindi_ear._owner_words == ("Devendra", "Friday")
        with hindi_ear.with_hotwords(None):
            assert hindi_ear._owner_words == ()
        assert hindi_ear._owner_words == ("Devendra", "Friday")
    assert hindi_ear._owner_words == ()


def test_the_words_reach_the_timed_reader_as_one_graph_built_once_per_list(monkeypatch, tmp_path):
    model = _biasable(monkeypatch, tmp_path)
    with hindi_ear.with_hotwords(["Devendra"]):
        heard = hindi_ear.transcribe_words(_clip())
        assert heard is not None and heard["text"] == "आज"
        assert hindi_ear.transcribe(_clip()) == "आज"
    assert model.asked == [{"hotwords": ("graph", ("Devendra",))}] * 2 and model.built == [["Devendra"]]
    with hindi_ear.with_hotwords(["Friday"]):
        hindi_ear.transcribe(_clip())
    assert model.built == [["Devendra"], ["Friday"]]


def test_with_no_words_the_reader_is_asked_exactly_as_before(monkeypatch, tmp_path):
    model = _biasable(monkeypatch, tmp_path)
    hindi_ear.transcribe(_clip())
    hindi_ear.transcribe_words(_clip())
    with hindi_ear.with_hotwords([]):
        hindi_ear.transcribe(_clip())
    assert model.asked == [{}, {}, {}] and model.built == []


def test_words_that_spell_nothing_are_not_passed(monkeypatch, tmp_path):
    model = _biasable(monkeypatch, tmp_path)
    model.hotword_bias = lambda words: None  # type: ignore[method-assign]
    with hindi_ear.with_hotwords(["Zzyzx"]):
        hindi_ear.transcribe(_clip())
    assert model.asked == [{}]


def test_the_package_fallback_takes_no_words_and_still_reads(monkeypatch, tmp_path):
    _stage(tmp_path)
    _fake_onnx_asr(monkeypatch)
    monkeypatch.setitem(sys.modules, "nemo_ear", types.SimpleNamespace(NemoEar=None, kind_of=lambda t: "ctc"))
    with hindi_ear.with_hotwords(["Devendra"]):
        assert hindi_ear.transcribe(_clip()) == "आज मौसम अच्छा है"


def test_the_own_runner_biases_a_spoken_word_and_keeps_the_acoustic_gate(monkeypatch, tmp_path):
    _, _, make = _stage_own(tmp_path)
    monkeypatch.setattr(nemo_ear, "_default_session", lambda path, threads: make(path))
    monkeypatch.setitem(sys.modules, "onnx_asr", None)
    plain = hindi_ear.transcribe_words(_clip())
    with hindi_ear.with_hotwords(["है"]):  # a word that was spoken: the beam keeps it, now with times and scores
        biased = hindi_ear.transcribe_words(_clip())
    assert plain is not None and biased is not None and biased["text"] == plain["text"]
    assert biased["confidence"] == pytest.approx(plain["confidence"], abs=1e-3)
    assert hindi_ear.confident("hi", biased["confidence"]) is True


def test_an_unspoken_word_leaves_the_reading_and_its_score_untouched(monkeypatch, tmp_path):
    _, _, make = _stage_own(tmp_path)
    monkeypatch.setattr(nemo_ear, "_default_session", lambda path, threads: make(path))
    monkeypatch.setitem(sys.modules, "onnx_asr", None)
    plain = hindi_ear.transcribe_words(_clip())
    with hindi_ear.with_hotwords(["सम", "देवेंद्र", "Jarvis"]):
        biased = hindi_ear.transcribe_words(_clip())
    assert biased == plain


def test_a_biased_reading_with_weak_acoustic_scores_is_still_dropped_by_the_gate(monkeypatch, tmp_path):
    model = _biasable(monkeypatch, tmp_path)

    class Weak:
        def recognize(self, audio, sample_rate=16000, **kwargs):
            return nemo_ear.NemoReading("आज", [" आज"], [0.0], [-2.5])

    model.with_timestamps = lambda: Weak()  # type: ignore[method-assign]
    with hindi_ear.with_hotwords(["आज"]):
        heard = hindi_ear.transcribe_words(_clip())
    assert heard is not None and heard["confidence"] == pytest.approx(-2.5)
    assert hindi_ear.confident("hi", heard["confidence"]) is False and hindi_ear.confident("auto", -2.5) is False


def test_stt_puts_the_owners_words_around_every_hindi_ear_read(monkeypatch):
    seen: list[tuple[str, tuple[str, ...]]] = []
    line = "मुझे चाय चाहिए"
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda s: seen.append(("final", hindi_ear._owner_words)) or line)
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: pytest.fail("faster-whisper must not run"))
    hot = {"hotwords": ["देवेंद्र", "Jarvis"]}
    stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi", extras=hot)
    stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi")
    assert seen == [("final", ("देवेंद्र", "Jarvis")), ("final", ())] and hindi_ear._owner_words == ()


def test_the_hindi_stream_reader_reads_inside_the_words_and_keeps_its_gates(monkeypatch):
    seen: list[tuple[str, ...]] = []
    heard = {"text": "आज", "words": [{"text": "आज", "start": 0.0, "end": 0.5}], "confidence": -0.05}

    def read(window):
        seen.append(hindi_ear._owner_words)
        return dict(heard)

    monkeypatch.setattr(stt.hindi_ear, "transcribe_words", read)
    reader = stt._hindi_stream_reader(Path(), stt.TurnLanguage("hi"), ["Devendra"])
    assert [w.text for w in reader([0.0] * 16000, "")] == ["आज"]
    heard["confidence"] = -2.0  # the unsure gate drops it, with or without words
    assert reader([0.0] * 16000, "") == []
    assert seen == [("Devendra",), ("Devendra",)] and hindi_ear._owner_words == ()


# ---- the English gate: English spelled in Devanagari is not kept as Hindi in auto ---------------------------------


@pytest.mark.parametrize(
    ("text", "confidence", "verdict", "why"),
    [
        # clear Hindi is kept from the text alone (no model run)
        ("कल मीटिंग कितने बजे है", -0.06, "keep", "hindi-words"),
        ("राहुल को रिपोर्ट भेजो", -0.01, "keep", "hindi-words"),
        ("आवाज़ थोड़ी कम करो", -0.12, "keep", "hindi-words"),
        ("माँ को फ़ोन करो", -0.16, "keep", "hindi-words"),
        ("सात बजकर तीस मिनट का अलार्म लगाओ", -0.10, "keep", "hindi-words"),
        ("आज मौसम कैसा है", -0.05, "keep", "hindi-words"),
        ("मेरा आखिरी ईमेल पढ़ो", -0.12, "keep", "hindi-words"),
        ("र्रोम खॉलो", -0.25, "keep", "hindi-words"),  # the ear's own spelling of a Hindi verb (ॉ for ो)
        ("मौसम कैसा है", -0.30, "keep", "hindi-words"),  # Hindi words hold even when the score is middling
        # Hinglish (Hindi grammar around English words) stays the ear's line
        ("प्लीज मेरा ईमेल ओपन करो", -0.20, "keep", "hindi-words"),
        ("सेवन थर्टी का अलार्म लगाओ", -0.22, "keep", "hindi-words"),
        ("मुझे द रिपोर्ट भेजो", -0.25, "keep", "hindi-words"),
        ("मीटिंग कल है", -0.18, "keep", "hindi-words"),
        # English spelled in Devanagari is sent to the English lane (no model run)
        ("व्हाट टाइम इज द मीरिंग ट मारो", -0.30, "english", "english-words"),
        ("व्हाट टाइम इसज द मीरिंग ट मरोो", -0.30, "english", "english-words"),
        ("ओप एन क्राउम प्लीज", -0.23, "english", "english-words"),
        ("सेरेनो व्म फॉर सेवन थर्टी", -0.30, "english", "english-words"),
        ("हाउ आर यू", -0.10, "english", "english-words"),  # even a sure-sounding score: these are English words
        ("टर्न द वॉल्यूम डाउन", -0.31, "english", "english-words"),
        # a line the text cannot tell: the clip's own cue is asked for
        ("खाओ माम", -0.23, "listen", "unclear"),
        ("ओपन क्रोम", -0.25, "listen", "unclear"),
        ("फोन वॉल्यूम म्यूट", -0.28, "listen", "unclear"),
        # a sure ear with no English function words keeps its line without a model run
        ("ओपन क्रोम", -0.10, "keep", "sure-ear"),
        ("खाओ माम", -0.05, "keep", "sure-ear"),
        # nothing to judge, or the ear itself wrote Latin letters: kept as written
        ("", -0.10, "keep", "no-words"),
        ("मेरा email खोलो", -0.20, "keep", "mixed-script"),
    ],
)
def test_the_english_gate_reads_the_ears_own_words(text, confidence, verdict, why):
    gate = hindi_ear.english_gate(text, confidence)
    assert (gate["verdict"], gate["why"]) == (verdict, why)


def test_the_english_gate_counts_a_devanagari_rendering_of_an_owner_english_word():
    plain = hindi_ear.english_gate("ओप वॉल्यम", -0.25)
    assert plain["verdict"] == "listen"
    assert plain["weak"] == 1  # volume, by its consonants (v-l-m), with no table spelling of this form
    hot = hindi_ear.english_gate("प्लीज जार्विस", -0.25, ["Jarvis"])
    assert hot["strong"] == 1 and hot["weak"] == 1 and hot["verdict"] == "english"
    assert hindi_ear.english_gate("प्लीज जार्विस", -0.25)["verdict"] == "listen"


def test_a_short_hindi_word_never_reads_as_english_by_its_consonants():
    # कल (k-l) folds like "call"; a two-consonant fold is never evidence, and a Hindi word is Hindi first
    assert hindi_ear.english_gate("कल", -0.25)["verdict"] == "keep"


@pytest.mark.parametrize(
    ("cue", "prior", "verdict", "why"),
    [
        ({"en": 0.64, "hi": 0.01}, "", "english", "cue-en"),
        ({"en": 0.95, "hi": 0.02}, "hi", "english", "cue-en"),  # the clip outweighs the turn before it
        ({"en": 0.02, "hi": 0.95}, "en", "keep", "cue-hi"),
        ({"en": 0.39, "hi": 0.26}, "", "keep", "ear-kept"),  # an unclear cue with no prior: today's behaviour
        ({"en": 0.39, "hi": 0.26}, "en", "english", "prior-en"),  # an unclear cue: the turn before decides
        (None, "en", "english", "prior-en"),  # no resident whisper: the prior decides
        (None, "hi", "keep", "ear-kept"),
        (None, "", "keep", "ear-kept"),
        ({"en": 0.55, "hi": 0.30}, "", "keep", "ear-kept"),  # not three times as likely: not enough
    ],
)
def test_an_unclear_line_is_settled_by_the_clips_cue_then_the_prior(cue, prior, verdict, why):
    gate = hindi_ear.english_gate("खाओ माम", -0.23)
    settled = hindi_ear.settle_gate(gate, cue, prior)
    assert (settled["verdict"], settled["why"]) == (verdict, why)


def test_a_clear_verdict_is_never_changed_by_a_cue_or_a_prior():
    for text, verdict in (("आज मौसम कैसा है", "keep"), ("हाउ आर यू", "english")):
        gate = hindi_ear.english_gate(text, -0.2)
        for cue in (None, {"en": 0.99, "hi": 0.0}, {"en": 0.0, "hi": 0.99}):
            for prior in ("", "en", "hi"):
                assert hindi_ear.settle_gate(gate, cue, prior)["verdict"] == verdict


def test_the_gate_thresholds_are_one_named_table():
    table = hindi_ear.ENGLISH_GATE
    names = {"sureLogprob", "strongMin", "shareMin", "foldMinConsonants", "cueSeconds", "cueMin", "cueRatio"}
    assert set(table) >= names
    assert table["sureLogprob"] > hindi_ear.EAR_MIN_LOGPROB["auto"]  # the gate never lowers the ear's own floor
