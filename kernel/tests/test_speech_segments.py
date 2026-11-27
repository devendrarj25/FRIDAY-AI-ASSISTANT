"""FRIDAY's own speech segmenter: the upstream algorithm's segments on injected probabilities, the cut at the best
silence, lossless collect and time map, and the long-form plan that uses it. No model file is needed."""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import speech_segments as seg  # noqa: E402
import stt  # noqa: E402
import vad_onnx  # noqa: E402

RATE = seg.RATE
FRAME = seg.FRAME


def row(*parts: tuple[float, int]) -> list[float]:
    out: list[float] = []
    for value, count in parts:
        out += [value] * count
    return out


# (name, probabilities, total samples, options, the segments the upstream algorithm gives for them)
FIXTURES: list[tuple[str, list[float], int, dict[str, Any], list[tuple[int, int]]]] = [
    (
        "plain",
        row((0.02, 10), (0.9, 30), (0.02, 40), (0.8, 25), (0.02, 20)),
        63_983,
        dict(threshold=0.5, min_speech_ms=250, min_silence_ms=100, speech_pad_ms=30),
        [(4640, 20960), (40480, 54240)],
    ),
    (
        "hysteresis",
        row((0.02, 5), (0.8, 10), (0.4, 6), (0.8, 10), (0.3, 3), (0.9, 8), (0.1, 30), (0.7, 5), (0.1, 10)),
        44_527,
        dict(threshold=0.5, neg_threshold=0.35, min_speech_ms=100, min_silence_ms=160, speech_pad_ms=64),
        [(1536, 22528), (35840, 40448)],
    ),
    (
        "short_burst_dropped",
        row((0.02, 5), (0.9, 3), (0.02, 30), (0.9, 20), (0.02, 5)),
        32_239,
        dict(threshold=0.5, min_speech_ms=250, min_silence_ms=100, speech_pad_ms=30),
        [(18976, 30176)],
    ),
    (
        "max_speech_latest_silence",
        row((0.02, 3), (0.9, 40), (0.05, 5), (0.9, 50), (0.05, 12), (0.9, 30), (0.02, 4), (0.9, 60), (0.02, 5)),
        106_991,
        dict(threshold=0.5, min_speech_ms=250, min_silence_ms=400, speech_pad_ms=30, max_speech_s=3.0),
        [(1056, 22496), (24096, 50656), (55840, 103392)],
    ),
    (
        "max_speech_hard_cut",
        row((0.9, 200), (0.02, 4)),
        104_431,
        dict(threshold=0.5, min_speech_ms=250, min_silence_ms=400, speech_pad_ms=30, max_speech_s=2.0),
        [(0, 30976), (30976, 62208), (62208, 93440), (93440, 104431)],
    ),
    (
        "pad_meets_in_the_gap",
        row((0.02, 5), (0.9, 20), (0.02, 12), (0.9, 20), (0.02, 5)),
        31_727,
        dict(threshold=0.5, min_speech_ms=100, min_silence_ms=100, speech_pad_ms=200),
        [(0, 15872), (15872, 31727)],
    ),
]


@pytest.mark.parametrize(("name", "probs", "total", "options", "expected"), FIXTURES, ids=[f[0] for f in FIXTURES])
def test_segments_match_the_upstream_algorithm(name, probs, total, options, expected) -> None:
    spans = seg.speech_spans(probs, total, seg.SegmentOptions(**options))
    assert [tuple(s) for s in spans] == expected


