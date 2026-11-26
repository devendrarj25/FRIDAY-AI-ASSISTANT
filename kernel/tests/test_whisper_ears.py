"""The Hinglish ear and the Hindi fallback: only in their own mode, only with pinned files on disk, never by default."""

from __future__ import annotations

import sys
from pathlib import Path

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
