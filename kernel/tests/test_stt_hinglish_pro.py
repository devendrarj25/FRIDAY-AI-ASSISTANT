"""FRIDAY Ear Hinglish Pro in the speech worker: the converted CTranslate2 folder, certified, for Roman Hinglish turns.

The folder is a small fake with a verification marker like the one the Doctor writes; nothing opens a model. The ear
answers only the explicit Roman Hinglish mode, only when its folder is certified, every load asks the memory gate,
and any refusal, failure or silence hands the turn to the ear that answers today.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import stt  # noqa: E402

CLIP = np.full(16000, 0.01, dtype=np.float32)
PRO = "friday-ear-hinglish-pro"
FILES = {
    "model.bin": b"ct2-int8-weights",
    "config.json": b"{}",
    "tokenizer.json": b"{}",
    "vocabulary.json": b"[]",
    "preprocessor_config.json": b"{}",
    "README.md": b"card",
}


def _install(root: Path, repo: str = stt.HINGLISH_PRO_REPO, marker: bool = True, skip: str = "") -> Path:
    folder = root / "models" / stt.HINGLISH_PRO_DIR
    folder.mkdir(parents=True)
    for name, data in FILES.items():
        if name != skip:
            (folder / name).write_bytes(data)
    if marker:
        record = {
            "schema": 1,
            "repo": repo,
            "revision": "f3214eed20b4e4d4144e739982d911f87b9cb223",
            "files": {name: {"bytes": len(data), "sha256": "0" * 64} for name, data in FILES.items()},
        }
        (folder / stt.PIN_MARKER).write_text(json.dumps(record), encoding="utf-8")
    return folder


class Runner:
    """What the CTranslate2 model is for the ear: opened once, asked for text."""


@pytest.fixture
def pro(monkeypatch, tmp_path):
    """A fresh Hinglish Pro ear on a temp root: a tiny ``model.bin`` is whole, the build and the decode are scripted."""
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.setattr(stt, "HINGLISH_PRO_MIN_BYTES", 10)
    state: dict = {"builds": 0, "build_error": None, "text": "kal milte hain", "decode_error": None}

    def build(found):
        state["builds"] += 1
        if state["build_error"]:
            raise state["build_error"]
        return Runner()

    def read(runner, audio, language):
        if state["decode_error"]:
            raise state["decode_error"]
        state["language"] = language
        return state["text"], "hi"

    ear = stt.OwnEar(
        "hinglish-pro", "FRIDAY Ear Hinglish Pro", stt.HINGLISH_PRO_DIR, stt.HINGLISH_PRO_LOAD_MB,
        stt._hinglish_pro_found, build, read, PRO, "pro-model", language="hi",
    )  # fmt: skip
    monkeypatch.setattr(stt, "HINGLISH_PRO", ear)
    admits: list[tuple[str, float]] = []
    state["admits"], state["allow"] = admits, True
    monkeypatch.setattr(stt, "admit", lambda kind, mb, required=False: (admits.append((kind, mb)), state["allow"])[1])
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: None)
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    monkeypatch.setattr(stt, "_fallbacks", {})
    state["root"], state["ear"] = tmp_path, ear
    return state


def _whisper(monkeypatch, text="open chrome"):
    seen: list[object] = []

    def consume(model, payload, kwargs, on_partial):
        seen.append(kwargs.get("language"))
        return {
            "text": text, "language": "hi", "languageProbability": 0.9, "avgLogprob": -0.1, "noSpeechProb": 0.01,
            "noSpeechNote": "", "policyCode": "", "vadMs": 1000, "durationMs": 1000,
        }  # fmt: skip

    monkeypatch.setattr(stt, "get_model", lambda *a, **k: Runner())
    monkeypatch.setattr(stt, "_consume_whisper", consume)
    return seen


def _turn(language, pref, extras=None):
    return stt._transcribe_prepared("x.wav", CLIP, "base", language, "", None, pref, extras=extras)


# ---- the folder is found only when certified -----------------------------------------------------------------------


def test_the_ear_is_not_ready_without_a_folder(pro):
    assert pro["ear"].ready() is False and stt._hinglish_pro_found() is None


def test_a_certified_folder_is_found_with_its_stamp(pro):
    folder = _install(pro["root"])
    found = stt._hinglish_pro_found()
    assert found is not None and found.folder == folder and pro["ear"].ready() is True


@pytest.mark.parametrize(
    "case", ["no-marker", "other-repo", "missing-file", "short-model", "wrong-size", "marker-lacks-file"]
)
def test_an_uncertified_or_partial_folder_is_never_found(pro, monkeypatch, case):
    if case == "no-marker":
        _install(pro["root"], marker=False)
    elif case == "other-repo":
        _install(pro["root"], repo="someone/else")
    elif case == "missing-file":
        _install(pro["root"], skip="vocabulary.json")
    elif case == "short-model":
        _install(pro["root"])
        monkeypatch.setattr(stt, "HINGLISH_PRO_MIN_BYTES", 1000)
    elif case == "wrong-size":
        folder = _install(pro["root"])
        (folder / "model.bin").write_bytes(b"x")
    else:
        folder = _install(pro["root"])
        record = json.loads((folder / stt.PIN_MARKER).read_text(encoding="utf-8"))
        del record["files"]["config.json"]
        (folder / stt.PIN_MARKER).write_text(json.dumps(record), encoding="utf-8")
    assert stt._hinglish_pro_found() is None and pro["ear"].ready() is False


def test_the_source_checkpoint_alone_is_not_a_folder(pro):
    folder = pro["root"] / "models" / stt.HINGLISH_PRO_DIR
    folder.mkdir(parents=True)
    (folder / "model.safetensors").write_bytes(b"bf16" * 10)
    assert stt._hinglish_pro_found() is None


# ---- the route: Roman Hinglish only, behind the gate, with today's path as the fallback ----------------------------


def test_a_roman_hinglish_turn_is_read_by_the_ear_before_whisper(pro, monkeypatch):
    _install(pro["root"])
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: pytest.fail("faster-whisper must not run"))
    result = _turn("hi", "hi-Latn")
    assert (result["text"], result["engine"], result["language"]) == ("kal milte hain", PRO, "hi")
    assert result["model"] == "pro-model" and result["ok"] is True
    assert pro["language"] == "en" and pro["builds"] == 1  # the language token en, one open
    assert pro["admits"] == [("hinglish-pro-ear", stt.HINGLISH_PRO_LOAD_MB)]  # the gate asked, with the real size


def test_the_ear_is_opened_once_and_reused(pro):
    _install(pro["root"])
    assert _turn("hi", "hi-Latn")["engine"] == PRO
    assert _turn("", "hinglish-roman")["engine"] == PRO
    assert pro["builds"] == 1 and len(pro["admits"]) == 1


@pytest.mark.parametrize(
    ("language", "pref"), [("en", "en"), ("hi", "hi"), ("", "auto"), ("hi", "hi-IN"), ("", "mixed")]
)
def test_other_modes_never_ask_the_ear(pro, monkeypatch, language, pref):
    _install(pro["root"])
    _whisper(monkeypatch)
    assert _turn(language, pref)["engine"] != PRO
    assert pro["builds"] == 0 and pro["admits"] == []


def test_an_uninstalled_ear_leaves_the_turn_to_the_ear_of_today(pro, monkeypatch):
    seen = _whisper(monkeypatch, text="kal milte hain")
    assert _turn("hi", "hi-Latn")["engine"] == "faster-whisper"
    assert seen and pro["builds"] == 0 and pro["admits"] == []


def test_a_refused_load_hands_on_and_is_counted(pro, monkeypatch):
    _install(pro["root"])
    pro["allow"] = False
    seen = _whisper(monkeypatch)
    assert _turn("hi", "hi-Latn")["engine"] == "faster-whisper" and seen and pro["builds"] == 0
    assert stt._fallbacks.get("hinglish-pro-to-whisper") == 1
    pro["allow"] = True  # the memory came back: the next turn may open it
    assert _turn("hi", "hi-Latn")["engine"] == PRO


def test_a_folder_that_cannot_open_is_remembered_and_never_retried(pro, monkeypatch):
    _install(pro["root"])
    pro["build_error"] = RuntimeError("cannot open model.bin")
    seen = _whisper(monkeypatch)
    assert _turn("hi", "hi-Latn")["engine"] == "faster-whisper" and seen
    assert _turn("hi", "hi-Latn")["engine"] == "faster-whisper"
    assert pro["builds"] == 1 and pro["ear"].ready() is False and pro["ear"].error()
    assert stt._fallbacks.get("hinglish-pro-to-whisper") == 1


def test_a_failed_decode_hands_on_without_breaking_the_turn(pro, monkeypatch):
    _install(pro["root"])
    pro["decode_error"] = RuntimeError("decode failed")
    seen = _whisper(monkeypatch)
    result = _turn("hi", "hi-Latn")
    assert result["ok"] is True and result["engine"] == "faster-whisper" and seen
    assert pro["ear"].fault().startswith("RuntimeError")


def test_silence_ends_the_ears_try_and_whisper_decides(pro, monkeypatch):
    _install(pro["root"])
    pro["text"] = ""
    seen = _whisper(monkeypatch, text="")
    assert _turn("hi", "hi-Latn")["engine"] == "faster-whisper" and seen
    assert stt._fallbacks.get("hinglish-pro-to-whisper") is None  # a clean empty read is not a fault


def test_a_second_pass_of_the_same_clip_does_not_decode_it_again(pro, monkeypatch):
    _install(pro["root"])
    _whisper(monkeypatch, text="kal milte hain")
    assert _turn("hi", "hi-Latn", extras={"pro_done": True})["engine"] == "faster-whisper"
    assert pro["admits"] == [] and pro["builds"] == 0


def test_the_ear_snaps_to_the_owners_words(pro):
    _install(pro["root"])
    pro["text"] = "fraiday kholo"
    result = _turn("hi", "hi-Latn", extras={"hotwords": ["Friday"]})
    assert result["engine"] == PRO and "Friday" in result["text"]


# ---- the real decode and open, with the runtime faked --------------------------------------------------------------


def test_the_decode_uses_the_language_token_en_the_voice_filter_and_the_no_speech_policy(monkeypatch):
    calls: list[dict] = []

    def consume(model, payload, kwargs, on_partial):
        calls.append(kwargs)
        return {"text": " Aaj mausam accha hai "}

    monkeypatch.setattr(stt, "_consume_whisper", consume)
    assert stt._read_hinglish_pro(Runner(), CLIP, None) == ("Aaj mausam accha hai", "hi")
    options = calls[0]
    assert options["language"] == "en" and options["vad_filter"] is True and options["beam_size"] == 1
    assert options["vad_parameters"] == dict(stt.VAD_PARAMETERS) and options["condition_on_previous_text"] is False


def test_the_build_opens_the_folder_through_the_workers_own_runner(monkeypatch, tmp_path):
    opened: list[tuple[object, dict]] = []
    runner = Runner()

    def open_whisper(cls, wanted, spec):
        opened.append((wanted, spec))
        return runner, spec["device"]

    monkeypatch.setattr(stt, "_import_whisper", lambda: object)
    monkeypatch.setattr(stt, "open_whisper", open_whisper)
    folder = tmp_path / "hinglish-ear-pro"
    assert stt._build_hinglish_pro(stt._Found(folder, (str(folder), 0, 0), {})) is runner
    assert opened[0][0] == str(folder) and opened[0][1]["local_files_only"] is True  # never downloads


def test_a_cuda_load_that_fell_back_to_the_processor_is_counted(monkeypatch, tmp_path):
    monkeypatch.setattr(stt, "_fallbacks", {})
    monkeypatch.setattr(stt, "_import_whisper", lambda: object)
    monkeypatch.setattr(stt, "model_load_kwargs", lambda name, path: {"target": path, "device": "cuda"})
    monkeypatch.setattr(stt, "open_whisper", lambda cls, wanted, spec: (Runner(), "cpu"))
    stt._build_hinglish_pro(stt._Found(tmp_path, (str(tmp_path), 0, 0), {}))
    assert stt._fallbacks.get("cuda-to-cpu") == 1


def test_without_faster_whisper_the_build_says_so(monkeypatch, tmp_path):
    monkeypatch.setattr(stt, "_import_whisper", lambda: None)
    with pytest.raises(RuntimeError):
        stt._build_hinglish_pro(stt._Found(tmp_path, (str(tmp_path), 0, 0), {}))


# ---- residency, eviction, status and the Doctor row ----------------------------------------------------------------


def test_the_ear_is_resident_evictable_and_named_like_the_others(pro):
    _install(pro["root"])
    ear = pro["ear"]
    assert stt.EVICT_ORDER.index("hinglish-pro-ear") > stt.EVICT_ORDER.index("whisper")
    assert stt._own_ear_of("hinglish-pro-ear") is ear and stt._resident_mb("hinglish-pro-ear") == 0.0
    assert stt._own_engine(stt.HINGLISH_PRO_DIR) == PRO
    _turn("hi", "hi-Latn")
    assert stt.HINGLISH_PRO_DIR in stt.loaded_names()
    assert stt._resident_mb("hinglish-pro-ear") == stt.HINGLISH_PRO_LOAD_MB
    assert stt._evict("hinglish-pro-ear") is True and not ear.loaded()
    _turn("hi", "hi-Latn")
    assert stt.unload_models().count(stt.HINGLISH_PRO_DIR) == 1 and not ear.loaded()


def test_the_three_ears_of_the_doctor_are_unchanged_and_pro_has_its_own_status(pro):
    assert [row["id"] for row in stt.own_ears_status()] == ["swift", "quick", "english"]
    assert [ear.name for ear in stt._own_ears()] == ["shruti-ear", "moonshine-ear", "parakeet-ear"]
    row = stt.hinglish_pro_status()
    assert row["catalogId"] == stt.HINGLISH_PRO_DIR and row["engine"] == PRO
    assert (row["ready"], row["loaded"], row["error"]) == (False, False, None)
    _install(pro["root"])
    assert stt.hinglish_pro_status()["ready"] is True
    assert stt.status_payload()["hinglishPro"]["catalogId"] == stt.HINGLISH_PRO_DIR


def test_the_self_test_has_a_row_for_pro_beside_the_three(pro):
    report = stt.run_own_ears_self_test(CLIP)
    assert [row["id"] for row in report["ears"]] == ["swift", "quick", "english"]
    assert report["hinglishPro"]["status"] == "missing" and report["ok"] is True
    _install(pro["root"])
    assert stt.run_own_ears_self_test(CLIP)["hinglishPro"]["status"] == "ok"
    pro["ear"].unload()
    pro["allow"] = False
    assert stt.run_own_ears_self_test(CLIP)["hinglishPro"]["status"] == "refused"
    pro["allow"] = True
    pro["decode_error"] = RuntimeError("boom")
    failed = stt.run_own_ears_self_test(CLIP)
    assert failed["hinglishPro"]["status"] == "failed" and failed["ok"] is False
