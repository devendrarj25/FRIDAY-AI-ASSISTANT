"""A weak language guess on a short Hinglish phrase is read a second time in Hindi, and the surer reading wins."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import stt  # noqa: E402


def _pass(text: str, language: str, probability: float | None, logprob: float | None) -> dict:
    return {
        "text": text,
        "language": language,
        "languageProbability": probability,
        "avgLogprob": logprob,
        "noSpeechProb": 0.01,
        "noSpeechNote": "",
        "policyCode": "",
        "vadMs": 1800,
        "durationMs": 2000,
    }


def test_a_weak_guess_is_looked_at_again_a_sure_one_or_a_locked_language_is_not():
    weak = _pass("I'm going to get a car.", "en", 0.65, -0.9)
    assert stt.should_recheck_language(weak, language_locked=False) is True
    assert stt.should_recheck_language(weak, language_locked=True) is False
    assert stt.should_recheck_language(_pass("Friday what time is it", "en", 0.97, -0.2), False) is False
    assert stt.should_recheck_language(_pass("", "en", 0.4, None), False) is False
    assert stt.should_recheck_language(_pass("bonjour", "fr", 0.5, -0.5), False) is False
    assert stt.should_recheck_language(_pass("hello", "en", None, -0.5), False) is False
    long_clip = {**weak, "durationMs": 40_000}
    assert stt.should_recheck_language(long_clip, False) is False


def test_the_surer_reading_wins_by_a_clear_margin_and_says_why():
    first = _pass("I'm going to get a car.", "en", 0.65, -1.1)
    second = _pass("chrome kholo aur mail dikhao", "hi", 0.99, -0.35)
    chosen, note = stt.choose_language_pass(first, second)
    assert chosen["text"] == "chrome kholo aur mail dikhao"
    assert "switched from en to hi" in note
    assert chosen["languageNote"] == note


def test_the_first_reading_stays_when_the_second_is_not_clearly_better():
    first = _pass("open chrome", "en", 0.7, -0.3)
    close = _pass("open chrome", "hi", 0.9, -0.27)
    kept, note = stt.choose_language_pass(first, close)
    assert kept is first
    assert "kept the first reading" in note
    for second in (_pass("", "hi", 0.9, -0.1), _pass("kuch", "hi", 0.9, None)):
        assert stt.choose_language_pass(first, second)[0] is first


@pytest.mark.parametrize("language", ["en-IN", "hi-IN", "auto"])
def test_the_pipeline_rereads_a_weak_guess_and_reports_the_language_it_used(monkeypatch, language):
    calls: list[str | None] = []

    class FakeModel:
        pass

    def fake_consume(model, payload, kwargs, on_partial):
        calls.append(kwargs.get("language"))
        if kwargs.get("language") == "hi":
            return _pass("chrome kholo", "hi", 0.99, -0.3)
        return _pass("I'm going to get a car.", "en", 0.62, -1.2)

    monkeypatch.setattr(stt, "get_model", lambda *a, **k: FakeModel())
    monkeypatch.setattr(stt, "_consume_whisper", fake_consume)
    result = stt._transcribe_prepared("x.wav", None, "base", language, "", None, language)
    assert result["text"] == "chrome kholo"
    assert result["language"] == "hi"
    assert "switched from en to hi" in result["languageNote"]
    assert calls[0] is None
    assert "hi" in calls
