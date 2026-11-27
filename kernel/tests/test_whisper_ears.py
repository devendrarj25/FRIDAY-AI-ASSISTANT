"""The Hinglish ear and the Hindi fallback: only in their own mode, only with pinned files on disk, never by default."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import hindi_ear  # noqa: E402
import stt  # noqa: E402
import whisper_ears  # noqa: E402

FILES = whisper_ears.REQUIRED


def _stage(root: Path, ear_id: str, big: bool = True) -> Path:
    folder = root / "models" / ear_id
    folder.mkdir(parents=True)
    for name in FILES:
        (folder / name).write_text("x", encoding="utf-8")
    with (folder / "model.bin").open("wb") as handle:
        handle.truncate(whisper_ears.MIN_BYTES[ear_id] + 1 if big else 10)  # sparse: no real bytes written
    return folder


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.delenv("FRIDAY_STT_WORD_TIMESTAMPS", raising=False)
    whisper_ears.reset_failures()
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    yield
    whisper_ears.reset_failures()


def _row(text: str, language: str = "en"):
    return {
        "text": text,
        "language": language,
        "languageProbability": 0.4,
        "avgLogprob": -0.2,
        "noSpeechProb": 0.01,
        "noSpeechNote": "",
        "policyCode": "",
        "vadMs": 1000,
        "durationMs": 1000,
    }


class Spy:
    """Stands in for get_model and _consume_whisper and records which folder and which options were used."""

    def __init__(self, monkeypatch, text="kal office mein meeting hai", fail_alt=False, fail_decode=False):
        self.loads: list[str] = []
        self.decodes: list[dict] = []
        self.fail_alt = fail_alt
        self.fail_decode = fail_decode
        monkeypatch.setattr(stt, "get_model", self._get_model)
        monkeypatch.setattr(stt, "_consume_whisper", self._consume)
        self.text = text

    def _get_model(self, name, path=None):
        self.loads.append(path or name)
        if self.fail_alt and path and "-ear" in path.replace("\\", "/"):
            raise RuntimeError("cannot open the ear")
        return object()

    def _consume(self, model, payload, kwargs, on_partial):
        self.decodes.append(dict(kwargs))
        if self.fail_decode and len(self.decodes) == 1:
            raise RuntimeError("decode failed")
        return _row(self.text, kwargs.get("language") or "hi")


def _hear(language="hi-IN", pref="hi-IN", extras=None):
    return stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", language, "", None, pref, extras=extras)


# ---- the mode switch ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("pref", ["hi-Latn", "hi_latn", "HI-LATN", "hinglish-roman"])
def test_only_the_explicit_roman_mode_wants_the_hinglish_ear(pref):
    assert whisper_ears.wants_roman_hinglish("", pref) is True
    assert whisper_ears.wants_roman_hinglish(pref, "") is True


@pytest.mark.parametrize("pref", ["", "auto", "mixed", "hi", "hi-IN", "en", "en-IN", "en-US", "hinglish", "ur"])
def test_the_default_modes_never_want_it(pref):
    assert whisper_ears.wants_roman_hinglish(pref, pref) is False
    assert whisper_ears.wants_roman_hinglish("hi-IN", pref) is False


def test_the_roman_mode_is_not_hindi_for_the_devanagari_hindi_ear():
    assert hindi_ear.wants_hindi("hi-IN", "hi-IN") is True
    assert hindi_ear.wants_hindi("hi", "hi") is True
    assert hindi_ear.wants_hindi("hi-IN", "hi-Latn") is False


def test_readiness_needs_every_pinned_file_and_a_whole_model(tmp_path):
    for ear_id in (whisper_ears.HINGLISH_ID, whisper_ears.HINDI_FALLBACK_ID):
        assert whisper_ears.model_dir(ear_id) is None
        folder = _stage(tmp_path, ear_id, big=False)
        assert whisper_ears.model_dir(ear_id) is None  # a partial download is not ready
        with (folder / "model.bin").open("wb") as handle:
            handle.truncate(whisper_ears.MIN_BYTES[ear_id] + 1)
        assert whisper_ears.model_dir(ear_id) == folder
        (folder / "vocabulary.json").unlink()
        assert whisper_ears.model_dir(ear_id) is None


# ---- the Hinglish ear in the worker ------------------------------------------------------------------------


def test_the_default_path_never_uses_the_hinglish_ear_even_when_installed(monkeypatch, tmp_path):
    folder = _stage(tmp_path, whisper_ears.HINGLISH_ID)
    spy = Spy(monkeypatch)
    for language, pref in (("hi-IN", "hi-IN"), ("en-IN", "en-IN"), ("", ""), ("auto", "auto"), ("hi", "")):
        result = _hear(language, pref)
        assert result["engine"] == "faster-whisper", (language, pref)
    assert str(folder) not in spy.loads


def test_the_roman_mode_decodes_with_english_and_reports_the_engine(monkeypatch, tmp_path):
    folder = _stage(tmp_path, whisper_ears.HINGLISH_ID)
    spy = Spy(monkeypatch)
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: pytest.fail("Devanagari ear must not hear"))
    result = _hear("hi-Latn", "hi-Latn")
    assert spy.loads == [str(folder)]
    assert spy.decodes[0]["language"] == "en"  # the fine-tune writes Roman letters only for English-tagged decoding
    assert result["engine"] == "hinglish-ear"
    assert result["text"] == "kal office mein meeting hai"
    assert result["language"] == "hi"
    assert result["languageNote"] == "Hinglish ear: Roman letters"


def test_the_roman_mode_without_the_weights_falls_back_to_what_works_today(monkeypatch):
    spy = Spy(monkeypatch)
    result = _hear("hi-Latn", "hi-Latn")
    assert result["engine"] == "faster-whisper"
    assert spy.decodes[0]["language"] is None  # the generic auto-detect path of today


def test_a_hinglish_ear_that_cannot_open_is_remembered_and_the_generic_model_answers(monkeypatch, tmp_path):
    folder = _stage(tmp_path, whisper_ears.HINGLISH_ID)
    spy = Spy(monkeypatch, fail_alt=True)
    assert _hear("hi-Latn", "hi-Latn")["engine"] == "faster-whisper"
    assert _hear("hi-Latn", "hi-Latn")["engine"] == "faster-whisper"
    assert spy.loads.count(str(folder)) == 1  # not retried for every utterance


def test_a_hinglish_ear_that_cannot_decode_hands_the_utterance_to_the_generic_model(monkeypatch, tmp_path):
    _stage(tmp_path, whisper_ears.HINGLISH_ID)
    spy = Spy(monkeypatch, fail_decode=True)
    result = _hear("hi-Latn", "hi-Latn")
    assert result["engine"] == "faster-whisper"
    assert result["text"]
    assert [d["language"] for d in spy.decodes[:2]] == ["en", None]  # the ear failed, then today's auto-detect ran


# ---- the Hindi fallback ------------------------------------------------------------------------------------


def test_the_hindi_fallback_hears_hindi_only_when_the_hindi_ear_is_missing(monkeypatch, tmp_path):
    folder = _stage(tmp_path, whisper_ears.HINDI_FALLBACK_ID)
    spy = Spy(monkeypatch, text="मुझे चाय चाहिए")
    result = _hear("hi-IN", "hi-IN")
    assert spy.loads == [str(folder)]
    assert spy.decodes[0]["language"] == "hi"
    assert result["engine"] == "hindi-fallback-ear"
    assert result["language"] == "hi"


def test_the_hindi_fallback_stays_idle_when_the_hindi_ear_is_installed(monkeypatch, tmp_path):
    ear = tmp_path / "models" / hindi_ear.MODEL_DIR
    ear.mkdir(parents=True)
    (ear / "vocab.txt").write_text("x", encoding="utf-8")
    (ear / "config.json").write_text("{}", encoding="utf-8")
    with (ear / hindi_ear.MODEL_FILE).open("wb") as handle:
        handle.truncate(hindi_ear.MIN_MODEL_BYTES + 1)
    fallback = _stage(tmp_path, whisper_ears.HINDI_FALLBACK_ID)
    spy = Spy(monkeypatch, text="मुझे चाय चाहिए")
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: None)  # the ear is there but heard nothing
    result = _hear("hi-IN", "hi-IN")
    assert str(fallback) not in spy.loads
    assert result["engine"] == "faster-whisper"


@pytest.mark.parametrize("pref", ["en-IN", "en-US", "auto", ""])
def test_the_hindi_fallback_is_never_used_outside_hindi(monkeypatch, tmp_path, pref):
    fallback = _stage(tmp_path, whisper_ears.HINDI_FALLBACK_ID)
    spy = Spy(monkeypatch)
    assert _hear(pref, pref)["engine"] == "faster-whisper"
    assert str(fallback) not in spy.loads


def test_without_the_fallback_installed_hindi_keeps_the_generic_model(monkeypatch):
    spy = Spy(monkeypatch)
    assert _hear("hi-IN", "hi-IN")["engine"] == "faster-whisper"
    assert spy.decodes[0]["language"] is None


# ---- faster-whisper 1.2.1 options --------------------------------------------------------------------------


def test_hotwords_come_from_the_owners_words_and_are_off_when_empty():
    assert stt.clean_hotwords("") == ""
    assert stt.clean_hotwords(None) == ""
    assert stt.clean_hotwords(" , ;\n ") == ""
    assert stt.clean_hotwords("Friday, Rahul ,friday;  Devendra\nGitHub") == "Friday, Rahul, Devendra, GitHub"
    assert len(stt.clean_hotwords(", ".join(f"name{i}" for i in range(100)))) <= stt.MAX_HOTWORDS_CHARS
    assert "hotwords" not in stt.decode_options({"hotwords": ""}, False)
    assert stt.decode_options({"hotwords": ["Friday", "Rahul"]}, False)["hotwords"] == "Friday, Rahul"


def test_the_silence_threshold_needs_word_timings_and_both_are_off_by_default(monkeypatch):
    assert stt.decode_options({}, False) == {}
    assert stt.decode_options(None, False) == {}
    on = stt.decode_options({"word_timestamps": True}, False)
    assert on == {"word_timestamps": True, "hallucination_silence_threshold": stt.HALLUCINATION_SILENCE_S}
    monkeypatch.setenv("FRIDAY_STT_WORD_TIMESTAMPS", "1")
    assert stt.decode_options({}, False)["word_timestamps"] is True


def test_multilingual_is_a_setting_and_only_applies_when_no_language_is_locked():
    assert "multilingual" not in stt.decode_options({"multilingual": False}, False)
    assert "multilingual" not in stt.decode_options({}, False)
    assert stt.decode_options({"multilingual": True}, False)["multilingual"] is True
    assert "multilingual" not in stt.decode_options({"multilingual": True}, True)


def test_the_options_reach_the_decoder_and_the_old_ones_stay(monkeypatch):
    spy = Spy(monkeypatch)
    _hear("en-IN", "en-IN", {"hotwords": "Friday, Rahul", "multilingual": True})
    first = spy.decodes[0]
    assert first["hotwords"] == "Friday, Rahul"
    assert first["multilingual"] is True
    assert first["beam_size"] == 1 and first["vad_filter"] is True
    assert first["condition_on_previous_text"] is False
    plain = Spy(monkeypatch)
    _hear("en-IN", "en-IN")
    assert "hotwords" not in plain.decodes[0] and "multilingual" not in plain.decodes[0]
    assert "word_timestamps" not in plain.decodes[0]


def test_the_request_handler_forwards_the_options(monkeypatch, tmp_path):
    seen: dict = {}

    def fake(audio, model, language, prompt, on_partial, pref, size, path, keep, extras=None):
        seen.update(extras or {})
        return {"ok": True, "text": "x"}

    monkeypatch.setattr(stt, "transcribe_file", fake)
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    stt.handle_request(
        {"op": "transcribe", "audio": str(wav), "hotwords": "Friday", "multilingual": True, "speech_pref": "hi-Latn"}
    )
    assert seen == {"hotwords": "Friday", "multilingual": True, "word_timestamps": False}


def test_the_status_and_the_voice_check_report_the_ears(monkeypatch, tmp_path):
    import voice_runtime

    payload = stt.status_payload()
    assert payload["hinglishEarReady"] is False and payload["hindiFallbackReady"] is False
    assert voice_runtime._whisper_ear_lines() == [
        "OPTIONAL hinglish-ear optional - not installed",
        "OPTIONAL hindi-fallback-ear optional - not installed",
    ]
    _stage(tmp_path, whisper_ears.HINGLISH_ID)
    _stage(tmp_path, whisper_ears.HINDI_FALLBACK_ID)
    assert stt.status_payload()["hinglishEarReady"] is True
    monkeypatch.setattr("importlib.util.find_spec", lambda name: object())
    assert voice_runtime._whisper_ear_lines() == [
        "PASS hinglish-ear pinned weights present",
        "PASS hindi-fallback-ear pinned weights present",
    ]
    monkeypatch.setattr("importlib.util.find_spec", lambda name: None)
    assert all(line.startswith("FAIL") for line in voice_runtime._whisper_ear_lines())


def test_the_owners_words_reach_the_whisper_stream_ear_and_the_turn_language_is_decided_once():
    from types import SimpleNamespace

    from la2_partials import TurnLanguage

    calls: list[dict] = []

    class Model:
        def transcribe(self, window, **kwargs):
            calls.append(kwargs)
            word = SimpleNamespace(word=" Devendra", start=0.0, end=0.4)
            seg = SimpleNamespace(text="Devendra", no_speech_prob=0.01, avg_logprob=-0.2, words=[word])
            return iter([seg]), SimpleNamespace(language="hi")

    turn = TurnLanguage("hi-en")
    reader = stt.WhisperStreamReader(turn, ["Devendra", "FRIDAY"], model_ref=Model)
    assert [w.text for w in reader([0.0] * 16000, "")] == ["Devendra"]
    assert [w.text for w in reader([0.0] * 16000, "aaj ka plan")] == ["Devendra"]
    assert calls[0]["language"] is None and calls[1]["language"] == "hi"  # detected once, then locked
    assert all(c["hotwords"] == "Devendra, FRIDAY" and c["word_timestamps"] is True for c in calls)
    assert calls[1]["initial_prompt"] == "aaj ka plan"  # the text that left the window
    assert stt.WhisperStreamReader(turn, [], model_ref=lambda: None)([0.0] * 16000, "") == []


# ---- the Trelis mixed-script ear ---------------------------------------------------------------------------------

MARKER = whisper_ears.TRELIS_MARKER_ID
ASK = {"hinglish_ear": "trelis"}


def _stage_trelis(root: Path, monkeypatch, marker: bool = True) -> Path:
    """The int8 folder with small stand-in files; the pinned size table is pointed at their real sizes."""
    folder = root / "models" / whisper_ears.TRELIS_ID / whisper_ears.TRELIS_SUBDIR
    folder.mkdir(parents=True)
    words = [f"w{i}" for i in range(MARKER)] + ["<|mixedcode|>" if marker else "<|other|>"]
    sizes: dict[str, int] = {}
    for name in whisper_ears.TRELIS_FILES:
        body = json.dumps(words) if name == "vocabulary.json" else f"{name} stand-in"
        (folder / name).write_text(body, encoding="utf-8")
        sizes[name] = (folder / name).stat().st_size
    monkeypatch.setattr(whisper_ears, "TRELIS_FILES", sizes)
    return folder


class TrelisSpy(Spy):
    """A Spy that also takes the precision the Trelis ear asks for, and records the model each decode got."""

    def __init__(self, *args, own_tokenizer=True, **kwargs):
        super().__init__(*args, **kwargs)
        self.own_tokenizer = own_tokenizer
        self.computes: list = []
        self.models: list = []

    def _get_model(self, name, path=None, auto=False, compute_type=None):
        self.computes.append(compute_type)
        model = super()._get_model(name, path)
        return SimpleNamespace(hf_tokenizer=object()) if self.own_tokenizer else model

    def _consume(self, model, payload, kwargs, on_partial):
        self.models.append(model)
        return super()._consume(model, payload, kwargs, on_partial)


@pytest.fixture
def gpu(monkeypatch):
    monkeypatch.setattr(stt, "cuda_runtime_ready", lambda: True)
    monkeypatch.setattr(whisper_ears, "gpu_vram_gb", lambda: 8.0)
    monkeypatch.delenv("FRIDAY_HINGLISH_EAR_FORCE", raising=False)


def test_the_trelis_table_matches_the_pinned_files():
    pins = (Path(__file__).resolve().parents[2] / "electron" / "voice-pins.cjs").read_text(encoding="utf-8")
    block = pins.split('"nikh360pro/capsbro-hinglish-ct2": {', 1)[1].split("\n  },", 1)[0]
    found = {
        name.removeprefix("int8/"): int(size)
        for name, size in re.findall(r'"([^"]+)": \{\s*sha256: "[0-9a-f]{64}",\s*bytes: (\d+)', block)
        if name.startswith("int8/")
    }
    assert found == whisper_ears.TRELIS_FILES


@pytest.mark.parametrize("option", ["trelis", "TRELIS", "hinglish-ear-trelis", " Hinglish_Ear_Trelis "])
def test_only_the_named_option_wants_the_trelis_ear(option):
    assert whisper_ears.wants_trelis({"hinglish_ear": option}) is True


@pytest.mark.parametrize("extras", [None, {}, {"hinglish_ear": ""}, {"hinglish_ear": "on"}, {"hinglish_ear": True}])
def test_nothing_else_wants_it(extras):
    assert whisper_ears.wants_trelis(extras) is False
    assert whisper_ears.trelis_verdict(extras, True, 24.0) == (None, "")


def test_the_folder_needs_the_pinned_files_at_the_pinned_sizes_and_the_marker(monkeypatch, tmp_path):
    assert whisper_ears.trelis_dir() is None and whisper_ears.trelis_ready() is False
    folder = _stage_trelis(tmp_path, monkeypatch)
    assert whisper_ears.trelis_dir() == folder and whisper_ears.trelis_ready() is True
    (folder / "model.bin").write_text("part", encoding="utf-8")
    assert whisper_ears.trelis_dir() is None  # a size that is not the pinned one is not the model
    folder = _stage_trelis(tmp_path / "other", monkeypatch)
    (folder / "tokenizer.json").unlink()
    assert whisper_ears.trelis_dir() is None


def test_a_vocabulary_without_the_marker_is_not_the_ear(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path / "plain"))
    _stage_trelis(tmp_path / "plain", monkeypatch, marker=False)
    assert whisper_ears.trelis_dir() is None


def test_the_marker_is_the_literal_id_after_the_language_and_before_the_task():
    assert whisper_ears.TRELIS_MARKER_ID == 51866 and whisper_ears.TRELIS_MARKER_TOKEN == "<|mixedcode|>"
    assert whisper_ears.TRELIS_DECODE == "hi"


def test_the_default_path_never_uses_the_trelis_ear_even_when_installed_and_the_gpu_is_fine(monkeypatch, tmp_path, gpu):
    folder = _stage_trelis(tmp_path, monkeypatch)
    spy = TrelisSpy(monkeypatch)
    for language, pref in (("hi-IN", "hi-IN"), ("en-IN", "en-IN"), ("", ""), ("auto", "auto"), ("hi-Latn", "hi-Latn")):
        assert _hear(language, pref)["engine"] == "faster-whisper", (language, pref)
    assert str(folder) not in spy.loads
    assert _hear("hi-IN", "hi-IN", {"hotwords": "Friday"})["engine"] == "faster-whisper"
    assert whisper_ears.choose("hi-IN", "hi-IN", False, True) is None


def test_the_named_ear_decodes_with_hindi_reports_the_engine_and_the_marker(monkeypatch, tmp_path, gpu):
    folder = _stage_trelis(tmp_path, monkeypatch)
    spy = TrelisSpy(monkeypatch, text="kal मेरी meeting है")
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: pytest.fail("the Hindi ear must not hear first"))
    result = _hear("hi-IN", "hi-IN", {**ASK, "hotwords": "Friday"})
    assert spy.loads == [str(folder)]
    assert spy.computes == ["int8_float16"]
    assert isinstance(spy.models[0], whisper_ears.MarkerDecoder)
    assert spy.decodes[0]["language"] == "hi" and spy.decodes[0]["beam_size"] == 1
    assert spy.decodes[0]["condition_on_previous_text"] is False and spy.decodes[0]["vad_filter"] is True
    assert "initial_prompt" not in spy.decodes[0]
    assert result["engine"] == "hinglish-ear-trelis"
    assert result["marker"] is True and result["script"] == "mixed"
    assert result["language"] == "hi" and result["text"] == "kal मेरी meeting है"
    assert "hinglishEarSkipped" not in result


@pytest.mark.parametrize(
    ("vram", "gpu_on", "why"), [(2.0, True, "vram-too-small"), (None, True, "vram-unknown"), (8.0, False, "no-gpu")]
)
def test_the_hardware_gate_keeps_a_small_or_missing_gpu_on_the_engine_of_today(
    monkeypatch, tmp_path, vram, gpu_on, why
):
    folder = _stage_trelis(tmp_path, monkeypatch)
    monkeypatch.setattr(stt, "cuda_runtime_ready", lambda: gpu_on)
    monkeypatch.setattr(whisper_ears, "gpu_vram_gb", lambda: vram)
    monkeypatch.delenv("FRIDAY_HINGLISH_EAR_FORCE", raising=False)
    spy = TrelisSpy(monkeypatch)
    result = _hear("hi-IN", "hi-IN", ASK)
    assert result["engine"] == "faster-whisper" and result["hinglishEarSkipped"] == why
    assert str(folder) not in spy.loads and "marker" not in result


def test_the_vram_limit_is_four_gb(monkeypatch, tmp_path):
    _stage_trelis(tmp_path, monkeypatch)
    assert whisper_ears.trelis_verdict(ASK, True, 4.0)[0] is not None
    assert whisper_ears.trelis_verdict(ASK, True, 3.9) == (None, "vram-too-small")
    assert whisper_ears.trelis_verdict(ASK, lambda: False, 24.0) == (None, "no-gpu")


@pytest.mark.parametrize("how", ["option", "env"])
def test_an_explicit_force_runs_it_without_a_gpu(monkeypatch, tmp_path, how):
    folder = _stage_trelis(tmp_path, monkeypatch)
    monkeypatch.setattr(stt, "cuda_runtime_ready", lambda: False)
    monkeypatch.setattr(whisper_ears, "gpu_vram_gb", lambda: pytest.fail("a forced ear does not ask the card"))
    monkeypatch.delenv("FRIDAY_HINGLISH_EAR_FORCE", raising=False)
    extras: dict = dict(ASK)
    if how == "option":
        extras["hinglish_ear_force"] = True
    else:
        monkeypatch.setenv("FRIDAY_HINGLISH_EAR_FORCE", "1")
    spy = TrelisSpy(monkeypatch)
    assert _hear("hi-IN", "hi-IN", extras)["engine"] == "hinglish-ear-trelis"
    assert spy.loads == [str(folder)]


def test_a_named_ear_that_is_not_installed_falls_back_and_says_why(monkeypatch, gpu):
    spy = TrelisSpy(monkeypatch)
    result = _hear("hi-IN", "hi-IN", ASK)
    assert result["engine"] == "faster-whisper" and result["hinglishEarSkipped"] == "not-installed"
    assert spy.decodes[0]["language"] is None  # today's generic path


def test_an_ear_that_cannot_open_is_remembered_and_the_roman_ear_or_generic_model_answers(monkeypatch, tmp_path, gpu):
    folder = _stage_trelis(tmp_path, monkeypatch)
    roman = _stage(tmp_path, whisper_ears.HINGLISH_ID)
    spy = TrelisSpy(monkeypatch)
    original = spy._get_model

    def refuse(name, path=None, auto=False, compute_type=None):
        if path == str(folder):
            spy.loads.append(str(path))
            raise RuntimeError("cannot open")
        return original(name, path, auto, compute_type)

    monkeypatch.setattr(stt, "get_model", refuse)
    assert _hear("hi-Latn", "hi-Latn", ASK)["engine"] == "hinglish-ear"  # the existing Hinglish path answers
    assert _hear("hi-IN", "hi-IN", ASK)["engine"] == "faster-whisper"
    assert spy.loads.count(str(folder)) == 1  # not retried for every utterance
    assert str(roman) in spy.loads


def test_an_ear_that_cannot_decode_hands_the_utterance_to_the_engine_of_today(monkeypatch, tmp_path, gpu):
    _stage_trelis(tmp_path, monkeypatch)
    spy = TrelisSpy(monkeypatch, fail_decode=True)
    result = _hear("hi-IN", "hi-IN", ASK)
    assert result["engine"] == "faster-whisper" and result["text"] and "marker" not in result
    assert [d["language"] for d in spy.decodes[:2]] == ["hi", None]
    assert _hear("hi-IN", "hi-IN", ASK)["engine"] == "faster-whisper"  # remembered as failed


def test_a_model_that_cannot_carry_the_prompt_never_hears(monkeypatch, tmp_path, gpu):
    _stage_trelis(tmp_path, monkeypatch)
    spy = TrelisSpy(monkeypatch, own_tokenizer=False)  # its model is a bare object: no tokenizer of its own
    assert _hear("hi-IN", "hi-IN", ASK)["engine"] == "faster-whisper"
    assert spy.decodes[0]["language"] is None


def test_roman_hindi_from_the_ear_breaks_the_script_policy_and_today_reads_again(monkeypatch, tmp_path, gpu):
    _stage_trelis(tmp_path, monkeypatch)
    spy = TrelisSpy(monkeypatch, text="mujhe kal ka kaam nahi hai")
    result = _hear("hi-IN", "hi-IN", ASK)
    assert result["engine"] == "faster-whisper" and "marker" not in result
    assert [d["language"] for d in spy.decodes[:2]] == ["hi", None]
    assert whisper_ears.script_violation("mujhe kal ka kaam nahi hai") is True
    assert whisper_ears.script_violation("kal मेरी meeting है") is False
    assert whisper_ears.script_violation("schedule the meeting for tomorrow") is False
    assert whisper_ears.script_violation("mujhe kal ka kaam nahi hai", "hi-Latn") is False  # Roman mode asked for it


def test_the_request_handler_forwards_the_trelis_option_only_when_it_is_set(monkeypatch, tmp_path):
    seen: list[dict] = []

    def fake(audio, model, language, prompt, on_partial, pref, size, path, keep, extras=None):
        seen.append(dict(extras or {}))
        return {"ok": True, "text": "x"}

    monkeypatch.setattr(stt, "transcribe_file", fake)
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    stt.handle_request({"op": "transcribe", "audio": str(wav), "hinglishEar": "trelis", "hinglishEarForce": True})
    stt.handle_request({"op": "transcribe", "audio": str(wav)})
    assert seen[0]["hinglish_ear"] == "trelis" and seen[0]["hinglish_ear_force"] is True
    assert "hinglish_ear" not in seen[1] and "hinglish_ear_force" not in seen[1]
    assert whisper_ears.request_options({"hinglishEar": 5, "hinglishEarForce": "yes"}) == {}


def test_the_status_reports_the_trelis_ear_and_a_live_pass_never_decodes_with_it(monkeypatch, tmp_path):
    assert stt.status_payload()["hinglishEarTrelisReady"] is False
    folder = _stage_trelis(tmp_path, monkeypatch)
    assert stt.status_payload()["hinglishEarTrelisReady"] is True
    assert whisper_ears.is_trelis_path(str(folder)) is True
    assert whisper_ears.is_trelis_path(str(tmp_path / "models" / whisper_ears.HINGLISH_ID)) is False
    assert whisper_ears.is_trelis_path(None) is False


# ---- the decoder prompt, with the real library's tokenizer class --------------------------------------------------

IDS = {
    "<|startoftranscript|>": 50258,
    "<|hi|>": 50276,
    "<|en|>": 50259,
    "<|transcribe|>": 50360,
    "<|notimestamps|>": 50364,
}


class FakeHF:
    """Stands in for the tokenizers object: it knows the library's tokens and, like the real file, not the marker."""

    def token_to_id(self, token):
        return IDS.get(token)


