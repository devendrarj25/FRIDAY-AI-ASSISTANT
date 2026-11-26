"""FRIDAY Ears: language per turn and per segment, LocalAgreement-2 partials for re-decoding ears, and chunked CTC.

Interface contract
------------------
Language (Hindi, English, Hinglish)
* ``turn_mode(locale)`` is ``"hi"``, ``"en"``, ``"hi-en"`` (Hinglish), ``""`` (nothing chosen) or another ISO code.
* ``TurnLanguage`` makes ONE language decision per turn and never re-detects inside it: ``hi`` and ``en`` are locked
  from the start; Hinglish and nothing-chosen take the first reading's language (``observe``) and keep it for the
  rest of the turn (an Indic guess locks ``hi``; a Hinglish turn locks only ``hi`` or ``en``).
* ``segment_language(text, mode)`` is the language one segment is read in: Devanagari is ``hi``, Hindi written in
  Roman letters is ``hi``, other Latin text is ``en`` (in the English mode everything is ``en``). Hindi comes out in
  Devanagari and English words stay Latin.
* ``plan_rescore`` picks the segments of a reading whose language differs from the language the reading was decoded
  in (at most ``MAX_RESCORE_SEGMENTS`` and ``MAX_RESCORE_S`` of audio); ``apply_rescore`` decodes each of those once
  with its forced language and keeps the new text only when it is in the script that language is written in and
  about the same length. ``segments_from_words`` cuts timed words into such segments.

LocalAgreement-2 partials (``La2Partials``)
* A *reader* re-decodes a window of 16 kHz mono float audio: ``reader(window, prompt) -> words`` with times in
  seconds from the window start (``stream_commit.Word``, ``str`` or ``(text, start, end)``). The Hindi ear and a
  resident Whisper are readers.
* ``push(samples)`` adds audio and, once ``hop_s`` of new audio is in, re-decodes the window and feeds the words to
  a ``PartialStabiliser``: a word is committed once two readings in a row agree, and the committed prefix never
  shrinks. The window rolls forward (``suggest_trim``) so a decode never grows past ``max_window_s``; text that left
  the window is the ``prompt`` for the next reading. ``finalize`` reads the unread tail once and commits the rest.
* The last ``max_turn_s`` of audio is kept for the final per-segment rescore (``turn_audio``).

Chunked CTC (``CtcChunkReader``)
* A reader over a CTC model: ``log_probs(window) -> (frames, vocab)``, decoded by ``ctc_decode.ctc_prefix_beam``
  with the owner's hotwords as a ``hotword_trie`` bias; words are timed from the greedy alignment.

``snap_hotwords`` is the word-level bias for an ear whose runtime gives only text: a heard word (or two or three)
within ``min_ratio`` of an owner's word, in the same script, takes the owner's spelling.

numpy is imported only where audio is handled. Nothing here loads a model, opens a microphone or reads the clock
unless a clock is passed in.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

import language_segmenter
from hotword_trie import WORD_MARK, trie_for_words
from stream_commit import MAX_WINDOW_S, LocalAgreementCommitter, Partial, PartialStabiliser, Word, to_words, word_key

RATE = 16000
INDIC = frozenset({"hi", "ur", "ne", "mr", "bn", "pa", "gu", "sa"})
HINGLISH = frozenset({"hi-en", "en-hi", "hinglish", "mixed", "hi-latn", "hinglish-roman"})
MAX_RESCORE_SEGMENTS = 4
MAX_RESCORE_S = 15.0
RESCORE_PAD_S = 0.1
_DEVANAGARI = re.compile("[ऀ-ॿ]")
_LATIN = re.compile("[A-Za-z]")

Reader = Callable[[Any, str], Sequence[Any]]


# ---- language: one decision per turn, one forced language per segment ----------------------------------------------


def turn_mode(locale: str) -> str:
    raw = (locale or "").strip().lower().replace("_", "-")
    if not raw or raw == "auto":
        return ""
    if raw in HINGLISH or raw.startswith("hi-latn-"):
        return "hi-en"
    if raw.startswith("hi"):
        return "hi"
    if raw.startswith("en"):
        return "en"
    iso = raw[:2]
    return iso if len(iso) == 2 and iso.isalpha() else ""


class TurnLanguage:
    """The decode language of one turn. ``decode_language`` is None only until the first reading of an open turn."""

    def __init__(self, locale: str = "") -> None:
        self.mode = turn_mode(locale)
        self.locked: str | None = self.mode if self.mode not in {"", "hi-en"} else None

    def decode_language(self) -> str | None:
        return self.locked

    def observe(self, detected: str | None) -> str | None:
        """Lock the turn on the first reading's language; later readings never change it."""
        guess = (detected or "").strip().lower()[:2]
        if self.locked is None and guess:
            if guess in INDIC:
                self.locked = "hi"
            elif guess == "en" or self.mode == "hi-en":
                self.locked = "en"
            else:
                self.locked = guess
        return self.locked