def test_parity_with_the_pip_copy_on_random_rows(monkeypatch) -> None:
    vad = pytest.importorskip("faster_whisper.vad")
    rnd = random.Random(11)  # noqa: S311 — a fixed seed for a repeatable fuzz, not a secret
    for _ in range(150):
        probs: list[float] = []
        for _ in range(rnd.randint(5, 40)):
            probs += [rnd.choice([0.02, 0.1, 0.3, 0.4, 0.6, 0.9])] * rnd.randint(1, 25)
        total = len(probs) * FRAME - rnd.randint(0, 400)
        kw: dict[str, Any] = dict(
            threshold=rnd.choice([0.35, 0.5]),
            min_speech_duration_ms=rnd.choice([0, 120, 250]),
            min_silence_duration_ms=rnd.choice([100, 300, 700]),
            speech_pad_ms=rnd.choice([0, 30, 200]),
            max_speech_duration_s=rnd.choice([1.0, 3.0, math.inf]),
        )
        monkeypatch.setattr(vad, "get_vad_model", lambda p=probs: lambda _audio: p)
        theirs = [
            (s["start"], s["end"]) for s in vad.get_speech_timestamps(np.zeros(total, np.float32), vad.VadOptions(**kw))
        ]
        ours = seg.SegmentOptions(
            threshold=kw["threshold"],
            min_speech_ms=kw["min_speech_duration_ms"],
            min_silence_ms=kw["min_silence_duration_ms"],
            speech_pad_ms=kw["speech_pad_ms"],
            max_speech_s=kw["max_speech_duration_s"],
        )
        assert [tuple(s) for s in seg.speech_spans(probs, total, ours)] == theirs


def test_best_cut_takes_the_longest_silence_where_the_old_rule_takes_the_latest() -> None:
    # A 2.5 s limit: a 0.38 s silence after frame 30 and a 0.19 s one after frame 70, both in range when it hits.
    probs = row((0.9, 30), (0.05, 12), (0.9, 28), (0.05, 6), (0.9, 40))
    base: dict[str, Any] = dict(threshold=0.5, min_speech_ms=100, min_silence_ms=700, speech_pad_ms=0, max_speech_s=2.5)
    latest = seg.speech_spans(probs, len(probs) * FRAME, seg.SegmentOptions(**base))
    best = seg.speech_spans(probs, len(probs) * FRAME, seg.SegmentOptions(**base, best_cut=True))
    assert latest[0].end == 70 * FRAME
    assert best[0].end == 30 * FRAME and best[1].start == 42 * FRAME
    assert best[-1].end == len(probs) * FRAME  # nothing after the cut is lost


def test_best_cut_never_cuts_in_a_silence_shorter_than_the_floor() -> None:
    probs = row((0.9, 60), (0.05, 2), (0.9, 60))
    opt = seg.SegmentOptions(
        threshold=0.5,
        min_speech_ms=100,
        min_silence_ms=700,
        speech_pad_ms=0,
        max_speech_s=2.0,
        min_cut_silence_ms=150,
        best_cut=True,
    )
    spans = seg.speech_spans(probs, len(probs) * FRAME, opt)
    assert all(s.end - s.start <= 2.0 * RATE for s in spans)
    assert all(not (60 * FRAME < s.end < 62 * FRAME) for s in spans)  # the 64 ms dip is not a cut point


def test_hindi_and_mixed_speech_wait_longer_than_english_before_a_silence_counts() -> None:
    hindi, mixed, english = (seg.options_for_language(c) for c in ("hi-IN", None, "en"))
    assert hindi.min_silence_ms == mixed.min_silence_ms > english.min_silence_ms
    assert hindi.min_cut_silence_ms > english.min_cut_silence_ms and hindi.best_cut
    # A 224 ms closure inside a word: one span for Hindi and for English, two for a 100 ms rule.
    probs = row((0.9, 20), (0.05, 7), (0.9, 20), (0.02, 40))
    total = len(probs) * FRAME
    assert len(seg.speech_spans(probs, total, hindi)) == 1
    assert len(seg.speech_spans(probs, total, english)) == 1
    assert len(seg.speech_spans(probs, total, seg.SegmentOptions(min_silence_ms=100, min_speech_ms=100))) == 2
    # A 400 ms rest: English and Hindi (350 ms) both split there.
    rest = row((0.9, 20), (0.05, 13), (0.9, 20), (0.02, 40))
    assert len(seg.speech_spans(rest, len(rest) * FRAME, hindi)) == 2


class FrameStream:
    """A stand-in for ``SileroStream``: ``p`` follows the energy of the frame just pushed."""

    def __init__(self) -> None:
        self.pushed: list[int] = []
        self.resets = 0
        self.p = 0.0

    def reset(self) -> None:
        self.resets += 1

    def push(self, pcm) -> None:
        arr = np.asarray(pcm, dtype=np.float32)
        self.pushed.append(arr.size)
        self.p = 0.95 if float(np.sqrt(np.mean(arr**2))) > 0.02 else 0.02


