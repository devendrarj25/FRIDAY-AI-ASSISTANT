"""FRIDAY Ears: speech segments from the Silero probability stream (numpy only, no torch, no model class here).

``vad_onnx.SileroStream`` already scores 512-sample frames (32 ms). This module turns that row of probabilities into
what the long-form reader needs, and nothing in it touches a model, so every rule is tested with made-up numbers.

* ``frame_probabilities``: the clip run through a stream, one probability per frame (padded with silence to a whole
  frame, as the model reads it).
* ``speech_spans``: the segments. A frame at or above ``threshold`` starts speech; speech lasts until the probability
  falls under ``neg_threshold`` (a value between the two never flips the state) and stays there for
  ``min_silence_ms``. Spans shorter than ``min_speech_ms`` are dropped, each side gets ``speech_pad_ms`` (two
  neighbours split a short gap between them). A span longer than ``max_speech_s`` is cut at a silence: with
  ``best_cut`` the longest silence of that span (at least ``min_cut_silence_ms``), otherwise the latest one, else
  hard just before the limit.
* ``silence_gaps``: the pauses between spans, for a planner that wants to cut in the middle of one.
* ``collect_speech`` joins spans into audio pieces of at most ``max_duration`` seconds; ``SpeechTimeMap`` gives a time
  on the joined audio back as a time on the original clip, so words found in the joined audio keep their place.
* ``options_for_language``: Hindi, the other Indic languages and mixed speech get a longer minimum silence than
  English, because a stop closure or a doubled consonant is a quiet stretch inside one word.

No import side effects; numpy is imported only when a function needs it.
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, NamedTuple

RATE = 16000
FRAME = 512  # samples the Silero model scores at a time; every probability covers this many
TICK_FRAMES = 256  # how often ``frame_probabilities`` calls its ``tick`` (a cancel check)
INDIC = frozenset({"hi", "ur", "bn", "mr", "gu", "pa", "ta", "te", "kn", "ml", "ne", "or", "as", "sa"})


class Span(NamedTuple):
    """A stretch of speech, in samples of the original clip."""

    start: int
    end: int


@dataclass(frozen=True)
class SegmentOptions:
    threshold: float = 0.5
    neg_threshold: float | None = None  # None: ``threshold`` minus 0.15, never under 0.01
    min_speech_ms: int = 250
    min_silence_ms: int = 100
    speech_pad_ms: int = 30
    max_speech_s: float = math.inf
    min_cut_silence_ms: int = 98  # a silence shorter than this is never a place to cut an over-long span
    best_cut: bool = False  # cut an over-long span at its longest silence, not its latest


def options_for_language(
    language: str | None,
    *,
    max_speech_s: float = math.inf,
    threshold: float = 0.35,
    speech_pad_ms: int = 0,
) -> SegmentOptions:
    """Options for cutting a long clip. ``language`` is a code ("hi", "en"), or None/"" for auto, which is treated
    as possibly mixed Hindi and English: the quiet stretches inside a Hindi word (stop closures, doubled consonants,
    about 150-250 ms) must not split it, so those get a longer minimum silence and cut floor than English."""
    code = (language or "").strip().lower().split("-")[0]
    indic_or_mixed = code in INDIC or code in {"", "auto", "hinglish"}
    return SegmentOptions(
        threshold=threshold,
        min_speech_ms=120,
        min_silence_ms=350 if indic_or_mixed else 250,
        speech_pad_ms=speech_pad_ms,
        max_speech_s=max_speech_s,
        min_cut_silence_ms=150 if indic_or_mixed else 98,
        best_cut=True,
    )


def frame_probabilities(samples: Any, stream: Any, *, tick: Callable[[], None] | None = None) -> list[float]:
    """One speech probability per 512-sample frame of ``samples`` (16 kHz mono float, or int16), from a
    ``vad_onnx.SileroStream`` (anything with ``reset``, ``push`` and ``p``). The clip is padded with silence to a
    whole frame, so the count is ``ceil(len / 512)``. ``tick`` runs every ``TICK_FRAMES`` frames."""
    import numpy as np

    clip = np.asarray(samples)
    if clip.dtype.kind in "iu":
        clip = clip.astype(np.float32) / 32768.0
    clip = clip.astype(np.float32, copy=False).reshape(-1)
    if clip.size == 0:
        return []
    padded = np.pad(clip, (0, (-clip.size) % FRAME))
    stream.reset()
    out: list[float] = []
    for index, at in enumerate(range(0, padded.size, FRAME)):
        if tick is not None and index % TICK_FRAMES == 0:
            tick()
        stream.push(padded[at : at + FRAME])
        out.append(float(stream.p))
    return out


def speech_spans(
    probs: Sequence[float], total_samples: int, options: SegmentOptions | None = None, rate: int = RATE
) -> list[Span]:
    """The speech spans (sample positions on the original clip) of a probability row. See the module doc."""
    opt = options or SegmentOptions()
    threshold = opt.threshold
    neg = opt.neg_threshold if opt.neg_threshold is not None else max(threshold - 0.15, 0.01)
    min_speech = rate * opt.min_speech_ms / 1000
    pad = rate * opt.speech_pad_ms / 1000
    max_speech = rate * opt.max_speech_s - FRAME - 2 * pad
    min_silence = rate * opt.min_silence_ms / 1000
    cut_floor = rate * opt.min_cut_silence_ms / 1000

    triggered = False
    spans: list[list[int]] = []
    start = 0
    temp_end = 0  # where the quiet stretch that may end the span began
    prev_end = next_start = 0  # the latest usable silence of this span: where it began, where speech resumed
    silences: list[tuple[int, int]] = []  # best_cut: finished silences of this span as (began, length)

    for index, prob in enumerate(probs):
        at = FRAME * index
        if prob >= threshold and temp_end:
            if opt.best_cut and at - temp_end > cut_floor:
                silences.append((temp_end, at - temp_end))
            temp_end = 0
            if next_start < prev_end:
                next_start = at
        if prob >= threshold and not triggered:
            triggered, start, silences = True, at, []
            continue
        if triggered and at - start > max_speech:
            if opt.best_cut:
                found = list(silences)
                if temp_end and at - temp_end > cut_floor:
                    found.append((temp_end, at - temp_end))
                if found:
                    began, length = max(found, key=lambda s: (s[1], s[0]))
                    spans.append([start, began])
                    resumes = not (temp_end and began == temp_end)
                    start = began + length
                    silences = [s for s in silences if s[0] >= start]
                    prev_end = next_start = temp_end = 0
                    triggered = resumes
                else:
                    spans.append([start, at])
                    prev_end = next_start = temp_end = 0
                    silences = []
                    triggered = False
                    continue
            elif prev_end:
                spans.append([start, prev_end])
                if next_start < prev_end:
                    triggered = False
                else:
                    start = next_start
                prev_end = next_start = temp_end = 0
            else:
                spans.append([start, at])
                prev_end = next_start = temp_end = 0
                triggered = False
                continue
        if prob < neg and triggered:
            if not temp_end:
                temp_end = at
            if at - temp_end > cut_floor:
                prev_end = temp_end
            if at - temp_end < min_silence:
                continue
            if temp_end - start > min_speech:
                spans.append([start, temp_end])
            prev_end = next_start = temp_end = 0
            silences = []
            triggered = False

    if triggered and total_samples - start > min_speech:
        spans.append([start, total_samples])
    return _pad(spans, total_samples, pad)


def _pad(spans: list[list[int]], total: int, pad: float) -> list[Span]:
    for index, span in enumerate(spans):
        if index == 0:
            span[0] = int(max(0, span[0] - pad))
        if index != len(spans) - 1:
            gap = spans[index + 1][0] - span[1]
            if gap < 2 * pad:
                span[1] += int(gap // 2)
                spans[index + 1][0] = int(max(0, spans[index + 1][0] - gap // 2))
            else:
                span[1] = int(min(total, span[1] + pad))
                spans[index + 1][0] = int(max(0, spans[index + 1][0] - pad))
        else:
            span[1] = int(min(total, span[1] + pad))
    return [Span(int(a), int(b)) for a, b in spans]


def silence_gaps(spans: Sequence[Span], rate: int = RATE, min_s: float = 0.0) -> list[tuple[float, float]]:
    """(start, end) seconds of the quiet between two neighbouring spans, at least ``min_s`` long. The quiet before
    the first span and after the last is not a gap: nothing is cut there."""
    gaps = [(a.end / rate, b.start / rate) for a, b in zip(spans, spans[1:], strict=False)]
    return [(a, b) for a, b in gaps if b - a >= min_s]


def collect_speech(
    audio: Any, spans: Sequence[Span], rate: int = RATE, max_duration: float = math.inf
) -> tuple[list[Any], list[dict]]:
    """Join the spans into pieces of at most ``max_duration`` seconds (a single longer span stays whole). Returns the
    audio pieces and, per piece, ``{"offset", "duration", "segments"}``: where it starts on the joined clock, its
    length in seconds and the spans in it. No sample of a span is lost or repeated; nothing spans between pieces."""
    import numpy as np

    if not spans:
        return [np.zeros(0, dtype=np.float32)], [{"offset": 0.0, "duration": 0.0, "segments": []}]
    limit = max_duration * rate
    pieces: list[Any] = []
    meta: list[dict] = []
    members: list[Span] = []
    parts: list[Any] = []
    length = 0
    joined = 0
    for span in spans:
        size = span.end - span.start
        if members and length + size > limit:
            pieces.append(np.concatenate(parts))
            meta.append({"offset": joined / rate, "duration": length / rate, "segments": members})
            joined += length
            members, parts, length = [], [], 0
        members.append(span)
        parts.append(audio[span.start : span.end])
        length += size
    pieces.append(np.concatenate(parts))
    meta.append({"offset": joined / rate, "duration": length / rate, "segments": members})
    return pieces, meta


class SpeechTimeMap:
    """A time on the joined speech clock, mapped back to the original clip: the silence cut out before that point is
    added again. ``is_end`` makes a time that falls exactly on a span's end belong to that span."""

    def __init__(self, spans: Sequence[Span], rate: int = RATE, precision: int = 3) -> None:
        self.rate = rate
        self.precision = precision
        self._ends: list[int] = []  # each span's end on the joined clock, in samples
        self._cut: list[int] = []  # silence removed before each span, in samples
        before = 0
        cut = 0
        for span in spans:
            cut += span.start - before
            before = span.end
            self._ends.append(span.end - cut)
            self._cut.append(cut)

    def original_time(self, seconds: float, is_end: bool = False) -> float:
        if not self._ends:
            return round(seconds, self.precision)
        sample = int(round(seconds * self.rate))
        index = bisect.bisect_left(self._ends, sample) if is_end else bisect.bisect_right(self._ends, sample)
        index = min(index, len(self._ends) - 1)
        return round(seconds + self._cut[index] / self.rate, self.precision)
