"""Estimated word times: pure, monotone, inside the clip, Hindi, English and Hinglish."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tts_timing  # noqa: E402


def _check(times: list[dict], dur: float, offset: float = 0.0) -> None:
    previous = offset
    for item in times:
        assert item["startMs"] >= previous - 0.11 and item["endMs"] >= item["startMs"]
        previous = item["endMs"]
    assert previous == offset + dur


def test_each_language_gets_monotone_times_ending_at_the_clip_end():
    for text in ("Open the calendar, please.", "मैं ठीक हूँ, आप कैसे हैं।", "Kal ka meeting रद्द कर दो."):
        times = tts_timing.estimate_word_times(text, 2400)
        assert [t["word"] for t in times] == text.split()
        _check(times, 2400)


def test_a_longer_word_takes_longer_and_a_comma_leaves_a_gap():
    times = tts_timing.estimate_word_times("a internationalization, ok", 3000)
    assert times[1]["endMs"] - times[1]["startMs"] > times[0]["endMs"] - times[0]["startMs"]
    assert times[2]["startMs"] > times[1]["endMs"]


def test_empty_text_or_no_length_is_no_times():
    assert tts_timing.estimate_word_times("", 1000) == []
    assert tts_timing.estimate_word_times("   ", 1000) == []
    assert tts_timing.estimate_word_times("hello", 0) == []
    assert tts_timing.estimate_word_times("hello", float("nan")) == []


def test_marks_only_share_the_time_evenly():
    times = tts_timing.estimate_word_times("~ ~", 1000)
    assert [t["endMs"] for t in times] == [500.0, 1000.0]


def test_offsets_shift_the_clause_and_the_clip_is_capped():
    shifted = tts_timing.estimate_word_times("one two", 1000, 500)
    _check(shifted, 1000, 500)
    many = tts_timing.clip_word_times([("w " * 300, 0.0, 1000.0), ("w " * 300, 1500.0, 2500.0)])
    assert len(many) == tts_timing.MAX_WORD_TIMES