def test_frame_probabilities_pads_to_whole_frames_and_resets_the_stream() -> None:
    stream = FrameStream()
    clip = np.zeros(FRAME * 3 + 10, dtype=np.float32)
    clip[FRAME : FRAME * 2] = 0.3
    ticks: list[int] = []
    probs = seg.frame_probabilities(clip, stream, tick=lambda: ticks.append(1))
    assert probs == [0.02, 0.95, 0.02, 0.02] and stream.resets == 1 and set(stream.pushed) == {FRAME}
    assert ticks == [1]
    as_int = (clip * 32767).astype(np.int16)
    assert seg.frame_probabilities(as_int, FrameStream())[1] == 0.95
    assert seg.frame_probabilities(np.zeros(0, np.float32), FrameStream()) == []


def test_collect_speech_loses_no_sample_and_groups_by_duration() -> None:
    audio = np.arange(RATE * 10, dtype=np.float32)
    spans = [seg.Span(1000, 17000), seg.Span(30000, 62000), seg.Span(80000, 96000), seg.Span(120000, 126000)]
    whole, meta = seg.collect_speech(audio, spans, RATE)
    assert len(whole) == 1 and meta[0]["segments"] == spans and meta[0]["duration"] == 70000 / RATE
    np.testing.assert_array_equal(whole[0], np.concatenate([audio[a:b] for a, b in spans]))
    pieces, info = seg.collect_speech(audio, spans, RATE, max_duration=3.0)
    assert [m["segments"] for m in info] == [spans[:2], spans[2:]]  # 3 s holds two spans exactly
    assert [m["offset"] for m in info] == [0.0, 3.0]
    assert sum(len(p) for p in pieces) == 70000
    empty, none = seg.collect_speech(audio, [], RATE)
    assert len(empty[0]) == 0 and none[0]["segments"] == []


def test_time_map_returns_every_joined_sample_to_its_place_on_the_original_clip() -> None:
    spans = [seg.Span(1000, 17000), seg.Span(30000, 62000), seg.Span(80000, 96000)]
    audio = np.arange(100_000, dtype=np.float32)
    joined = np.concatenate([audio[a:b] for a, b in spans])
    tmap = seg.SpeechTimeMap(spans, RATE, precision=6)
    for at in (0, 5, 15999, 16000, 16001, 30000, 47999, 48000, 48001, len(joined) - 1):
        original = tmap.original_time(at / RATE) * RATE
        assert round(original) == joined[at], at
    assert tmap.original_time(16000 / RATE, is_end=True) == pytest.approx(17000 / RATE)  # an end stays in its span
    assert tmap.original_time(16000 / RATE) == pytest.approx(30000 / RATE)  # a start belongs to the next one
    assert seg.SpeechTimeMap([], RATE).original_time(1.234) == 1.234


def test_time_map_agrees_with_the_pip_copy() -> None:
    vad = pytest.importorskip("faster_whisper.vad")
    spans = [seg.Span(1000, 17000), seg.Span(30000, 62000), seg.Span(80000, 96000)]
    theirs = vad.SpeechTimestampsMap([{"start": a, "end": b} for a, b in spans], RATE)
    ours = seg.SpeechTimeMap(spans, RATE, precision=2)
    for at in (0.0, 0.5, 1.0, 2.0, 3.0, 4.0, 5.9):
        assert ours.original_time(at) == theirs.get_original_time(at)
        assert ours.original_time(at, is_end=True) == theirs.get_original_time(at, is_end=True)


# ---- the long-form plan -------------------------------------------------------------------------------------------


def _ninety_seconds() -> np.ndarray:
    """90 s: sentences of tone words (0.3 s, 80 ms apart), each followed by a 0.7 s rest."""
    clip = np.zeros(90 * RATE, dtype=np.float32)
    clock, sentence = 0.5, 0
    while clock < 88.0:
        for _ in range(8 + (sentence * 5) % 6):
            if clock + 0.3 > 88.0:
                break
            a, b = int(clock * RATE), int((clock + 0.3) * RATE)
            clip[a:b] = 0.3 * np.sin(2 * np.pi * 220 * np.arange(b - a) / RATE)
            clock += 0.38
        clock += 0.62
        sentence += 1
    return clip