def script_of(text: str) -> str:
    """``deva``, ``latin``, ``mixed`` or "" (no letters)."""
    deva, latin = bool(_DEVANAGARI.search(text or "")), bool(_LATIN.search(text or ""))
    return "mixed" if deva and latin else "deva" if deva else "latin" if latin else ""


def roman_hindi(text: str) -> bool:
    """Hindi in Roman letters: no Devanagari, two or more Latin words, and common Hindi words are half or more."""
    if _DEVANAGARI.search(text or ""):
        return False
    latin = re.findall("[A-Za-z]+", text or "")
    if len(latin) < 2:
        return False
    hits = round(language_segmenter.roman_hindi_ratio(text) * len(latin))
    return hits >= 2 and hits * 2 >= len(latin)


def segment_language(text: str, mode: str = "") -> str | None:
    """The language a segment is read in, or None for a segment with no letters."""
    script = script_of(text)
    if not script:
        return None
    if mode == "en":
        return "en"
    if script == "mixed":
        deva = len(re.findall("[ऀ-ॿ]+", text))
        latin = len(re.findall("[A-Za-z]+", text))
        return "hi" if deva >= latin else "en"
    if script == "deva" or roman_hindi(text):
        return "hi"
    return "en"


def expected_script(language: str) -> str:
    return "deva" if language == "hi" else "latin"


@dataclass(frozen=True)
class RescorePlan:
    index: int
    language: str
    start: float
    end: float


def plan_rescore(
    segments: Sequence[Mapping[str, Any]],
    decoded: str | None,
    mode: str = "",
    *,
    max_segments: int = MAX_RESCORE_SEGMENTS,
    max_audio_s: float = MAX_RESCORE_S,
    pad_s: float = RESCORE_PAD_S,
) -> list[RescorePlan]:
    """Segments (``{"text", "start", "end"}``) to read once more in their own language. None when the reading's
    language is unknown, in the Roman Hinglish mode, or when every segment already matches it."""
    done = (decoded or "").strip().lower()[:2]
    if not done:
        return []
    plans: list[RescorePlan] = []
    used = 0.0
    for index, seg in enumerate(segments):
        lang = segment_language(str(seg.get("text") or ""), mode)
        try:
            start, end = float(seg.get("start") or 0.0), float(seg.get("end") or 0.0)
        except (TypeError, ValueError):
            continue
        if lang is None or lang == done or end <= start:
            continue
        lo, hi = max(0.0, start - pad_s), end + pad_s
        if len(plans) >= max_segments or used + (hi - lo) > max_audio_s:
            break
        used += hi - lo
        plans.append(RescorePlan(index, lang, round(lo, 3), round(hi, 3)))
    return plans


def _length_ok(before: str, after: str) -> bool:
    a, b = len(before.split()), len(after.split())
    return a == 0 or 0.5 <= b / a <= 2.0


def apply_rescore(
    segments: Sequence[Mapping[str, Any]],
    plans: Sequence[RescorePlan],
    decode: Callable[[RescorePlan], Mapping[str, Any] | None],
) -> tuple[list[dict[str, Any]], int]:
    """Each planned segment decoded once with its forced language. Returns the segments and how many changed."""
    out = [dict(seg) for seg in segments]
    changed = 0
    for plan in plans:
        try:
            got = decode(plan)
        except Exception:  # noqa: BLE001, S112 — a failed second look keeps the first reading
            continue
        text = str((got or {}).get("text") or "").strip()
        old = str(out[plan.index].get("text") or "").strip()
        if not text or script_of(text) != expected_script(plan.language) or not _length_ok(old, text):
            continue
        if text != old:
            out[plan.index] = {**out[plan.index], "text": text, "language": plan.language, "rescored": True}
            changed += 1
    return out, changed


