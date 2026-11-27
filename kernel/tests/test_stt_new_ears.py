"""FRIDAY's own final-pass ears in the speech worker: Swift, Quick and English.

Each is used only when its pinned folder is certified on disk, every load asks the memory gate, the language decides the
ear, and a missing, refused or broken own ear hands the turn to the ear that answers today. Fake ears only: nothing here
opens a model.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import hindi_ear  # noqa: E402
import shruti_ear  # noqa: E402
import stt  # noqa: E402

CLIP = np.full(16000, 0.01, dtype=np.float32)


class FakeEar:
    """The surface of an own ear with a scripted answer; ``calls`` records what it was asked."""

    def __init__(self, ident, text="", why="", fault="", ready=True, language="en", error=None):
        self.ident, self.label, self.name, self.kind = ident, f"FRIDAY Ear {ident}", f"{ident}-id", f"{ident}-ear"
        self.engine, self.model, self.load_mb = f"friday-ear-{ident}", f"{ident}-model", 100.0
        self.text, self.why, self.fault_text, self.is_ready = text, why, fault, ready
        self.language, self.err = language, error
        self.calls: list[str | None] = []
        self.open = False

    def ready(self):
        return self.is_ready

    def error(self):
        return self.err

    def last_skip(self):
        return self.why

    def fault(self):
        return self.fault_text

    def last_language(self):
        return self.language

    def loaded(self):
        return self.open

    def unload(self):
        was, self.open = self.open, False
        return was

    def transcribe(self, samples, language=None):
        self.calls.append(language)
        return self.text or None


@pytest.fixture
def ears(monkeypatch):
    """Three fake ears, a quiet worker, and no moonshine package: the order of the chain is what each test reads."""
    fakes = {"swift": FakeEar("swift", language="hi"), "quick": FakeEar("quick"), "english": FakeEar("english")}
    monkeypatch.setattr(stt, "SWIFT", fakes["swift"])
    monkeypatch.setattr(stt, "QUICK", fakes["quick"])
    monkeypatch.setattr(stt, "ENGLISH", fakes["english"])
    monkeypatch.setattr(stt, "moonshine_model_dir", lambda: None)
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: None)
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    monkeypatch.setattr(stt, "_fallbacks", {})
    return fakes


def _whisper(monkeypatch, text="open chrome", language="en"):
    class Model:
        pass

    seen: list[object] = []

    def consume(model, payload, kwargs, on_partial):
        seen.append(kwargs.get("language"))
        return {
            "text": text,
            "language": language,
            "languageProbability": 0.99,
            "avgLogprob": -0.1,
            "noSpeechProb": 0.01,
            "noSpeechNote": "",
            "policyCode": "",
            "vadMs": 1000,
            "durationMs": 1000,
        }

    monkeypatch.setattr(stt, "get_model", lambda *a, **k: Model())
    monkeypatch.setattr(stt, "_consume_whisper", consume)
    return seen


def _turn(language, pref, extras=None):
    return stt._transcribe_prepared("x.wav", CLIP, "base", language, "", None, pref, extras=extras)


# ---- the English chain: English, then Quick, then the moonshine package, then faster-whisper -----------------------


def test_english_goes_to_the_accurate_ear_first(ears, monkeypatch):
    ears["english"].text, ears["quick"].text = "Open Chrome.", "open chrome"
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: pytest.fail("faster-whisper must not run"))
    result = _turn("en", "en")
    assert (result["text"], result["engine"], result["language"]) == ("Open Chrome.", "friday-ear-english", "en")
    assert result["model"] == "english-model"
    assert ears["quick"].calls == [] and ears["swift"].calls == []


def test_quick_answers_when_the_english_ear_is_not_installed(ears, monkeypatch):
    ears["english"].is_ready, ears["quick"].text = False, "open chrome"
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: pytest.fail("faster-whisper must not run"))
    result = _turn("en", "en")
    assert (result["text"], result["engine"]) == ("open chrome", "friday-ear-quick")
    assert ears["english"].calls == []  # a missing ear is never asked


def test_a_refused_or_broken_english_ear_hands_on_to_quick(ears):
    ears["english"].why, ears["quick"].text = "low-memory", "open chrome"
    assert _turn("en", "en")["engine"] == "friday-ear-quick"
    assert stt._fallbacks.get("english-id-to-next") == 1
    ears["english"].why, ears["english"].fault_text = "", "the runtime failed"
    assert _turn("en", "en")["engine"] == "friday-ear-quick"


def test_the_moonshine_package_is_only_the_fallback_of_the_own_ears(ears, monkeypatch):
    ears["english"].is_ready = ears["quick"].is_ready = False
    monkeypatch.setattr(stt, "moonshine_model_dir", lambda: "/models/moonshine-en")
    monkeypatch.setattr(stt, "transcribe_moonshine", lambda samples, folder, on_partial: "open chrome")
    result = _turn("en", "en")
    assert (result["engine"], result["model"]) == ("moonshine-en", "moonshine-tiny-streaming")
    ears["quick"].is_ready, ears["quick"].text = True, "open chrome now"
    monkeypatch.setattr(stt, "transcribe_moonshine", lambda *a: pytest.fail("the package must not run"))
    assert _turn("en", "en")["engine"] == "friday-ear-quick"


def test_every_english_ear_missing_or_broken_leaves_faster_whisper(ears, monkeypatch):
    ears["english"].is_ready = ears["quick"].is_ready = False
    seen = _whisper(monkeypatch)
    result = _turn("en", "en")
    assert result["engine"] == "faster-whisper" and result["text"] == "open chrome" and seen
    ears["quick"].is_ready, ears["quick"].fault_text = True, "boom"
    assert _turn("en", "en")["engine"] == "faster-whisper"


def test_an_ear_that_heard_only_silence_ends_the_chain_and_whisper_decides(ears, monkeypatch):
    seen = _whisper(monkeypatch, text="")
    result = _turn("en", "en")
    assert result["engine"] == "faster-whisper" and seen
    assert ears["english"].calls == [None] and ears["quick"].calls == []  # one silent decode, not three


def test_the_partial_callback_gets_the_own_ear_text(ears):
    ears["english"].text = "open chrome"
    heard: list[str] = []
    stt._transcribe_prepared("x.wav", CLIP, "base", "en", "", heard.append, "en")
    assert heard == ["open chrome"]


# ---- the language decides the ear ----------------------------------------------------------------------------------


@pytest.mark.parametrize(("language", "pref"), [("hi", "hi"), ("", "auto"), ("hi", "hi-IN"), ("", "mixed")])
def test_hindi_and_open_turns_go_to_swift_not_to_the_english_ears(ears, monkeypatch, language, pref):
    ears["swift"].text, ears["english"].text = "मुझे चाय चाहिए", "I need tea"
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: pytest.fail("faster-whisper must not run"))
    result = _turn(language, pref)
    assert (result["text"], result["engine"], result["language"]) == ("मुझे चाय चाहिए", "friday-ear-swift", "hi")
    assert ears["english"].calls == [] and ears["quick"].calls == []
    assert ears["swift"].calls == ["hi" if pref.startswith("hi") else None]


def test_an_english_turn_never_reaches_swift_and_roman_hinglish_stays_on_whisper(ears, monkeypatch):
    ears["swift"].text, ears["english"].text = "नमस्ते", "hello"
    assert _turn("en", "en")["engine"] == "friday-ear-english"
    seen = _whisper(monkeypatch, text="kal milte hain", language="hi")
    assert _turn("hi", "hi-Latn")["engine"] == "faster-whisper" and seen
    assert ears["swift"].calls == []


def test_swift_reports_the_language_it_heard(ears):
    ears["swift"].text, ears["swift"].language = "open the door please", "en"
    result = _turn("", "auto")
    assert (result["engine"], result["language"]) == ("friday-ear-swift", "en")


def test_swift_comes_after_the_hindi_ear(ears, monkeypatch):
    ears["swift"].text = "swift line"
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: "मुझे चाय चाहिए")
    monkeypatch.setattr(stt.hindi_ear, "last_confidence", lambda: -0.01)
    result = _turn("hi", "hi")
    assert result["engine"] == "hindi-ear" and ears["swift"].calls == []


def test_swift_reads_what_an_unsure_hindi_ear_left(ears, monkeypatch):
    ears["swift"].text = "I will call you later"
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: "आई विल कॉल यू")
    monkeypatch.setattr(stt.hindi_ear, "last_confidence", lambda: -1.5)  # below every floor: not trusted
    result = _turn("", "auto")
    assert (result["engine"], result["text"]) == ("friday-ear-swift", "I will call you later")


def test_swift_snaps_to_the_owners_words(ears):
    ears["swift"].text = "फ्राइडे खोलो"
    result = _turn("hi", "hi", extras={"hotwords": ["फ्राइडे"]})
    assert result["engine"] == "friday-ear-swift" and "फ्राइडे" in result["text"]


# ---- fallback: missing, refused, broken ----------------------------------------------------------------------------


@pytest.mark.parametrize("state", ["missing", "refused", "broken", "decode-error"])
def test_a_swift_that_cannot_answer_leaves_the_turn_to_faster_whisper(ears, monkeypatch, state):
    swift = ears["swift"]
    swift.is_ready = state != "missing"
    swift.why = {"refused": "low-memory", "broken": "broken"}.get(state, "")
    swift.fault_text = "the runtime failed" if state == "decode-error" else ""
    seen = _whisper(monkeypatch, text="मुझे चाय चाहिए", language="hi")
    result = _turn("hi", "hi")
    assert result["engine"] == "faster-whisper" and result["text"] == "मुझे चाय चाहिए" and seen
    assert (swift.calls == []) if state == "missing" else (len(swift.calls) == 1)
    if state in {"refused", "broken", "decode-error"}:
        assert stt._fallbacks.get("shruti-ear-to-whisper") == 1


def test_swift_is_not_asked_twice_when_the_open_reread_runs(ears, monkeypatch):
    """A locked read that scored poorly is read again on the open route: Swift already looked at this clip."""
    seen = _whisper(monkeypatch, text="hello there", language="en")
    _turn("", "auto")
    assert len(ears["swift"].calls) == 1
    _turn("", "auto", extras={"swift_done": True})
    assert len(ears["swift"].calls) == 1 and seen


# ---- certified folders, the memory gate, a broken real runner ------------------------------------------------------


def _marker(root: Path, repo: str, files: dict[str, int]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    rows = {name: {"bytes": size, "sha256": "ab" * 32} for name, size in files.items()}
    (root / stt.PIN_MARKER).write_text(json.dumps({"schema": 1, "repo": repo, "revision": "r1", "files": rows}))


def _file(root: Path, rel: str, size: int) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.truncate(size)  # sparse: no real bytes written


def _stage_swift(models: Path, sub="hi/onnx", certify=True) -> Path:
    base = models / "shruti-ear"
    sizes = {name: (6_000_000 if name == shruti_ear.ENCODER else 11_000_000) for name in shruti_ear.REQUIRED}
    sizes[shruti_ear.FRONTEND] = sizes[shruti_ear.VOCAB] = 1000
    for name, size in sizes.items():
        _file(base, f"{sub}/{name}", size)
    if certify:
        _marker(base, stt.SWIFT_REPO, {f"{sub}/{name}": size for name, size in sizes.items()})
    return base / sub


@pytest.fixture
def models(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    return tmp_path / "models"


def test_swift_needs_its_certified_pin_folder(models):
    assert stt._swift_found() is None  # nothing installed
    _stage_swift(models, certify=False)
    assert stt._swift_found() is None  # files without the Install Manager's record are not certified
    folder = _stage_swift(models)
    found = stt._swift_found()
    assert found is not None and found.folder == folder
    assert stt.SWIFT.ready() and stt.SWIFT.error() is None


def test_swift_prefers_the_standard_set_and_falls_back_to_the_int8_set(models):
    int8 = _stage_swift(models, "hi/onnx-int8")
    found = stt._swift_found()
    assert found is not None and found.folder == int8
    base = int8.parent.parent
    both = {
        f"{sub}/{name}": (base / sub / name).stat().st_size
        for sub in stt.SWIFT_SETS
        for name in shruti_ear.REQUIRED
        if (base / sub / name).exists()
    }
    standard = _stage_swift(models, "hi/onnx", certify=False)
    both |= {f"hi/onnx/{n}": (standard / n).stat().st_size for n in shruti_ear.REQUIRED}
    _marker(base, stt.SWIFT_REPO, both)
    found = stt._swift_found()
    assert found is not None and found.folder == standard


def test_a_short_or_foreign_folder_is_not_certified(models):
    base = _stage_swift(models).parent.parent
    (base / "hi/onnx" / shruti_ear.DECODER).write_bytes(b"x")  # a partial download
    assert stt._swift_found() is None
    _stage_swift(models)
    record = json.loads((base / stt.PIN_MARKER).read_text())
    (base / stt.PIN_MARKER).write_text(json.dumps({**record, "repo": "someone/else"}))
    assert stt._swift_found() is None


def test_quick_needs_the_graphs_and_the_vocabulary_both_certified(models):
    graphs = {f"{stt.QUICK_SET}/quantized/{name}": 9_000_000 for name in stt.QUICK_FILES}
    for rel, size in graphs.items():
        _file(models / "moonshine-ear", rel, size)
    _marker(models / "moonshine-ear", stt.QUICK_REPO, graphs)
    assert stt._quick_found() is None  # no vocabulary yet
    _file(models / "moonshine-ear-vocab", "tokenizer.json", 2000)
    _marker(models / "moonshine-ear-vocab", stt.QUICK_VOCAB_REPO, {"tokenizer.json": 2000})
    found = stt._quick_found()
    assert found is not None and found.folder == models / "moonshine-ear" / stt.QUICK_SET
    assert found.extra["tokenizer"] == models / "moonshine-ear-vocab" / "tokenizer.json"
    assert set(found.extra["sha256"]) == set(stt.QUICK_FILES)  # the pinned hashes go to the runtime door


def test_the_english_ear_needs_all_four_pinned_files(models):
    sizes = {name: 5000 for name in stt.ENGLISH_FILES}
    for name, size in sizes.items():
        _file(models / "parakeet-ear", name, size)
    _marker(models / "parakeet-ear", stt.ENGLISH_REPO, {k: v for k, v in sizes.items() if k != "vocab.txt"})
    assert stt._english_found() is None  # the record lacks one of the files
    _marker(models / "parakeet-ear", stt.ENGLISH_REPO, sizes)
    assert stt._english_found() is not None


def _real_ear(tmp_path, build, read=lambda runner, audio, language: "hello"):
    folder = tmp_path / "ear"
    folder.mkdir(exist_ok=True)
    stamp = [(str(folder), 1, 1)]
    ear = stt.OwnEar(
        "x", "FRIDAY Ear X", "x-id", 100.0, lambda: stt._Found(folder, stamp[0], {}), build, read, "ear-x", "x-model"
    )
    return ear, stamp


def test_every_load_asks_the_memory_gate_first(monkeypatch, tmp_path):
    asked: list[tuple[str, float]] = []
    built: list[int] = []
    ear, _ = _real_ear(tmp_path, lambda found: built.append(1) or object())
    monkeypatch.setattr(stt, "admit", lambda kind, mb: asked.append((kind, mb)) or False)
    assert ear.transcribe(CLIP) is None
    assert asked == [("x-ear", 100.0)] and built == [] and ear.last_skip() == "low-memory" and not ear.loaded()
    assert ear.ready()  # a refusal is not a breakage: the next turn asks again
    monkeypatch.setattr(stt, "admit", lambda kind, mb: asked.append((kind, mb)) or True)
    assert ear.transcribe(CLIP) == "hello" and built == [1] and ear.loaded()
    assert ear.transcribe(CLIP) == "hello" and built == [1] and len(asked) == 2  # an open ear is not admitted again


def test_a_runner_that_cannot_open_is_remembered_until_the_files_change(monkeypatch, tmp_path):
    attempts: list[int] = []

    def build(found):
        attempts.append(1)
        raise RuntimeError("graph cannot be read")

    ear, stamp = _real_ear(tmp_path, build)
    monkeypatch.setattr(stt, "admit", lambda kind, mb: True)
    assert ear.transcribe(CLIP) is None and ear.last_skip() == "broken"
    assert not ear.ready() and ear.error()
    assert ear.transcribe(CLIP) is None and attempts == [1]  # not opened again on every turn
    stamp[0] = (stamp[0][0], 2, 2)  # a re-download changes the files
    assert ear.ready() and ear.transcribe(CLIP) is None and attempts == [1, 1]


def test_a_decode_error_is_a_fault_not_a_crash_and_short_clips_are_not_read(monkeypatch, tmp_path):
    def read(runner, audio, language):
        raise ValueError("bad shape")

    ear, _ = _real_ear(tmp_path, lambda found: object(), read)
    monkeypatch.setattr(stt, "admit", lambda kind, mb: True)
    assert ear.transcribe(CLIP) is None and ear.fault() and ear.ready()
    assert ear.transcribe(np.zeros(100, dtype=np.float32)) is None and ear.fault() == ""


def test_a_long_clip_is_cut_to_sixty_seconds_and_the_ear_unloads(monkeypatch, tmp_path):
    sizes: list[int] = []

    def read(runner, audio, language):
        sizes.append(len(audio))
        return "text", "en"

    ear, _ = _real_ear(tmp_path, lambda found: object(), read)
    monkeypatch.setattr(stt, "admit", lambda kind, mb: True)
    assert ear.transcribe(np.zeros(16000 * 90, dtype=np.float32)) == "text"
    assert sizes == [16000 * 60] and ear.last_language() == "en"
    assert ear.unload() is True and not ear.loaded() and ear.unload() is False


def test_swift_runs_the_shruti_runner_behind_the_gate(models, monkeypatch):
    _stage_swift(models)
    asked: list[str] = []

    class Runner:
        languages = ("hi", "en")

        def transcribe(self, audio, language=None, beams=5):
            return {"text": "namaste friday", "language": "hi", "confidence": -0.1}

    monkeypatch.setattr(shruti_ear, "load_runner", lambda folder: Runner())
    monkeypatch.setattr(stt, "admit", lambda kind, mb: asked.append(kind) or True)
    monkeypatch.setattr(stt.SWIFT, "_runner", None)
    monkeypatch.setattr(stt.SWIFT, "_broken", {})
    text = stt.SWIFT.transcribe(CLIP, "hi")
    assert text and asked == ["swift-ear"] and stt.SWIFT.loaded() and stt.SWIFT.last_language() == "hi"
    stt.SWIFT.unload()


# ---- memory eviction, status and the self-test rows ----------------------------------------------------------------


def test_the_gate_can_drop_an_idle_own_ear_and_the_names_show_it(ears):
    ears["quick"].open = True
    assert stt._resident_mb("quick-ear") == 100.0 and stt._resident_mb("english-ear") == 0.0
    assert "quick-id" in stt.loaded_names()
    assert stt._evict("quick-ear") is True and not ears["quick"].open
    ears["english"].open = True
    assert "english-ear" in stt.EVICT_ORDER and stt.unload_models().count("english-id") == 1
    assert not ears["english"].open


def test_status_lists_one_row_per_ear(ears):
    ears["quick"].is_ready, ears["english"].err = False, "RuntimeError"
    rows = {row["id"]: row for row in stt.own_ears_status()}
    assert list(rows) == ["swift", "quick", "english"]
    assert rows["quick"]["ready"] is False and rows["english"]["error"] == "RuntimeError"
    assert stt.status_payload()["ownEars"] == stt.own_ears_status()


def test_the_real_ears_are_named_for_the_doctor():
    assert [ear.label for ear in stt._own_ears()] == ["FRIDAY Ear Swift", "FRIDAY Ear Quick", "FRIDAY Ear English"]
    assert [ear.name for ear in stt._own_ears()] == ["shruti-ear", "moonshine-ear", "parakeet-ear"]


def test_the_self_test_has_a_row_per_ear_and_only_a_failure_fails_it(ears):
    ears["swift"].is_ready = False  # not installed: a visible, harmless "missing"
    ears["quick"].why = "low-memory"
    ears["english"].text = "hello"
    report = stt.run_own_ears_self_test(CLIP)
    status = {row["id"]: row["status"] for row in report["ears"]}
    assert status == {"swift": "missing", "quick": "refused", "english": "ok"} and report["ok"] is True
    ears["english"].fault_text = "boom"
    report = stt.run_own_ears_self_test(CLIP)
    assert {row["id"]: row["status"] for row in report["ears"]}["english"] == "failed" and report["ok"] is False


def test_the_self_test_is_an_op_and_a_use_of_the_models(ears):
    assert "ears-self-test" in stt.USE_OPS
    report = stt.handle_request({"op": "ears-self-test"})
    assert [row["id"] for row in report["ears"]] == ["swift", "quick", "english"]


def test_hindi_ear_and_the_stream_ear_are_untouched(ears):
    assert stt.hindi_ear.admit_hook is stt.admit and stt.stream_ear.admit_hook is stt.admit
    assert hindi_ear.MODEL_DIR == "hindi-ear"