class FakeWhisper:
    """Builds its tokenizer the way faster-whisper does (the module's own name, at call time) and keeps the prompt."""

    def __init__(self):
        self.hf_tokenizer = FakeHF()
        self.prompts: list[list[int]] = []
        self.kwargs: list[dict] = []
        self.fail = False

    def transcribe(self, audio, **kwargs):
        import faster_whisper.transcribe as ft
        from faster_whisper.transcribe import WhisperModel

        self.kwargs.append(kwargs)
        tokenizer = ft.Tokenizer(cast(Any, self.hf_tokenizer), True, task="transcribe", language=kwargs["language"])
        if self.fail:
            raise RuntimeError("decode failed")

        def lazy():  # the library reads the sequence when the segments are consumed, after transcribe returned
            self.prompts.append(
                WhisperModel.get_prompt(
                    cast(Any, SimpleNamespace(max_length=448)),
                    tokenizer,
                    [],
                    without_timestamps=kwargs["without_timestamps"],
                )
            )
            yield "segment"

        return lazy(), SimpleNamespace(language=kwargs["language"])


def _plain_prompt(language="hi"):
    from faster_whisper.transcribe import Tokenizer, WhisperModel

    tokenizer = Tokenizer(cast(Any, FakeHF()), True, task="transcribe", language=language)
    return WhisperModel.get_prompt(cast(Any, SimpleNamespace(max_length=448)), tokenizer, [], without_timestamps=True)


