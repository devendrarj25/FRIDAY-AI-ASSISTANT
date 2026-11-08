"""Language and script spans for speech.

A sentence such as ``open Chrome करो और report भेजो`` holds two scripts. It is
never "unsupported": it is cut into a few phrase-sized spans, each tagged with
the voice language that reads it best (``hi`` for Devanagari, ``en`` for
Latin), and the spans stay in the order they were written.

Rules:
  * the cut follows the script, not the word, so a clause is one request;
  * a run of fewer than ``MIN_SPAN_WORDS`` words is folded into its neighbour,
    so a lone English noun inside a Hindi clause is not a request of its own;
  * digits, punctuation and spaces belong to the span they sit in;
  * the number of spans is bounded (``MAX_SPANS``), the rest joins the last one.

Roman Hindi (Hindi written in Latin letters) cannot be told from English by
script. ``roman_hindi_ratio`` reports how much of a Latin span is common Hindi
vocabulary so a caller can choose a different path; it is a word-list
heuristic, not a language model.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MIN_SPAN_WORDS = 2
MAX_SPANS = 8

_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_LATIN = re.compile(r"[A-Za-z]")

# Common Hindi words as people type them in Latin letters. A hint only.
_ROMAN_HINDI = frozenset(
    """
    aap ab abhi acha accha aur bahut baat bhi chahiye dena do haan hai hain ho
    hoga hum ka kaam kab kaise kaun kar karo kare karna kya ke ki ko kuch kyun
    mai main mera meri mere mujhe nahi nahin naam par pehle phir raha rahi
    ruko ruk se suno tum tumhe tumhara ye yeh wo woh yahan wahan zara jao
    jaao batao bata bana banao bhej bhejo dekho khol kholo band dikhao lo
    """.split()
)


@dataclass(frozen=True)
class Span:
    text: str
    lang: str  # "hi" | "en"
    script: str  # "devanagari" | "latin" | "neutral"


def _script_of(ch: str) -> str:
    if _DEVANAGARI.match(ch):
        return "devanagari"
    if _LATIN.match(ch):
        return "latin"
    return "neutral"


def _lang_of(script: str) -> str:
    return "hi" if script == "devanagari" else "en"


def _words(text: str) -> int:
    return len(re.findall(r"[\wऀ-ॿ]+", text))


def roman_hindi_ratio(text: str) -> float:
    """Share (0..1) of the Latin words that are common Hindi vocabulary."""
    words = [w.lower() for w in re.findall(r"[A-Za-z]+", text)]
    if not words:
        return 0.0
    return sum(1 for w in words if w in _ROMAN_HINDI) / len(words)


def _raw_runs(text: str) -> list[list[str]]:
    """Cut by script. Neutral characters stay with the run they follow."""
    runs: list[list[str]] = []
    for ch in text:
        script = _script_of(ch)
        if not runs:
            runs.append([ch, script])
            continue
        if script == "neutral" or script == runs[-1][1] or runs[-1][1] == "neutral":
            runs[-1][0] += ch
            if runs[-1][1] == "neutral" and script != "neutral":
                runs[-1][1] = script
        else:
            runs.append([ch, script])
    return runs


def segment(text: str, requested: str = "") -> list[Span]:
    """Ordered spans for ``text``. Empty text gives no spans."""
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    runs = _raw_runs(cleaned)
    spans = [Span(r[0], _lang_of(r[1]), r[1]) for r in runs]
    if all(s.script == "neutral" for s in spans):
        raw = (requested or "").lower().replace("_", "-")
        lang = "hi" if raw.startswith("hi") else "en"
        return [Span(cleaned, lang, "neutral")]

    # Fold short runs into the neighbour that came before them (or after, for the first).
    merged: list[Span] = []
    for span in spans:
        if merged and (_words(span.text) < MIN_SPAN_WORDS or merged[-1].lang == span.lang):
            prev = merged[-1]
            merged[-1] = Span(prev.text + span.text, prev.lang, prev.script)
        else:
            merged.append(span)
    if len(merged) > 1 and _words(merged[0].text) < MIN_SPAN_WORDS:
        head, nxt = merged[0], merged[1]
        merged[0:2] = [Span(head.text + nxt.text, nxt.lang, nxt.script)]
    # Neighbours can share a language after folding.
    joined: list[Span] = []
    for span in merged:
        if joined and joined[-1].lang == span.lang:
            prev = joined[-1]
            joined[-1] = Span(prev.text + span.text, prev.lang, prev.script)
        else:
            joined.append(span)
    if len(joined) > MAX_SPANS:
        tail = "".join(s.text for s in joined[MAX_SPANS - 1 :])
        last = joined[MAX_SPANS - 1]
        joined = [*joined[: MAX_SPANS - 1], Span(tail, last.lang, last.script)]
    return [Span(s.text.strip(), s.lang, s.script) for s in joined if s.text.strip()]


def dominant_lang(text: str, requested: str = "") -> str:
    """One language for the whole text: the script with more letters wins."""
    deva = len(_DEVANAGARI.findall(text or ""))
    latin = len(_LATIN.findall(text or ""))
    if deva or latin:
        return "hi" if deva >= latin else "en"
    raw = (requested or "").lower().replace("_", "-")
    return "hi" if raw.startswith("hi") else "en"
