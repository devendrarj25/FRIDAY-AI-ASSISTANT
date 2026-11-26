"""One language per turn, one forced language per segment: Hindi in Devanagari, English in Latin, never re-detected."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import stt  # noqa: E402
from la2_partials import (  # noqa: E402
    RescorePlan,
    TurnLanguage,
    apply_rescore,
    plan_rescore,
    script_of,
    segment_language,
    segments_from_words,
    turn_mode,
)
from stream_commit import Word  # noqa: E402


@pytest.mark.parametrize(
    ("locale", "mode"),
    [("hi", "hi"), ("hi-IN", "hi"), ("en", "en"), ("en_US", "en"), ("hi-en", "hi-en"), ("Hinglish", "hi-en"),
     ("hi-Latn", "hi-en"), ("", ""), ("auto", ""), ("fr-FR", "fr")],
)  # fmt: skip
def test_the_turn_mode_of_a_locale(locale, mode):
    assert turn_mode(locale) == mode


def test_hindi_and_english_are_locked_from_the_start_and_never_change():
    for locale, want in (("hi-IN", "hi"), ("en-US", "en")):
        turn = TurnLanguage(locale)
        assert turn.decode_language() == want
        assert turn.observe("en" if want == "hi" else "hi") == want
        assert turn.decode_language() == want


def test_an_open_turn_decides_once_on_the_first_reading_and_keeps_it():
    turn = TurnLanguage("")
    assert turn.decode_language() is None  # the first reading may detect
    assert turn.observe("ur") == "hi"  # an Indic guess is Hindi
    for later in ("en", "fr", "ja", ""):
        assert turn.observe(later) == "hi"  # never re-detected mid-turn
    english = TurnLanguage("auto")
    assert english.observe("en") == "en" and english.observe("hi") == "en"


def test_a_hinglish_turn_locks_only_hindi_or_english():
    assert TurnLanguage("hi-en").observe("fr") == "en"
    assert TurnLanguage("hi-en").observe("hi") == "hi"
    assert TurnLanguage("hi-en").observe("") is None


def test_segment_language_follows_the_script_policy():
    assert segment_language("आज मौसम कैसा है") == "hi"
    assert segment_language("mujhe chai chahiye abhi") == "hi"  # Roman Hindi is Hindi (read into Devanagari)
    assert segment_language("open the calendar") == "en"
    assert segment_language("open the calendar", "hi") == "en"  # English words stay Latin in the Hindi mode
    assert segment_language("आज मौसम", "en") == "en"  # the English mode reads everything as English
    assert segment_language("मीटिंग schedule करो") == "hi"  # mixed: the larger script decides
    assert segment_language("123 ...") is None
    assert script_of("नमस्ते") == "deva" and script_of("hello") == "latin" and script_of("नमस्ते hi") == "mixed"


def _rows():
    return [
        {"text": "मुझे एक", "start": 0.0, "end": 0.8},
        {"text": "meeting schedule for tomorrow", "start": 0.8, "end": 2.0},
        {"text": "karna hai abhi", "start": 2.0, "end": 3.0},
    ]


def test_only_segments_whose_language_differs_from_the_reading_are_planned():
    plans = plan_rescore(_rows(), "hi", "hi-en")
    assert [(p.index, p.language) for p in plans] == [(1, "en")]
    plans = plan_rescore(_rows(), "en", "hi-en")
    assert [(p.index, p.language) for p in plans] == [(0, "hi"), (2, "hi")]
    assert plans[0].start == 0.0 and plans[1].start == pytest.approx(1.9)  # padded, never below zero
    assert plan_rescore(_rows(), None, "") == []  # an unknown reading language is left alone
    assert plan_rescore(_rows(), "en", "en") == []  # English mode: everything is English already


def test_the_plan_is_capped_by_count_and_by_audio():
    rows = [{"text": "mujhe chai chahiye", "start": i * 1.0, "end": i * 1.0 + 0.9} for i in range(10)]
    assert len(plan_rescore(rows, "en", "")) == 4
    long_rows = [{"text": "mujhe chai chahiye", "start": i * 10.0, "end": i * 10.0 + 9.0} for i in range(3)]
    assert len(plan_rescore(long_rows, "en", "")) == 1  # 15 s of second looks at most


def test_a_rescore_keeps_the_new_text_only_in_the_right_script_and_length():
    rows = _rows()
    plans = [RescorePlan(0, "hi", 0.0, 0.9), RescorePlan(1, "en", 0.7, 2.1), RescorePlan(2, "hi", 1.9, 3.1)]
    answers = {
        0: {"text": "mujhe ek"},  # Latin for a Hindi segment: refused
        1: {"text": "meeting schedule for tomorrow"},  # same text: not a change
        2: {"text": "करना है अभी"},  # Devanagari for Hindi: kept
    }
    out, changed = apply_rescore(rows, plans, lambda plan: answers[plan.index])
    assert changed == 1
    assert [r["text"] for r in out] == ["मुझे एक", "meeting schedule for tomorrow", "करना है अभी"]
    assert out[2]["language"] == "hi" and out[2]["rescored"] is True
    long_answer = {"text": "करना है अभी " * 5}
    out, changed = apply_rescore(rows, [plans[2]], lambda plan: long_answer)
    assert changed == 0  # a much longer reading is a hallucination, not a better script

    def boom(plan):
        raise RuntimeError("decoder died")

    assert apply_rescore(rows, plans, boom) == (rows, 0)


def test_timed_words_become_segments_by_language():
    words = [Word("मुझे", 0.0, 0.3), Word("एक", 0.3, 0.5), Word("meeting", 0.5, 0.9), Word("schedule", 0.9, 1.3),
             Word("karo", 1.3, 1.6), Word("please", 1.6, 1.9), Word("now", 1.9, 2.1)]  # fmt: skip
    rows = segments_from_words(words, "hi-en")
    assert [r["language"] for r in rows] == ["hi", "en"]
    assert rows[0]["text"] == "मुझे एक" and rows[1]["start"] == 0.5 and rows[1]["end"] == 2.1
    assert segments_from_words([Word("untimed")]) == []


def _reading(text, language, segments):
    return {
        "text": text,
        "language": language,
        "languageProbability": 0.95,
        "avgLogprob": -0.2,
        "noSpeechProb": 0.01,
        "noSpeechNote": "",
        "policyCode": "",
        "vadMs": 3000,
        "durationMs": 3000,
        "segments": segments,
    }


def test_the_final_decode_reads_a_roman_hindi_segment_again_in_hindi(monkeypatch):
    calls: list[tuple[object, int]] = []
    segments = [
        {"text": "open the calendar", "start": 0.0, "end": 1.0},
        {"text": "aur mujhe meeting dikhao", "start": 1.0, "end": 2.5},
    ]

    def fake_consume(model, payload, kwargs, on_partial):
        calls.append((kwargs.get("language"), len(payload)))
        if kwargs.get("language") == "hi":
            return _reading("और मुझे मीटिंग दिखाओ", "hi", [{"text": "और मुझे मीटिंग दिखाओ", "start": 0.0, "end": 1.5}])
        return _reading("open the calendar aur mujhe meeting dikhao", "en", segments)

    monkeypatch.setattr(stt.hindi_ear, "tries_ear", lambda *a: False)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: object())
    monkeypatch.setattr(stt, "_consume_whisper", fake_consume)
    result = stt._transcribe_prepared("x.wav", [0.01] * 48000, "base", "hi-en", "", None, "hi-en")
    assert result["text"] == "open the calendar और मुझे मीटिंग दिखाओ"
    assert calls[1] == ("hi", int(2.6 * 16000) - int(0.9 * 16000))  # one forced look, only that segment
    assert len(calls) == 2
    assert "again in their own language" in result["languageNote"]


def test_the_final_decode_leaves_a_one_language_reading_alone(monkeypatch):
    calls: list[object] = []

    def fake_consume(model, payload, kwargs, on_partial):
        calls.append(kwargs.get("language"))
        return _reading("open the calendar", "en", [{"text": "open the calendar", "start": 0.0, "end": 1.0}])

    monkeypatch.setattr(stt.hindi_ear, "tries_ear", lambda *a: False)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: object())
    monkeypatch.setattr(stt, "_consume_whisper", fake_consume)
    result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "en", "", None, "en")
    assert result["text"] == "open the calendar" and calls == [None]


def test_no_samples_or_a_policy_drop_means_no_second_look():
    first = _reading("aur mujhe meeting dikhao", "en", [{"text": "aur mujhe meeting dikhao", "start": 0, "end": 1}])
    never = lambda clip, lang: pytest.fail("no second look")  # noqa: E731
    assert stt.rescore_segments(first, None, "", "", never) == (first, "")
    dropped = {**first, "text": ""}
    assert stt.rescore_segments(dropped, [0.0] * 16000, "", "", never) == (dropped, "")