def test_the_prompt_is_exactly_sot_language_marker_task_notimestamps():
    pytest.importorskip("faster_whisper")
    model = FakeWhisper()
    segments, info = whisper_ears.MarkerDecoder(model).transcribe("a.wav", language="hi", beam_size=1)
    assert list(segments) == ["segment"] and info.language == "hi"
    assert model.prompts == [[50258, 50276, 51866, 50360, 50364]]
    assert FakeHF().token_to_id("<|mixedcode|>") is None  # the marker could not have been encoded from text


def test_the_library_is_restored_and_no_other_model_sees_the_marker():
    pytest.importorskip("faster_whisper")
    import faster_whisper.transcribe as ft

    before = ft.Tokenizer
    model = FakeWhisper()
    list(whisper_ears.MarkerDecoder(model).transcribe("a.wav", language="hi")[0])
    assert ft.Tokenizer is before
    assert _plain_prompt() == [50258, 50276, 50360, 50364]  # a plain model still decodes without the marker
    other = FakeWhisper()
    list(other.transcribe("a.wav", language="hi", without_timestamps=True)[0])
    assert other.prompts == [[50258, 50276, 50360, 50364]]


def test_the_library_is_restored_after_a_failed_decode():
    pytest.importorskip("faster_whisper")
    import faster_whisper.transcribe as ft

    before = ft.Tokenizer
    model = FakeWhisper()
    model.fail = True
    with pytest.raises(RuntimeError):
        whisper_ears.MarkerDecoder(model).transcribe("a.wav", language="hi")
    assert ft.Tokenizer is before and whisper_ears._active_hf is None