def segments_from_words(words: Sequence[Word], mode: str = "", min_words: int = 2) -> list[dict[str, Any]]:
    """Timed words cut into runs of one language (a run shorter than ``min_words`` joins the run before it)."""
    runs: list[list[Any]] = []  # [lang, [words]]
    for w in words:
        if w.start is None or w.end is None:
            return []
        lang = segment_language(w.text, mode) or (runs[-1][0] if runs else "en")
        if lang == "en" and mode != "en" and language_segmenter.roman_hindi_ratio(w.text) >= 1.0:
            lang = "hi"
        if runs and runs[-1][0] == lang:
            runs[-1][1].append(w)
        else:
            runs.append([lang, [w]])
    merged: list[list[Any]] = []
    for run in runs:
        if merged and (len(run[1]) < min_words or merged[-1][0] == run[0]):
            merged[-1][1].extend(run[1])
        elif merged and len(merged[-1][1]) < min_words:
            merged[-1] = [run[0], merged[-1][1] + run[1]]
        else:
            merged.append(run)
    return [
        {"text": " ".join(w.text for w in ws), "start": ws[0].start, "end": ws[-1].end, "language": lang}
        for lang, ws in merged
    ]


# ---- hotwords at the word level -----------------------------------------------------------------------------------


def snap_hotwords(
    words: Sequence[Word], hotwords: Sequence[str], *, min_ratio: float = 0.8, min_chars: int = 4
) -> list[Word]:
    """Heard words close to an owner's word (same script, ``min_ratio`` similar, ``min_chars`` or longer) take the
    owner's spelling; a phrase of n words matches n heard words, or n + 1 when the heard words are very close (a
    word split in two). Exact matches, far words and another script stay as heard."""
    targets = []
    for phrase in hotwords:
        text = " ".join(str(phrase).split())
        key = word_key(text)
        if len(key.replace(" ", "")) >= min_chars:
            targets.append((text, key, script_of(text), len(text.split())))
    if not targets or not words:
        return list(words)
    out: list[Word] = []
    i = 0
    while i < len(words):
        best: tuple[float, int, str] | None = None
        for size in (3, 2, 1):
            if i + size > len(words):
                continue
            span = " ".join(w.text for w in words[i : i + size])
            span_key = word_key(span)
            for text, key, script, count in targets:
                if size not in (count, count + 1) or script_of(span) != script or span_key == key:
                    continue
                ratio = SequenceMatcher(a=span_key, b=key, autojunk=False).ratio()
                need = min_ratio if size == count else max(min_ratio, 0.9)  # a split word must be very close
                if ratio >= need and (best is None or ratio > best[0]):
                    best = (ratio, size, text)
        if best is None:
            out.append(words[i])
            i += 1
            continue
        _ratio, size, text = best
        first, last = words[i], words[i + size - 1]
        parts = text.split()
        tail = re.search("[^\\w\u0900-\u0963\u0966-\u097f]+$", last.text)  # a full stop or danda the heard word carried
        if tail and not parts[-1].endswith(tail.group(0)):
            parts[-1] += tail.group(0)
        if first.start is None or last.end is None:
            out.extend(Word(p) for p in parts)
        else:
            step = (last.end - first.start) / len(parts)
            out.extend(
                Word(p, round(first.start + k * step, 3), round(first.start + (k + 1) * step, 3))
                for k, p in enumerate(parts)
            )
        i += size
    return out


# ---- LocalAgreement-2 over a re-decoding reader -------------------------------------------------------------------


