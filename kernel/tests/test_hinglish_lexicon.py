"""The Hinglish word tables as data: the kernel reads config/hinglish-lexicon.json, the same file the renderer
imports, and must read the same 40 sample lines the same way (core/__tests__/hinglish-lexicon-data.test.ts)."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hinglish_lexicon as lex  # noqa: E402

# Keep in step with SAMPLES in core/__tests__/hinglish-lexicon-data.test.ts (line, declared, language, romanised).
SAMPLES = [
    ("ruko ruko ruko", "en", "hi-en", True),
    ("ruko aur dekh lo", "en", "hi-en", True),
    ("rukiye abhi batao", "en", "hi-en", True),
    ("dekhne do mujhe", "en", "hi-en", True),
    ("batao suno bolo", "en", "hi-en", True),
    ("haan theek hai", "en", "hi-en", True),
    ("kya kar rahe ho", "en", "hi-en", True),
    ("nahin achha nahi", "en", "hi-en", True),
    ("mujhe ji nahin chahiye", "en", "hi-en", True),
    ("kal subah meeting hai", "en", "hi-en", True),
    ("aap kaise ho", "en", "hi-en", True),
    ("ruko ek minute", "en", "hi-en", True),
    ("jaldi karo bhai", "en", "hi-en", True),
    ("dekh kya raha hai", "en", "hi-en", True),
    ("mera kaam ho gaya", "en", "hi-en", True),
    ("open the report", "en", "en", False),
    ("what time is it", "en", "en", False),
    ("stop the music please", "en", "en", False),
    ("wait one moment", "en", "en", False),
    ("play my favourite song", "en", "en", False),
    ("send the mail to Rahul", "en", "en", False),
    ("do you see the file", "en", "en", False),
    ("turn on the lights", "en", "en", False),
    ("read my last message", "en", "en", False),
    ("cancel the meeting tomorrow", "en", "en", False),
    ("रुको", "en", "hi", False),
    ("हाँ ठीक है", "en", "hi", False),
    ("कल की meeting cancel करो", "en", "hi-en", False),
    ("open करो file", "en", "hi-en", False),
    ("ठीक", "", "hi", False),
    ("ruko", "hi", "hi", False),
    ("ruko", "", "en", False),
    ("hmm", "en", "en", False),
    ("ok", "hi-en", "hi-en", False),
    ("12345", "hi", "hi", False),
    ("", "", "", False),
    ("ruko ruko ruko", "hi", "hi", True),
    ("open the report", "hi", "hi", False),
    ("kal subah meeting hai", "hi-en", "hi-en", True),
    ("wait one moment", "hi-en", "hi-en", False),
]

PINNED_LINES = 308
PINNED_HASH = "739c3b0fb4d9ce2660ccc89111eff59014cddcc2e2faf4a94059cc899448fba2"


def test_forty_sample_lines_read_the_same_as_the_renderer():
    assert len(SAMPLES) == 40
    for line, declared, lang, romanised in SAMPLES:
        assert lex.detect_turn_language(line, declared) == {"lang": lang, "romanised": romanised}, line


def test_thresholds_match_the_renderer():
    assert lex.ROMAN_HINGLISH_SHARE == 0.3
    assert lex.SHORT_TURN_WORDS == 3


def test_stop_look_and_answer_words_are_hindi():
    for w in ["ruko", "rukiye", "rukna", "dekh", "dekhne", "batao", "suno", "bolo", "kya", "nahi", "nahin"]:
        assert lex.label_languages([w]) == ["hi"], w
    for w in ["haan", "han", "achha", "accha", "theek", "thik", "ji"]:
        assert lex.label_languages([w]) == ["hi"], w


def test_tail_and_backchannel_tables_are_shared_data():
    for w in ["aur", "ki", "ke", "ko", "toh", "matlab", "ya", "jaise", "kyunki", "lekin", "और", "and"]:
        assert w in lex.DANGLING_TAIL_WORDS, w
    for w in ["haan", "nahi", "ji", "theek", "achha", "hmm", "जी"]:
        assert w in lex.BACKCHANNEL_WORDS, w
    assert "ruko" not in lex.DANGLING_TAIL_WORDS


def test_table_hash_is_pinned_and_matches_the_renderer():
    root = Path(__file__).resolve().parents[2]
    data = json.loads((root / "config" / "hinglish-lexicon.json").read_text(encoding="utf-8"))
    assert data["version"] == lex.LEXICON_VERSION == "hinglish-lex-2"
    lines = lex.table_lines()
    assert lines == sorted(lines)
    assert len(lines) == PINNED_LINES
    assert lex.table_hash() == hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest() == PINNED_HASH