def test_a_tokenizer_built_for_another_model_while_the_swap_is_on_stays_plain():
    pytest.importorskip("faster_whisper")
    import faster_whisper.transcribe as ft

    stranger = FakeWhisper()
    ear = FakeWhisper()
    original = ear.transcribe

    def with_a_stranger(audio, **kwargs):
        list(stranger.transcribe(audio, **{**kwargs, "without_timestamps": True})[0])  # built inside the swap window
        return original(audio, **kwargs)

    ear.transcribe = with_a_stranger  # type: ignore[method-assign]
    list(whisper_ears.MarkerDecoder(ear).transcribe("a.wav", language="hi")[0])
    assert stranger.prompts == [[50258, 50276, 50360, 50364]]
    assert ear.prompts == [[50258, 50276, 51866, 50360, 50364]]
    assert ft.Tokenizer.__name__ == "Tokenizer"


def test_the_decoder_forces_timestamps_off_the_language_and_drops_prompt_text():
    pytest.importorskip("faster_whisper")
    model = FakeWhisper()
    decoder = whisper_ears.MarkerDecoder(model)
    list(
        decoder.transcribe(
            "a.wav",
            language=None,
            initial_prompt="friday",
            hotwords="Rahul",
            multilingual=True,
            beam_size=1,
            condition_on_previous_text=False,
        )[0]
    )
    sent = model.kwargs[0]
    assert sent["language"] == "hi" and sent["without_timestamps"] is True
    assert "initial_prompt" not in sent and "hotwords" not in sent and "multilingual" not in sent
    assert sent["beam_size"] == 1 and sent["condition_on_previous_text"] is False
    list(decoder.transcribe("a.wav", language="en")[0])
    assert model.kwargs[1]["language"] == "en" and model.prompts[1][:3] == [50258, 50259, 51866]