class La2Partials:
    def __init__(
        self,
        reader: Reader,
        *,
        rate: int = RATE,
        hop_s: float = 0.5,
        min_audio_s: float = 0.3,
        max_window_s: float = MAX_WINDOW_S,
        max_turn_s: float = 30.0,
        stabiliser: PartialStabiliser | None = None,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        if hop_s <= 0 or max_window_s <= 0 or rate <= 0:
            raise ValueError("hop_s, max_window_s and rate must be positive")
        self.reader = reader
        self.rate, self.hop_s, self.min_audio_s, self.max_turn_s = rate, hop_s, min_audio_s, max_turn_s
        self.stabiliser = stabiliser or PartialStabiliser(LocalAgreementCommitter(max_window_s=max_window_s))
        self._clock = clock
        self.reset()

    def reset(self) -> None:
        import numpy as np

        self.stabiliser.reset()
        self._window = np.zeros(0, dtype=np.float32)
        self._turn = np.zeros(0, dtype=np.float32)
        self._offset = 0.0  # session seconds where the window starts
        self._unread = 0  # samples added since the last reading
        self.audio_s = 0.0
        self.compute_s = 0.0
        self.readings = 0
        self.last: Partial = self.stabiliser.update([])

    @property
    def committer(self) -> LocalAgreementCommitter:
        return self.stabiliser.committer

    def turn_audio(self) -> Any:
        return self._turn

    @property
    def turn_start_s(self) -> float:
        """Session seconds where ``turn_audio`` starts (it keeps only the last ``max_turn_s``)."""
        return max(0.0, self.audio_s - self._turn.size / self.rate)

    def push(self, samples: Any) -> Partial | None:
        """Add audio; a new ``Partial`` when a reading ran, else None."""
        import numpy as np

        arr = np.asarray(samples, dtype=np.float32).reshape(-1)
        if arr.size:
            self._window = np.concatenate([self._window, arr])
            self._turn = np.concatenate([self._turn, arr])[-int(self.max_turn_s * self.rate) :]
            self._unread += int(arr.size)
            self.audio_s += arr.size / self.rate
        if self._unread < self.hop_s * self.rate or self._window.size < self.min_audio_s * self.rate:
            return None
        return self._read()

    def _read(self) -> Partial:
        started = self._clock()
        heard = to_words(self.reader(self._window, self.committer.prompt()))
        self.compute_s += max(0.0, self._clock() - started)
        self.readings += 1
        self._unread = 0
        shifted = [
            w if w.start is None else Word(w.text, w.start + self._offset, (w.end or w.start) + self._offset)
            for w in heard
        ]
        partial = self.stabiliser.update(shifted)
        cut = self.committer.suggest_trim(self.audio_s)
        if cut is not None and cut > self._offset:
            drop = min(self._window.size, int(round((cut - self._offset) * self.rate)))
            self._window = self._window[drop:]
            self._offset += drop / self.rate
            partial = self.stabiliser.trim_at(self._offset)
        self.last = partial
        return partial

    def finalize(self) -> Partial:
        if self._unread and self._window.size >= self.min_audio_s * self.rate:
            self._read()
        self.last = self.stabiliser.finalize()
        return self.last


# ---- chunked CTC reader -------------------------------------------------------------------------------------------


class CtcChunkReader:
    """A ``La2Partials`` reader over a CTC model's per-frame log probabilities, biased by the owner's hotwords."""

    def __init__(
        self,
        log_probs: Callable[[Any], Any],
        pieces: Sequence[str],
        *,
        frame_s: float,
        blank_id: int = 0,
        hotwords: Sequence[str] = (),
        beam_width: int = 8,
        word_mark: str = WORD_MARK,
    ) -> None:
        if frame_s <= 0:
            raise ValueError("frame_s must be positive")
        self.log_probs, self.pieces, self.frame_s = log_probs, list(pieces), frame_s
        self.blank_id, self.beam_width, self.word_mark = blank_id, beam_width, word_mark
        vocab = {piece: i for i, piece in enumerate(self.pieces) if i != blank_id}
        self.trie = trie_for_words(list(hotwords), vocab, word_mark=word_mark) if hotwords else None

    def __call__(self, audio: Any, prompt: str = "") -> list[Word]:
        from ctc_decode import ctc_greedy, ctc_prefix_beam

        lp = self.log_probs(audio)
        frames = int(getattr(lp, "shape", (0,))[0])
        if frames == 0:
            return []
        best = ctc_prefix_beam(lp, beam_width=self.beam_width, blank_id=self.blank_id, hotwords=self.trie)
        tokens = list(best[0].tokens) if best else []
        if not tokens:
            return []
        greedy = ctc_greedy(lp, self.blank_id)
        if len(greedy.tokens) == len(tokens):
            at = list(greedy.frames)  # the same number of tokens: the greedy path times the beam's choice
        else:
            at = [int(k * frames / len(tokens)) for k in range(len(tokens))]
        words: list[list[Any]] = []  # [text, first frame]
        for token, frame in zip(tokens, at, strict=True):
            piece = self.pieces[token] if 0 <= token < len(self.pieces) else ""
            if not piece:
                continue
            if piece.startswith(self.word_mark) or not words:
                words.append([piece.removeprefix(self.word_mark), frame])
            else:
                words[-1][0] += piece
        out: list[Word] = []
        for k, (text, frame) in enumerate(words):
            end_frame = words[k + 1][1] if k + 1 < len(words) else frames
            if text:
                out.append(Word(text, round(frame * self.frame_s, 3), round(end_frame * self.frame_s, 3)))
        return out