def _use_energy_stream(monkeypatch) -> None:
    monkeypatch.setattr(vad_onnx, "SileroStream", FrameStream)


def test_ninety_seconds_are_split_at_silences_and_no_seam_sample_is_lost(monkeypatch) -> None:
    _use_energy_stream(monkeypatch)
    clip = _ninety_seconds()
    pauses = stt.longform_pauses(clip, "hi")
    assert pauses and all(b - a >= 0.5 for a, b in pauses)
    pieces = stt.plan_chunks(clip, pauses=pauses)
    assert len(pieces) >= 4 and pieces[0]["start"] == 0.0 and pieces[-1]["end"] == 90.0
    assert [p["cut"] for p in pieces[:-1]] == ["silence"] * (len(pieces) - 1)
    covered = np.zeros(len(clip), dtype=bool)
    for earlier, later in zip(pieces, pieces[1:], strict=False):
        mid = int(earlier["end"] * RATE)
        assert float(np.abs(clip[mid - 800 : mid + 800]).max()) == 0.0  # the cut lies inside a rest
        assert int(later["start"] * RATE) < mid  # the next piece starts before this one ends: no gap
    for p in pieces:
        assert p["end"] - p["start"] <= stt.LONGFORM_CHUNK_S + 1e-6
        covered[int(p["start"] * RATE) : int(p["end"] * RATE)] = True
    assert bool(covered.all())  # 0 samples lost at the seams


def test_the_joined_speech_of_the_ninety_seconds_keeps_every_voiced_sample() -> None:
    clip = _ninety_seconds()
    probs = seg.frame_probabilities(clip, FrameStream())
    spans = seg.speech_spans(probs, len(clip), seg.options_for_language("hi", max_speech_s=25.0, speech_pad_ms=60))
    pieces, info = seg.collect_speech(clip, spans, RATE, max_duration=25.0)
    voiced = int(np.count_nonzero(clip))
    assert sum(int(np.count_nonzero(p)) for p in pieces) == voiced  # every voiced sample is in a piece
    assert all(m["duration"] <= 25.0 + 1e-6 for m in info if len(m["segments"]) > 1)


def test_a_clip_with_no_speech_is_one_long_pause(monkeypatch) -> None:
    _use_energy_stream(monkeypatch)
    assert stt.longform_pauses(np.zeros(40 * RATE, dtype=np.float32), "en") == [(0.0, 40.0)]


def test_plan_without_the_model_is_the_energy_plan(monkeypatch) -> None:
    def missing(*_a, **_k):
        raise vad_onnx.VadUnavailable("no model")

    monkeypatch.setattr(vad_onnx, "SileroStream", missing)
    clip = _ninety_seconds()
    assert stt.longform_pauses(clip, "en") is None
    assert stt.plan_chunks(clip, pauses=None) == stt.plan_chunks(clip)


def test_a_cancel_during_the_voice_scan_reaches_the_caller(monkeypatch) -> None:
    _use_energy_stream(monkeypatch)

    def cancelled() -> None:
        raise stt.DecodeCancelled()

    monkeypatch.setattr(stt, "check_cancel", cancelled)
    with pytest.raises(stt.DecodeCancelled):
        stt.longform_pauses(np.zeros(5 * RATE, dtype=np.float32))


def test_the_long_form_reader_plans_from_the_voice_model_when_it_has_one(monkeypatch) -> None:
    seen: dict = {"lengths": []}
    monkeypatch.setattr(
        stt, "longform_pauses", lambda s, lang=None, rate=RATE: seen.update(lang=lang) or [(10.0, 11.0)]
    )
    clip = np.zeros(50 * RATE, dtype=np.float32)

    class Silent:
        def transcribe(self, piece, **kw):
            seen["lengths"].append(len(piece) / RATE)
            return iter([]), type("I", (), {"language": "hi", "duration": 1.0, "duration_after_vad": 0.0})()

    stt._consume_longform(Silent(), clip, {"language": "hi"}, "", None)
    assert seen["lang"] == "hi" and seen["lengths"][0] == pytest.approx(10.5, abs=0.01)  # cut mid-pause at 10.5 s
