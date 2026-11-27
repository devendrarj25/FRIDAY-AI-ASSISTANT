"""Hindi and English word tables for one spoken turn, read from ``config/hinglish-lexicon.json``.

The renderer imports the same file in ``src/lib/friday/voice-engine/hinglish-lexicon.ts``; ``detect_turn_language``
mirrors its ``detectTurnLanguage`` and ``table_hash`` is the hash its ``lexiconDataLines`` gives, so the two sides read
every line the same way. Pure: no model, no network, no clock. ``stt_bench.py`` keeps its own older copy of the
scored tables until its pinned digest moves.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path

_PATH = Path(__file__).resolve().parent.parent / "config" / "hinglish-lexicon.json"
_DATA = json.loads(_PATH.read_text(encoding="utf-8"))

LEXICON_VERSION: str = _DATA["version"]
ROMAN_HINGLISH_SHARE: float = _DATA["thresholds"]["romanHinglishShare"]
SHORT_TURN_WORDS: int = _DATA["thresholds"]["shortTurnWords"]

_DEVANAGARI = re.compile("[ऀ-ॿ]")


def lexicon_key(word: str) -> str:
    """A word on its lexicon key: NFC, lower case, the nukta dropped and the chandrabindu written as the anusvara."""
    return unicodedata.normalize("NFC", word).lower().replace("़", "").replace("ँ", "ं")


def _spellings(pairs: list[list[str]]) -> dict[str, str]:
    return {v: second for first, second in pairs for v in first.split("|")}


_SURE = _spellings(_DATA["sureHindi"]) | _spellings(_DATA["sureHindiAdded"])
_AMBIGUOUS = {first: second for first, second in _DATA["ambiguous"]}
_LOAN = {lexicon_key(s): latin for latin, spellings in _DATA["loanwords"] for s in spellings.split("|")}


def _word_set(table: dict[str, list[str]]) -> frozenset[str]:
    return frozenset(unicodedata.normalize("NFC", w).lower() for group in table.values() for w in group)


DANGLING_TAIL_WORDS: frozenset[str] = _word_set(_DATA["tailWords"])
BACKCHANNEL_WORDS: frozenset[str] = _word_set(_DATA["backchannel"])


def table_lines() -> list[str]:
    """Every table as sorted lines, the same lines ``lexiconDataLines`` builds in the renderer."""
    lines = {f"sure|{k}|{v}" for k, v in _SURE.items()}
    lines |= {f"ambiguous|{k}|{v}" for k, v in _AMBIGUOUS.items()}
    lines |= {f"loan|{k}|{v}" for k, v in _LOAN.items()}
    lines |= {f"tail|{w}" for w in DANGLING_TAIL_WORDS}
    lines |= {f"backchannel|{w}" for w in BACKCHANNEL_WORDS}
    return sorted(lines)


def table_hash() -> str:
    """sha256 of the table lines joined with a newline, UTF-8."""
    return hashlib.sha256("\n".join(table_lines()).encode("utf-8")).hexdigest()


def _first_pass(core: str) -> dict:
    if not any(unicodedata.category(c).startswith("L") for c in core):
        return {"lang": "none"}
    key = lexicon_key(core)
    if _DEVANAGARI.search(key):
        return {"lang": "en"} if key in _LOAN else {"lang": "hi"}
    if key in _SURE:
        return {"lang": "hi"}
    if key in _AMBIGUOUS:
        return {"lang": "en", "maybe": True}
    return {"lang": "en"}


def label_languages(cores: list[str]) -> list[str]:
    """Hindi, English or none for each word. A Devanagari loanword is English, a sure Roman Hindi word is Hindi."""
    first = [_first_pass(c) for c in cores]
    out = []
    for i, kind in enumerate(first):
        if not kind.get("maybe"):
            out.append(kind["lang"])
            continue
        beside = (i > 0 and first[i - 1]["lang"] == "hi") or (i + 1 < len(first) and first[i + 1]["lang"] == "hi")
        out.append("hi" if beside else "en")
    return out


def _core(piece: str) -> str:
    end = len(piece)
    start = 0
    while start < end and unicodedata.category(piece[start])[0] not in "LMN":
        start += 1
    while end > start and unicodedata.category(piece[end - 1])[0] not in "LMN":
        end -= 1
    return piece[start:end]


def detect_turn_language(text: str, declared: str = "") -> dict:
    """The language of one turn, as ``detectTurnLanguage`` reads it: Devanagari is Hindi, both scripts are Hinglish,
    and Latin text with at least ``ROMAN_HINGLISH_SHARE`` sure Roman Hindi words is romanised Hinglish. A declared
    Hindi or Hinglish ear is kept; lines under ``SHORT_TURN_WORDS`` words and lines without letters keep the
    declared language."""
    text = str(text)
    deva = sum(1 for ch in text if _DEVANAGARI.match(ch))
    latin = sum(1 for ch in text if "A" <= ch <= "Z" or "a" <= ch <= "z")
    if deva and latin:
        return {"lang": "hi-en", "romanised": False}
    if deva:
        return {"lang": "hi", "romanised": False}
    if not latin:
        return {"lang": declared, "romanised": False}
    cores = [c for c in (_core(p) for p in text.split()) if any(unicodedata.category(ch).startswith("L") for ch in c)]
    if len(cores) < SHORT_TURN_WORDS:
        return {"lang": declared or "en", "romanised": False}
    kept = declared if declared in ("hi", "hi-en") else ""
    if label_languages(cores).count("hi") / len(cores) >= ROMAN_HINGLISH_SHARE:
        return {"lang": kept or "hi-en", "romanised": True}
    return {"lang": kept or "en", "romanised": False}
