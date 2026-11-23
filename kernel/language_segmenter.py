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


# ---- Sentence cuts (mirror of `splitSentences` and `endsInOpenDot` in language-segmenter.ts) ----

_SENTENCE_END = re.compile("(?<=[.!?।॥\n])\\s+")

# Words that end in a dot without ending the sentence ("Please ask Dr. Singh"). Same table as the TypeScript one.
ABBREVIATIONS = frozenset(
    "dr mr mrs ms prof sr jr st vs etc approx no fig eg ie am pm inc ltd co rs govt dept डॉ प्रो".split()
)

# Only the end of a text decides whether its last dot is open, so a check never reads more than this.
_TAIL_WINDOW = 64
_TAIL_WORD = re.compile("([\u0900-\u097fA-Za-z.]+)\\Z")
_DOTTED_INITIALISM = re.compile("[A-Za-z](?:\\.[A-Za-z])+")
_INITIAL = re.compile("(?:^|[\\s(])[A-Z]\\Z")
_PRONOUN_I = re.compile("(?:^|[\\s(])I\\Z")
_LIST_NUMBER = re.compile("\n\\s*[0-9]{1,2}\\Z")
_LIST_NUMBER_WHOLE = re.compile("\\s*[0-9]{1,2}\\Z")


def _open_dot_tail(tail: str, whole: bool) -> bool:
    """Is the last dot of ``tail`` (the end of a text, trailing space cut, at most 64 characters) an open one?"""
    if not tail.endswith("."):
        return False
    before = tail[:-1]
    found = _TAIL_WORD.search(before)
    word = found.group(1) if found else ""
    # A word that fills a cut window may be the end of something longer: not an abbreviation.
    if word and (whole or len(word) < len(before)):
        if word.replace(".", "").lower() in ABBREVIATIONS:
            return True
        if _DOTTED_INITIALISM.fullmatch(word):
            return True
    if _INITIAL.search(before) and not _PRONOUN_I.search(before):
        return True
    if _LIST_NUMBER.search(before):
        return True
    return whole and _LIST_NUMBER_WHOLE.fullmatch(before) is not None


def ends_in_open_dot(text: str) -> bool:
    """Does the text end with a dot that is no sentence end: Dr., Rs., p.m., an initial or a list number?"""
    cut = (text or "").rstrip()
    return _open_dot_tail(cut[-_TAIL_WINDOW:], len(cut) <= _TAIL_WINDOW)


def split_sentences(text: str) -> list[str]:
    """Cut text into sentences, putting a piece that ends in an open dot back with the one after it. One pass."""
    if not text:
        return []
    out: list[str] = []
    carry: list[str] = []
    tail = ""
    length = 0
    for raw in _SENTENCE_END.split(text):
        joined = f"{tail} {raw}" if carry else raw
        cut = joined.rstrip()
        tail = cut[-_TAIL_WINDOW:]
        length = (length + 1 if carry else 0) + len(raw)
        trimmed_length = length - (len(joined) - len(cut))
        carry.append(raw)
        if _open_dot_tail(tail, trimmed_length <= _TAIL_WINDOW) and not raw.endswith("\n"):
            continue
        out.append(" ".join(carry))
        carry = []
    if carry:
        out.append(" ".join(carry))
    return out


# ---- Transcript script policy (mirror of `scriptPolicy` in language-segmenter.ts) ----

# A Devanagari word, a Latin word (apostrophes inside stay), or a number. The danda is punctuation, not a letter.
_POLICY_WORD = re.compile("[ऀ-ॣॱ-ॿ]+|[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9०-९]+(?:[.,][0-9०-९]+)*")
_APOSTROPHE_TAIL = re.compile("['’].*$")


def _roman_key(word: str) -> str:
    return _APOSTROPHE_TAIL.sub("", word.lower())


def _is_roman_hindi(latin: list[str]) -> bool:
    """Roman Hindi: at least two common Hindi words, and they are half or more of the Latin words."""
    hits = sum(1 for w in latin if _roman_key(w) in _ROMAN_HINDI)
    return hits >= 2 and hits * 2 >= len(latin)


def script_policy(text: str, requested: str = "") -> dict:
    """Script policy for a transcript, as plain data (same keys and values as the TypeScript ``scriptPolicy``).

    Hindi stays in Devanagari, English words and names stay in Latin, and the text is returned as spoken. Each
    segment (a sentence) is tagged ``hi``, ``en`` or ``mixed``. Hindi written in Latin letters is never turned into
    Devanagari without a model: it is reported as ``roman-hindi`` so speech or recognition can decide.
    """
    cleaned = (text or "").strip()
    raw = (requested or "").lower().replace("_", "-")
    fallback = "hi" if raw.startswith("hi") else "en"
    segments: list[dict] = []
    # A line is a break, and so is a sentence end that is not an abbreviation, an initial or a time (Dr. Sharma).
    pieces = [piece for line in cleaned.split("\n") for piece in split_sentences(line)] if cleaned else []
    for piece in pieces:
        seg = piece.strip()
        if not seg:
            continue
        found = _POLICY_WORD.findall(seg)
        latin = [w for w in found if _LATIN.search(w)]
        roman = bool(latin) and _is_roman_hindi(latin)
        words = []
        for w in found:
            if _DEVANAGARI.search(w) and not re.search("[०-९]", w):
                words.append({"text": w, "kind": "hi"})
            elif _LATIN.search(w):
                hindi = roman and _roman_key(w) in _ROMAN_HINDI
                words.append({"text": w, "kind": "roman-hindi" if hindi else "en"})
            else:
                words.append({"text": w, "kind": "number"})
        has_hi = any(w["kind"] == "hi" for w in words)
        has_en = any(w["kind"] in ("en", "roman-hindi") for w in words)
        lang = "mixed" if has_hi and has_en else "hi" if has_hi else "en" if has_en else fallback
        if has_hi and has_en:
            script = "mixed"
        elif has_hi:
            script = "devanagari"
        elif roman:
            script = "roman-hindi"
        elif has_en:
            script = "latin"
        else:
            script = "neutral"
        segments.append({"text": seg, "lang": lang, "script": script, "words": words})
    langs = {s["lang"] for s in segments}
    lang = "mixed" if len(langs) > 1 or "mixed" in langs else (segments[0]["lang"] if segments else fallback)
    roman_any = any(
        s["script"] == "roman-hindi" or any(w["kind"] == "roman-hindi" for w in s["words"]) for s in segments
    )
    return {"text": cleaned, "lang": lang, "romanHindi": roman_any, "segments": segments}