def test_a_non_multilingual_tokenizer_is_refused_rather_than_decoded_without_the_marker():
    pytest.importorskip("faster_whisper")
    from faster_whisper.tokenizer import Tokenizer

    whisper_ears.MarkerDecoder(FakeWhisper())  # builds the class
    cls = whisper_ears._marker_tokenizer_class()
    hf = FakeHF()
    whisper_ears._active_hf = hf
    try:
        tokenizer = cls(cast(Any, hf), False)
    finally:
        whisper_ears._active_hf = None
    assert isinstance(tokenizer, Tokenizer)
    with pytest.raises(RuntimeError):
        _ = tokenizer.sot_sequence


def test_a_model_without_its_own_tokenizer_is_refused():
    with pytest.raises(RuntimeError):
        whisper_ears.MarkerDecoder(object())
    assert whisper_ears.decoder_for("generic", {"id": whisper_ears.HINGLISH_ID}) == "generic"
    assert whisper_ears.decoder_for("generic", None) == "generic"


# ---- the real model (optional) ------------------------------------------------------------------------------------


@pytest.mark.skipif(
    not os.environ.get("FRIDAY_TRELIS_DIR"), reason="set FRIDAY_TRELIS_DIR to the int8 folder to run the real model"
)
def test_the_real_model_hears_with_the_marker_prompt():
    faster_whisper = pytest.importorskip("faster_whisper")
    import numpy as np

    folder = Path(os.environ["FRIDAY_TRELIS_DIR"])
    assert (folder / "model.bin").is_file()
    model = faster_whisper.WhisperModel(str(folder), device="cpu", compute_type="int8")
    decoder = whisper_ears.MarkerDecoder(model)
    wav = os.environ.get("FRIDAY_TRELIS_WAV")
    audio = faster_whisper.decode_audio(wav) if wav else (np.sin(np.arange(16000) / 20.0) * 0.1).astype("float32")
    segments, info = decoder.transcribe(
        audio, language="hi", beam_size=1, condition_on_previous_text=False, vad_filter=bool(wav)
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    assert info.language == "hi"
    if wav:
        assert text and not whisper_ears.script_violation(text)
