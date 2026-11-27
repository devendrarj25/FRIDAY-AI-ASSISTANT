"""Estimated word times of a spoken clause, on the clause's own clock.

The same idea as the renderer's ``estimateWordTimes`` (``played-text.ts``): each whitespace-separated word gets a weight
from its syllable-like units (Devanagari letters that carry a vowel, Latin vowel groups, digits) and the pause its
trailing punctuation asks for; the weights are scaled so the last word ends exactly at the clause's speech length.
Pure and numpy-free.
"""

from __future__ import annotations

import math
import re
import unicodedata

MAX_WORD_TIMES = 400

WORD_ONSET = 0.35
DIGIT_UNITS = 1.2
MAX_DIGIT_UNITS = 8
MAX_PAUSE_UNITS = 1.4
PAUSE_UNITS = {
    ",": 0.5,
    ";": 0.7,
    ":": 0.7,
    "—": 0.5,
    "–": 0.4,
    ".": 1.0,
    "!": 1.0,
    "?": 1.0,
    "।": 1.0,
    "॥": 1.0,
    "…": 1.2,
}
_DEVANAGARI_RUN = re.compile(r"[ऀ-ॿ]+")
_PIECE = re.compile(r"\d+|[^\W\d_̀-ͯ]+[̀-ͯ]*|[̀-ͯ]+")
_LATIN_WORD = re.compile(r"[A-Za-zÀ-ɏ]+")
_VOWELS = re.compile(r"[aeiouy]+")
_VIRAMA = "्"
_NUKTA = "़"


def _devanagari_syllables(run: str) -> int:
    count = 0
    bare_last = False
    for i, ch in enumerate(run):
        code = ord(ch)
        vowel = 0x904 <= code <= 0x914 or code in (0x960, 0x961)
        consonant = 0x915 <= code <= 0x939 or 0x958 <= code <= 0x95F
        bare_last = False
        if vowel:
            count += 1
        elif consonant:
            nxt = run[i + 1] if i + 1 < len(run) else ""
            if nxt == _NUKTA:
                nxt = run[i + 2] if i + 2 < len(run) else ""
            if nxt != _VIRAMA:
                count += 1
                bare_last = nxt == ""
    return count - 1 if bare_last and count > 1 else count


def _latin_syllables(word: str) -> int:
    if 2 <= len(word) <= 6 and word == word.upper():
        return len(word)
    decomposed = unicodedata.normalize("NFD", word.lower())
    lower = "".join(c for c in decomposed if not unicodedata.category(c).startswith("M"))
    lower = re.sub(r"^y(?=[aeiou])", "", lower)
    count = len(_VOWELS.findall(lower))
    if count > 1 and re.search(r"[^aeiouyl]e$", lower):
        count -= 1
    return max(1, count)


def word_units(token: str) -> float:
    """Speech units of one token (no pause); 0 when it holds no letter or digit."""
    units = 0
    letters = False

    def devanagari(match: re.Match[str]) -> str:
        nonlocal units, letters
        letters = True
        units += _devanagari_syllables(match.group(0))
        return " "

    rest = _DEVANAGARI_RUN.sub(devanagari, token)
    for piece in _PIECE.findall(rest):
        letters = True
        if piece[0].isdigit():
            units += min(MAX_DIGIT_UNITS, math.ceil(len(piece) * DIGIT_UNITS))
        elif _LATIN_WORD.fullmatch(piece):
            units += _latin_syllables(piece)
        else:
            units += len(piece)
    return WORD_ONSET + units if letters else 0.0


def pause_units(token: str) -> float:
    """Pause units after a token: its trailing punctuation, capped."""
    tail = []
    for ch in reversed(token):
        cat = unicodedata.category(ch)
        if cat[0] in "LNM":
            break
        tail.append(ch)
    return min(MAX_PAUSE_UNITS, sum(PAUSE_UNITS.get(ch, 0.0) for ch in tail))


def estimate_word_times(text: str, dur_ms: float, offset_ms: float = 0.0) -> list[dict]:
    """``[{word, startMs, endMs}]`` for the words of ``text`` over ``dur_ms`` of speech starting at ``offset_ms``.

    Monotone, inside ``[offset_ms, offset_ms + dur_ms]``; the last word ends at the end of the speech. Empty when there
    is no word or no length.
    """
    tokens = text.split()
    if not tokens or not (dur_ms > 0) or not math.isfinite(dur_ms):
        return []
    last = len(tokens) - 1
    speech = [word_units(t) for t in tokens]
    pause = [0.0 if i == last else pause_units(t) for i, t in enumerate(tokens)]
    total = sum(speech) + sum(pause)
    flat = not (total > 0)
    unit = dur_ms / len(tokens) if flat else dur_ms / total
    out: list[dict] = []
    cursor = 0.0
    for i, word in enumerate(tokens):
        start = cursor
        span = unit if flat else speech[i] * unit
        end = dur_ms if i == last else min(dur_ms, start + span)
        out.append({"word": word, "startMs": round(offset_ms + start, 1), "endMs": round(offset_ms + end, 1)})
        cursor = end + (0.0 if flat else pause[i] * unit)
    return out


def clip_word_times(segments: list[tuple[str, float, float]]) -> list[dict]:
    """Word times of a clip made of spoken segments ``(text, start_ms, end_ms)`` (silence between them is not listed),
    capped at ``MAX_WORD_TIMES`` words."""
    out: list[dict] = []
    for text, start, end in segments:
        out.extend(estimate_word_times(text, end - start, start))
        if len(out) >= MAX_WORD_TIMES:
            return out[:MAX_WORD_TIMES]
    return out
