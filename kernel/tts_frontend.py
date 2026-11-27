"""FRIDAY Voice frontend: a reply in, clauses out, ready for the speaking engine. Standard library only.

The renderer already prepares a reply for speech (``src/lib/friday/voice-engine``: markup, numbers, rupees, dates,
the pronunciation dictionary, English words and Roman Hindi in Devanagari). This module does not repeat that work.
It guards what is left and cuts the text into the pieces the engine reads one at a time, so the first piece can
play while the next is made.

Interface contract
------------------
* ``prepare(text, lang_hint="", first_words=5, *, indexer=None, roman_strategy=None) -> list[Clause]``: the whole
  reply as clauses. ``indexer`` is the engine's character table (``unicode_indexer.json``); with it a character the
  engine cannot read is removed, without it a built-in safe set is used. ``lang_hint`` (``hi``, ``hi-IN``,
  ``hinglish``, ``en``...) only decides a clause with no letters.
* ``clauses(text_iter, lang_hint="", first_words=5, *, indexer=None, roman_strategy=None)``: the same for text that
  arrives in fragments (model tokens). A clause is yielded as soon as it is closed; the unfinished tail is kept. For
  any fragmentation the clauses are exactly those of ``prepare`` on the joined text.
* ``Clause``: ``text`` (what the engine reads), ``lang`` (``hi``, ``en`` or ``na``), ``pause_ms`` (silence the joiner
  puts after it), ``first`` (the first clause of the reply) and ``spans`` (language spans, for a caller that wants to
  read each span in its own language).
* ``clause_key(text, lang, voice_id, recipe_version, speed)``: stable SHA-256 hex for caches.
* ``ACKS``, ``ack`` and ``ack_clause``: short acknowledgement phrases as data, for a later pre-render cache.
* ``roman_to_devanagari(text)``: Hindi written in Latin letters turned into Devanagari (tables from ``text_norm``).

Rules
-----
* Markdown, links, URLs, emoji and characters the engine cannot read are removed. Devanagari digits become digits.
* A sentence ends at ``. ? ! ...`` or the danda followed by a space, never after an abbreviation, an initial, a
  decimal point or a list number, and always at a line break. Two line breaks are a paragraph.
* One sentence is one clause when it fits in ``CLAUSE_SOFT_CHARS``. A longer one is cut at commas, semicolons and
  colons, and when a piece is still too long at a word, never inside a word. A cut the writer did not mark ends in a
  comma so the voice keeps going. A word longer than ``MAX_WORD_CHARS`` is junk (a hash, a blob) and is dropped.
* The first clause is short so speech starts early: when the first sentence has more than ``FIRST_SPLIT_MIN_WORDS``
  words, its first ``first_words`` words (three to six, at a comma when there is one, one or two more when the cut
  would fall on an article or a preposition) are a clause of their own.
* Digits that survive are read in the clause language (Hindi 0 to 99 from a table, then sau, hazaar, lakh and crore).
* Roman Hindi (Latin letters, mostly common Hindi words) is handled by ``ROMAN_HINDI_STRATEGY``. With the default
  strategy only the Hindi words of such a clause are written in Devanagari; English words (``alarm``, ``set``,
  ``temperature``) stay in Latin letters, and the clause is read by the Hindi voice.
* A number is read in the language of the word after it, else the word before it (the renderer's script policy), and
  only a number with no word beside it takes the clause language. ``Rs.`` and ``₹`` are rupees, ``km``, ``kg``, ``GB``
  and the like are spoken as words, in the language of the number.

A sentence is yielded when it is closed (the next sentence has started, or the text ended); only a long first
sentence is cut early, because speech should not wait for it.
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, replace

import hinglish_lexicon as lexicon
import text_norm
from language_segmenter import _ROMAN_HINDI, Span, ends_in_open_dot, segment

# ---- constants -------------------------------------------------------------------------------------------------

PAUSE_MS = {
    "comma": 110, "semicolon": 150, "colon": 150, "period": 240, "question": 280, "ellipsis": 380, "paragraph": 420,
    "cut": 60,
}  # fmt: skip
CLAUSE_SOFT_CHARS = 140
CLAUSE_HARD_CHARS = 300
MAX_WORD_CHARS = 80
FIRST_SPLIT_MIN_WORDS = 9
FIRST_WORDS_RANGE = (3, 6)
SPEECH_LANGS = ("hi", "en", "na")

# What to do with Hindi written in Latin letters: "devanagari" (write it in Devanagari, read it as Hindi), "latin-en"
# (as written, English voice), "latin-na" (as written, unknown language) or "latin-hi" (as written, Hindi voice).
# Measured 2026-11-26 on 30 Roman Hindi sentences (voice F2, 5 steps, fixed seed), each spoken and written back by
# the Hindi ear and by faster-whisper small, character error rate against the Devanagari sentence:
#   devanagari 1.4% (ear) 19.1% (whisper) | latin-hi 22.3% / 34.7% | latin-na 28.2% / 37.9% | latin-en 30.8% / 43.9%
# With the text_norm rules alone and no override table the "devanagari" ear figure is 6.8%, still the best by far.
ROMAN_HINDI_STRATEGY = "devanagari"
ROMAN_HINDI_STRATEGIES = ("devanagari", "latin-en", "latin-na", "latin-hi")
# A clause with Devanagari and Latin words: "hindi" (read as Hindi unless the Latin words are more than twice the
# Devanagari ones), "dominant" (the script with more words, a tie goes to Hindi) or "na" (unknown language).
# Measured 2026-11-26 on 15 Hindi sentences with English words in them (Hindi voice F2, 5 steps, fixed seed), spoken
# and written back by the Hindi ear and by faster-whisper small, character error rate against the Devanagari sentence:
#   whole clause "hi" 3.4% (ear) 23.1% (whisper) | each span in its own language 6.5% / 26.0% | whole clause "na"
#   7.0% / 26.2% | English words rewritten in Devanagari by rule 17.9% / 28.0%.
MIXED_POLICY = "hindi"

_FUNCTION_WORDS = frozenset(
    "a an the of to in on at for and or but with by from as is are was were be that this it its my your our their "
    "about into onto over under near than then if so because while when "
    "ke ki ka ko se me mein par aur ya ki ek "
    "के की का को से में पर और या कि एक".split()
)  # fmt: skip

# ---- character policy ------------------------------------------------------------------------------------------

_EMOJI = re.compile(
    "[\U0001f600-\U0001f64f\U0001f300-\U0001f5ff\U0001f680-\U0001f6ff\U0001f700-\U0001f77f\U0001f780-\U0001f7ff"
    "\U0001f800-\U0001f8ff\U0001f900-\U0001f9ff\U0001fa00-\U0001fa6f\U0001fa70-\U0001faff☀-⛿✀-➿"
    "\U0001f1e6-\U0001f1ff\U0001f3fb-\U0001f3ff️⃣‍]+"
)
_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿­‎‏"))
_DEVANAGARI_DIGITS = {ord("०") + i: str(i) for i in range(10)}
_QUOTES = str.maketrans({"‘": "'", "’": "'", "´": "'", "`": "", "“": '"', "”": '"', "«": '"', "»": '"', "„": '"'})
_SPACE_MARKS = str.maketrans(dict.fromkeys(map(ord, "     　\t\x0b\x0c"), " "))
_DASH = re.compile(r"\s*[–—―]+\s*|(?:(?<=\s)|^)-+(?=\s|$)\s*")
_RULE = re.compile(r"[-=*_~]{3,}")
_HEADING = re.compile(r"^\s{0,3}#{1,6}[ \t]+")
_LIST_MARK = re.compile(r"^\s*(?:[-*+•▪●◦‣]|\d{1,2}[.)]|>+)[ \t]+")
_LINK_TARGET = re.compile(r"\]\([^)\s]*\)")
_URL = re.compile(r"(?:https?://|www\.)\S*?(?=[.,;:!?)\]'\"”’]*(?:\s|$))", re.IGNORECASE)
_TAG = re.compile(r"</?[A-Za-z][A-Za-z0-9]*/?>")
_MARKUP_CHARS = str.maketrans({"*": " ", "~": " ", "_": " ", "#": " ", "[": " ", "]": " ", "|": " ", "\\": " "})
_SAFE_ASCII = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n.,;:!?'\"-()%$&+/₹।॥")
_LAST_WS = re.compile(r"\s(?=\S*\Z)")


def _readable(ch: str, indexer: list[int] | None) -> bool:
    """Can the engine read this one character?"""
    if indexer is not None:
        return ord(ch) < len(indexer) and indexer[ord(ch)] >= 0
    return ch in _SAFE_ASCII or "ऀ" <= ch <= "ॿ"


def _char_policy(text: str, indexer: list[int] | None) -> str:
    """Quotes, dashes and the like in one form, then each character the engine cannot read out. Newlines stay."""
    text = text.translate(_ZERO_WIDTH).translate(_QUOTES).translate(_SPACE_MARKS).translate(_DEVANAGARI_DIGITS)
    text = _DASH.sub(", ", text).replace("…", "...").replace("@", " at ")
    out: list[str] = []
    for ch in text:
        if ch == "\n":
            out.append(ch)
            continue
        if ch.isspace():
            out.append(" ")
            continue
        if ch.isdigit() and not ch.isascii():
            digit = unicodedata.digit(ch, -1)
            out.append(str(digit) if digit >= 0 else " ")
            continue
        for part in unicodedata.normalize("NFKD", ch):
            if unicodedata.category(part) == "Mn" and not "ऀ" <= part <= "ॿ":
                continue  # an accent: the plain letter stays
            out.append(part if _readable(part, indexer) else " ")
    return "".join(out)


class _Sanitizer:
    """Markdown, links, URLs, emoji and unreadable characters out, a chunk at a time.

    A chunk always ends after a whitespace character, so no token is cut. The only state between chunks is whether the
    next text starts a line, whether a code fence is open and whether the rest of a fence line is still to be
    dropped, so the result does not depend on where chunks end.
    """

    def __init__(self, indexer: list[int] | None) -> None:
        self.indexer = indexer
        self.line_start = True
        self.in_fence = False
        self.skip_line = False

    def feed(self, chunk: str) -> str:
        out: list[str] = []
        for seg in re.findall(r"[^\n]*\n|[^\n]+", chunk.replace("\r", " ")):
            newline = seg.endswith("\n")
            body = seg[:-1] if newline else seg
            fence = body.lstrip().startswith("```")
            if self.skip_line:
                body, newline_out = "", False
            elif self.in_fence or (self.line_start and fence):
                if self.line_start and fence:
                    self.in_fence = not self.in_fence
                    self.skip_line = True  # the rest of a fence line is not text either
                body, newline_out = "", False  # a code line leaves nothing, not even its line break
            else:
                body, newline_out = self._inline(body, self.line_start), newline
            if newline:
                self.skip_line = False
            out.append(body + ("\n" if newline_out else ""))
            self.line_start = newline or (self.line_start and not seg.strip())  # spaces alone do not end the start
        return "".join(out)

    def _inline(self, body: str, line_start: bool) -> str:
        if line_start:
            heading = _HEADING.sub("", body, count=1)
            body = heading if heading != body else _LIST_MARK.sub("", body, count=1)
        body = _LINK_TARGET.sub(" ", body)
        body = _URL.sub(" ", body)
        body = _TAG.sub(" ", body)
        body = _EMOJI.sub(" ", body)
        body = body.replace("`", "")
        body = _RULE.sub(" ", body).translate(_MARKUP_CHARS)
        return _char_policy(body, self.indexer)


# ---- numbers that speech preparation missed ---------------------------------------------------------------------

_HI_UNDER_100 = (
    "शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस "
    "इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस "
    "इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस "
    "इकतालीस बयालीस तैंतालीस चौवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास "
    "इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ "
    "इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर "
    "इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी "
    "इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे "
    "इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे"
)
HI_NUMBERS = tuple(_HI_UNDER_100.split())
_EN_ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
    "seventeen eighteen nineteen"
).split()
_EN_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
NUMBER_LIMIT = 10**9  # beyond this the digits are read one by one

_UNITS = r"km/h|kmph|kph|km|kg|cm|mm|ms|gb|mb|kb|tb|hz|per\s?cent|percent"
_NUMBER = re.compile(
    r"(?P<hour>\d{1,2}):(?P<minute>\d{2})(?!\d)"
    r"|(?P<pre>₹|\$|\bRs\.?\s?|\bINR\s?)?"
    r"(?P<num>\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?P<post>\s?%)?"
    rf"(?:\s?(?P<unit>{_UNITS})(?![A-Za-z]))?",
    re.IGNORECASE,
)
_WORDS = {
    "en": {"rupee": "rupees", "dollar": "dollars", "percent": "percent", "point": "point", "oclock": "o'clock"},
    "hi": {"rupee": "रुपये", "dollar": "डॉलर", "percent": "प्रतिशत", "point": "दशमलव", "oclock": "बजे"},
}
# A unit written short, as words: English (singular, plural) and Hindi (one form).
_UNIT_WORDS = {
    "en": {
        "km": ("kilometre", "kilometres"), "kg": ("kilogram", "kilograms"), "cm": ("centimetre", "centimetres"),
        "mm": ("millimetre", "millimetres"), "ms": ("millisecond", "milliseconds"), "gb": ("gigabyte", "gigabytes"),
        "mb": ("megabyte", "megabytes"), "kb": ("kilobyte", "kilobytes"), "tb": ("terabyte", "terabytes"),
        "hz": ("hertz", "hertz"), "km/h": ("kilometre per hour", "kilometres per hour"),
    },
    "hi": {
        "km": "किलोमीटर", "kg": "किलोग्राम", "cm": "सेंटीमीटर", "mm": "मिलीमीटर", "ms": "मिलीसेकंड",
        "gb": "गीगाबाइट", "mb": "मेगाबाइट", "kb": "किलोबाइट", "tb": "टेराबाइट", "hz": "हर्ट्ज़",
        "km/h": "किलोमीटर प्रति घंटा",
    },
}  # fmt: skip
_UNIT_ALIASES = {"kmph": "km/h", "kph": "km/h"}


def _en_below_100(n: int) -> str:
    if n < 20:
        return _EN_ONES[n]
    return _EN_TENS[n // 10] + (f" {_EN_ONES[n % 10]}" if n % 10 else "")


def _en_below_1000(n: int) -> str:
    parts = []
    if n >= 100:
        parts.append(f"{_EN_ONES[n // 100]} hundred")
    if n % 100:
        parts.append(_en_below_100(n % 100))
    return " ".join(parts)


def say_number(n: int, lang: str) -> str:
    """A whole number in words, Indian grouping (thousand, lakh, crore). ``lang`` ``hi`` is Hindi, else English."""
    if n < 0 or n >= NUMBER_LIMIT:
        return _digits(str(n), lang)
    hindi = lang == "hi"
    if n == 0:
        return HI_NUMBERS[0] if hindi else "zero"
    below = (lambda k: HI_NUMBERS[k]) if hindi else _en_below_100
    units = ("करोड़", "लाख", "हज़ार") if hindi else ("crore", "lakh", "thousand")
    parts: list[str] = []
    for size, unit in zip((10**7, 10**5, 10**3), units, strict=True):
        count = (n // size) % 100
        if count:
            parts.append(f"{below(count)} {unit}")
    rest = n % 1000
    if rest >= 100:
        parts.append(f"{HI_NUMBERS[rest // 100] if hindi else _EN_ONES[rest // 100]} {'सौ' if hindi else 'hundred'}")
    if rest % 100:
        parts.append(below(rest % 100))
    return " ".join(parts)


def _digits(text: str, lang: str) -> str:
    table = HI_NUMBERS if lang == "hi" else _EN_ONES
    return " ".join(table[int(d)] for d in text if d.isdigit())


def _number_words(raw: str, lang: str) -> str:
    whole, _, frac = raw.replace(",", "").partition(".")
    if (len(whole) > 1 and whole.startswith("0")) or len(whole) > 9:
        spoken = _digits(whole, lang)  # a phone number, a code, a long id
    else:
        spoken = say_number(int(whole), lang)
    if frac:
        return f"{spoken} {_WORDS['hi' if lang == 'hi' else 'en']['point']} {_digits(frac, lang)}"
    return spoken


def _spoken_number(match: re.Match[str], lang: str) -> str:
    """One ``_NUMBER`` match in words in ``lang`` (``hi`` or English), with its currency, percent or unit."""
    words = _WORDS["hi" if lang == "hi" else "en"]
    if match.group("hour") is not None:
        hour, minute = int(match.group("hour")), int(match.group("minute"))
        if hour > 24 or minute > 59:
            return match.group(0)
        at = say_number(hour, lang)
        return f" {at} {words['oclock']} " if minute == 0 else f" {at} {say_number(minute, lang)} "
    spoken = _number_words(match.group("num"), lang)
    pre = (match.group("pre") or "").strip().rstrip(".").lower()
    if pre:
        spoken += " " + (words["dollar"] if pre == "$" else words["rupee"])
    if match.group("post"):
        spoken += " " + words["percent"]
    unit = re.sub(r"\s", "", (match.group("unit") or "").lower())
    if unit == "percent":
        spoken += " " + words["percent"]
    elif unit:
        unit = _UNIT_ALIASES.get(unit, unit)
        if lang == "hi":
            spoken += " " + _UNIT_WORDS["hi"][unit]
        else:
            single, plural = _UNIT_WORDS["en"][unit]
            spoken += " " + (single if match.group("num") == "1" else plural)
    return f" {spoken} "


def expand_numbers(text: str, lang: str) -> str:
    """Digits, currency, percent, units and clock times left in ``text``, as words in ``lang`` (``hi`` or English)."""
    return _NUMBER.sub(lambda match: _spoken_number(match, lang), text)


# ---- Roman Hindi -----------------------------------------------------------------------------------------------

# Frequent words the rules in text_norm spell in a way people do not (long vowels, nasals, retroflex ones, loanwords).
_ROMAN_PAIRS = (
        "hain=हैं hoon=हूँ ho=हो hai=है tha=था thi=थी the=थे main=मैं mein=में nahi=नहीं nahin=नहीं thoda=थोड़ा "
        "thodi=थोड़ी chahiye=चाहिए chahie=चाहिए wapas=वापस kripya=कृपया darwaza=दरवाज़ा dhanyavaad=धन्यवाद "
        "dhanyawad=धन्यवाद shukriya=शुक्रिया accha=अच्छा acha=अच्छा achha=अच्छा theek=ठीक thik=ठीक raha=रहा rahi=रही "
        "rahe=रहे kuch=कुछ kyun=क्यों kyon=क्यों aapka=आपका aapki=आपकी aapko=आपको tumhe=तुम्हें mujhe=मुझे "
        "unhe=उन्हें inhe=इन्हें hame=हमें hum=हम woh=वह wo=वह yeh=यह ye=यह bahut=बहुत zaroori=ज़रूरी "
        "zaroor=ज़रूर bilkul=बिल्कुल phone=फ़ोन meeting=मीटिंग time=टाइम school=स्कूल coffee=कॉफ़ी "
        "bazaar=बाज़ार bazar=बाज़ार baje=बजे ghar=घर kaam=काम paani=पानी pani=पानी khana=खाना chai=चाय "
        "bachche=बच्चे bacche=बच्चे aaj=आज kal=कल abhi=अभी sab=सब dijiye=दीजिए kijiye=कीजिए kar=कर karo=करो "
        "karunga=करूँगा karungi=करूँगी karna=करना sakte=सकते sakta=सकता sakti=सकती milna=मिलना kaise=कैसे "
        "kahan=कहाँ kab=कब kaun=कौन kitne=कितने kitna=कितना gaya=गया gayi=गई gaye=गए aaya=आया aayega=आएगा "
        "aao=आओ jao=जाओ chalo=चलो dekho=देखो suno=सुनो batao=बताओ bolo=बोलो ruko=रुको dhire=धीरे dheere=धीरे "
        "mera=मेरा meri=मेरी mere=मेरे tera=तेरा tumhara=तुम्हारा uska=उसका usne=उसने ne=ने ko=को se=से "
        "par=पर aur=और ya=या ki=की ka=का ke=के ek=एक do=दो"
)  # fmt: skip
# More words (the rules in text_norm write a virama in the middle of ``lagta`` or ``karte``, which the engine reads as a
# cluster), and the spellings of the words people leave without a long vowel.
_ROMAN_MORE = (
        "haan=हाँ han=हाँ aapke=आपके apna=अपना apne=अपने apni=अपनी nayi=नई naya=नया naye=नए purana=पुराना "
        "purani=पुरानी puraane=पुराने lagta=लगता lagti=लगती lagte=लगते karta=करता karti=करती karte=करते "
        "lijiye=लीजिए liye=लिए kafi=काफ़ी jana=जाना jaana=जाना jaane=जाने jaata=जाता jaati=जाती uthna=उठना uthne=उठने "
        "hamara=हमारा humara=हमारा chahta=चाहता chahti=चाहती chahte=चाहते bhejna=भेजना bhejne=भेजने milta=मिलता "
        "milti=मिलती milte=मिलते rakhna=रखना padhna=पढ़ना padho=पढ़ो khelna=खेलना sochna=सोचना bataiye=बताइए "
        "boliye=बोलिए aaiye=आइए jaiye=जाइए baithiye=बैठिए rukiye=रुकिए kitni=कितनी kyunki=क्योंकि uski=उसकी "
        "unka=उनका unki=उनकी wala=वाला wali=वाली wale=वाले yahan=यहाँ wahan=वहाँ jyada=ज़्यादा zyada=ज़्यादा "
        "shuru=शुरू chalu=चालू isliye=इसलिए karein=करें namaste=नमस्ते paas=पास"
)  # fmt: skip
_ROMAN_OVERRIDES = {
    key: value for key, _, value in (pair.partition("=") for pair in (_ROMAN_PAIRS + " " + _ROMAN_MORE).split())
}
_LATIN_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")


def roman_to_devanagari(text: str) -> str:
    """Every Latin word of ``text`` written in Devanagari: a table for frequent words, the ``text_norm`` rules for
    the rest. Numbers, punctuation and Devanagari text are left as they are."""

    return _LATIN_WORD.sub(lambda match: _devanagari_word(match.group(0)), text)


def _devanagari_word(raw: str) -> str:
    word = raw.lower().replace("'", "")
    if word in _ROMAN_OVERRIDES:
        return _ROMAN_OVERRIDES[word]
    found = text_norm.hinglish_to_devanagari_candidates(word, limit=1)
    return found[0] if found else raw


# Hindi words with no English reading, beyond the short list the segmenter keeps: they make "theek hai" Roman Hindi.
_ROMAN_EVIDENCE = _ROMAN_HINDI | frozenset(
    """
    theek thik shukriya dhanyavaad dhanyawad kripya bilkul zaroor zaroori bahut thoda thodi chahiye wapas kuch kyun
    kyon hoon aapka aapki aapko tumhe unhe inhe hame woh yeh bazaar bazar baje ghar paani pani khana chai bachche
    kahan kitne kitna gaya gayi gaye aaya aayega aao jao chalo dekho suno batao bolo ruko dhire dheere meri mere
    tera tumhara uska usne karunga karungi sakte sakta sakti milna kaise dijiye kijiye samajh dilana yaad kal aaj
    subah raat neend baarish mausam
    """.split()
)


def is_roman_hindi(text: str) -> bool:
    """Latin words, at least two of them common Hindi words and half or more of all (the speech preparation rule)."""
    latin = [w.lower().replace("'", "") for w in _LATIN_WORD.findall(text)]
    hits = sum(1 for w in latin if w in _ROMAN_EVIDENCE)
    return hits >= 2 and hits * 2 >= len(latin)


# ---- Roman Hinglish: Hindi words in Devanagari, English words left alone ------------------------------------------

# Hindi words people type in Latin letters that the shared lexicon does not list (nothing English reads like them).
_HINDI_EXTRA = frozenset(
    """
    nayi naya naye purani purana puraane aapke aapke paas jaana jana jaane jaata jaati dena dene lena lene lagta lagti
    lagte karte karti karta karein kijiye lijiye liye kaafi kafi uthna uthne hota hoti hote hoga hogi honge milta milti
    milte milega milegi bhejna bhejne bhej deti deta dete denge wala wali wale isliye isi uski unka unki hamara humara
    apna apni apne kisi kyunki tak mat sirf sakta sakti sakte chahta chahti chahte rakhna rakho likho padhna padho
    khelna sochna bataiye boliye dikhaiye aaiye jaiye baithiye rukiye kam zyada jyada hamesha kabhi yahan wahan idhar
    udhar kitni kaisa kaisi aisa aisi waisa jaisa jaisi tabhi jabhi abhi
    """.split()
)
# Words of the shared lists that English also uses: not evidence of Hindi.
_HINDI_SHARED = frozenset("ho kar lo bana khol ruk do main mai to me mein hi hai sun chal band hum par ab".split())
_HINDI_STRICT = (frozenset(k for k in lexicon._SURE if k.isascii()) | _HINDI_EXTRA | _ROMAN_EVIDENCE) - _HINDI_SHARED  # pyright: ignore[reportPrivateUsage]
_ENGLISH_LOAN = frozenset(lexicon._LOAN.values())  # pyright: ignore[reportPrivateUsage]
# English words that look or sound like Hindi ones, and the number and unit words this module writes in English.
_ENGLISH_KEEP = (
    _ENGLISH_LOAN
    | frozenset(
        """
        gym wait charger book set temperature degree degrees balance boss april june july august september october
        november december january february march may check checks banana arena antenna lakh crore rupees dollars percent
        point hundred thousand million kilometre kilometres kilogram kilograms centimetres millimetres gigabytes
        megabytes kilobytes terabytes hertz milliseconds
        """.split()
    )
    | frozenset(_EN_ONES)
    | frozenset(_EN_TENS[2:])
)
_HINDI_SHAPE = re.compile(r"(?:iye|ega|egi|ogi|unga|ungi|chh|kh|bh|jh|aa)|(?<=.{3})na\Z")
_ROMAN_HINGLISH_SHARE = lexicon.ROMAN_HINGLISH_SHARE


def _english_word(key: str) -> bool:
    return key in _ENGLISH_KEEP or (key.endswith("s") and key[:-1] in _ENGLISH_KEEP)


def _hindi_roman(raw: str) -> bool:
    """A Latin word that is Hindi: a word of the lists above, or one with a Hindi-only shape (``jaana``, ``lijiye``)."""
    key = raw.lower().replace("'", "")
    if _english_word(key):
        return False
    return key in _HINDI_STRICT or bool(_HINDI_SHAPE.search(key))


def is_roman_hinglish(text: str) -> bool:
    """Latin text with English words in it and at least two sure Hindi words, a third of all words or more."""
    latin = [w.lower().replace("'", "") for w in _LATIN_WORD.findall(text)]
    hits = sum(1 for w in latin if w in _HINDI_STRICT and not _english_word(w))
    return hits >= 2 and hits >= _ROMAN_HINGLISH_SHARE * len(latin)


_ANY_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?|[ऀ-ॿ]+")


def _word_langs(text: str) -> list[tuple[int, int, str]]:
    """Every word of ``text`` (Latin or Devanagari) as ``(start, end, "hi" | "en")``, read as the renderer's lexicon
    reads a turn: a word the lists know is Hindi, an ambiguous one (``hai``, ``hum``) follows a Hindi neighbour."""
    found = list(_ANY_WORD.finditer(text))
    cores = ["kya" if m.group(0).isascii() and _hindi_roman(m.group(0)) else m.group(0) for m in found]
    labels = lexicon.label_languages(cores)
    # A Devanagari word is Hindi even when it is a loanword (the renderer's segmenter reads it so).
    return [(m.start(), m.end(), lang if m.group(0).isascii() else "hi") for m, lang in zip(found, labels, strict=True)]


def _neighbour_lang(words: list[tuple[int, int, str]], start: int, end: int, default: str) -> str:
    """The language of the word after ``end``, else the one before ``start``, else ``default``."""
    for first, _, lang in words:
        if first >= end:
            return lang if lang in ("hi", "en") else default
    for _, last, lang in reversed(words):
        if last <= start:
            return lang if lang in ("hi", "en") else default
    return default


_SPOKEN_TOKEN = re.compile(_NUMBER.pattern + "|(?P<word>" + _ANY_WORD.pattern + ")", re.IGNORECASE)


def _read_clause(text: str, default_lang: str, *, hinglish: bool, unknown_hindi: bool = False) -> str:
    """Numbers in words, each in the language of its neighbour word; with ``hinglish`` the Hindi words of Latin text
    are also written in Devanagari (the table first, then the rules) and the English words are left as they are. A
    word no list knows is Hindi only when ``unknown_hindi`` (most of the sentence is Hindi), else it is left."""
    words = _word_langs(text)
    langs = {start: lang for start, _, lang in words}

    def one(match: re.Match[str]) -> str:
        word = match.group("word")
        if word is None:
            return _spoken_number(match, _neighbour_lang(words, match.start(), match.end(), default_lang))
        if not hinglish or not word.isascii():
            return word
        key = word.lower().replace("'", "")
        if key in _ROMAN_OVERRIDES or (not _english_word(key) and (unknown_hindi or langs.get(match.start()) == "hi")):
            return _devanagari_word(word)
        return word

    return _SPOKEN_TOKEN.sub(one, text)


# ---- language of a clause ----------------------------------------------------------------------------------------

_DEVA_LETTER = re.compile("[ऀ-ॣॱ-ॿ]")
_LATIN_LETTER = re.compile("[A-Za-z]")
_ANY_LETTER = re.compile(r"[^\W\d_]")


def _hint_lang(lang_hint: str) -> str:
    return "hi" if (lang_hint or "").lower().replace("_", "-").startswith(("hi", "hing")) else "en"


def _script_words(text: str) -> tuple[int, int, int]:
    """Words by script: Devanagari, Latin, and any other letters. A word with Devanagari in it is a Devanagari word."""
    deva = latin = other = 0
    for token in text.split():
        if _DEVA_LETTER.search(token):
            deva += 1
        elif _LATIN_LETTER.search(token):
            latin += 1
        elif _ANY_LETTER.search(token):
            other += 1
    return deva, latin, other


def _clause_language(text: str, lang_hint: str) -> tuple[str, tuple[Span, ...]]:
    """The language the engine reads a clause in, and the language spans for a caller that reads span by span.

    One script gives its language. A clause of two scripts follows ``MIXED_POLICY``: by default Hindi, so a Hindi
    sentence with English words in it, or English words with a few Hindi ones, is read by the Hindi voice.
    """
    deva, latin, other = _script_words(text)
    if not deva and not latin:
        lang = "na" if other else _hint_lang(lang_hint)
        return lang, (Span(text, lang, "neutral"),)
    spans = tuple(segment(text, requested=lang_hint))
    if other > deva + latin:
        return "na", spans
    if deva and latin:
        if MIXED_POLICY == "na":
            return "na", spans
        if MIXED_POLICY == "dominant":
            return ("hi" if deva >= latin else "en"), spans
        return ("hi" if deva * 2 >= latin else "en"), spans
    return ("hi" if deva else "en"), spans


# ---- text pieces -------------------------------------------------------------------------------------------------

_TERMINATORS = ".?!।॥"
_CLOSERS = "\"')"
_PUNCT_SPACE = re.compile(r" +([,.;:!?।॥])")
_SPACES = re.compile(r"[ \t]+")
_BREAK_SPACES = re.compile(r" *\n *")
_ALNUM = re.compile(r"[^\W_]")


def _alnum_words(text: str) -> int:
    return sum(1 for token in text.split() if _ALNUM.search(token))


_MARK_TAIL = re.compile(r"[,.;:!?।॥]*\Z")


def _drop_junk(token: str) -> str:
    """A token longer than ``MAX_WORD_CHARS`` (a hash, a blob) is dropped; the marks after it stay."""
    tail = _MARK_TAIL.search(token)
    cut = tail.start() if tail else len(token)
    return token[cut:] if cut > MAX_WORD_CHARS else token


def _normalise(text: str) -> str:
    """One space between words, none before a mark or around a line break, junk tokens out. Words must be whole.

    Normalising the text so far and then the rest gives what normalising it all at once does, so the same text is
    cut the same way however it arrived.
    """
    text = _PUNCT_SPACE.sub(r"\1", _SPACES.sub(" ", text))
    lines = [" ".join(_drop_junk(t) for t in line.split(" ")) for line in text.split("\n")]
    text = _PUNCT_SPACE.sub(r"\1", _SPACES.sub(" ", "\n".join(lines)))
    return _BREAK_SPACES.sub("\n", text)


def _tidy(text: str) -> str:
    """A clause or a sentence on one line: normalised and trimmed."""
    return _normalise(text).strip()


def _terminal_class(run: str) -> str:
    if "." in run and run.count(".") >= 2:
        return "ellipsis"
    return "question" if "?" in run else "period"


def _scan_sentence_end(s: str, final: bool) -> tuple[int, int, str, bool] | None:
    """The first closed sentence of ``s`` (which starts at a non-space): ``(end, next_start, class, paragraph)``.

    ``None`` when no sentence is closed yet. A terminator at the end of the text, or a space run at the end of the
    text, is not decided: the next character may say it was an abbreviation or a paragraph break.
    """
    n = len(s)
    i = 0
    while i < n:
        ch = s[i]
        if ch == "\n":
            j = i
            while j < n and s[j] in " \n":
                j += 1
            if j >= n and not final:
                return None
            return i, j, "period", s.count("\n", i, j) >= 2
        if ch in _TERMINATORS:
            j = i
            while j < n and s[j] in _TERMINATORS:
                j += 1
            k = j
            while k < n and s[k] in _CLOSERS:
                k += 1
            if k >= n and not final:
                return None
            if k < n and s[k] not in " \n":
                i = k  # "3.14", "a.b", "?!x": no boundary
                continue
            if k < n and k == j and s[i:j] == "." and ends_in_open_dot(s[:j]):
                i = j  # "Dr. Singh", "p.m.", an initial, a list number
                continue
            m = k
            while m < n and s[m] in " \n":
                m += 1
            if m >= n and not final:
                return None
            return k, m, _terminal_class(s[i:j]), s.count("\n", k, m) >= 2
        i += 1
    return (n, n, "period", False) if final else None


def _split_pieces(text: str) -> list[tuple[str, str]]:
    """Cut a sentence at commas, semicolons and colons that are followed by a space: ``(piece, pause class)``."""
    pieces: list[tuple[str, str]] = []
    start = 0
    names = {",": "comma", ";": "semicolon", ":": "colon"}
    for i, ch in enumerate(text):
        if ch in names and (i + 1 == len(text) or text[i + 1] == " "):
            pieces.append((text[start : i + 1].strip(), names[ch]))
            start = i + 1
    rest = text[start:].strip()
    if rest:
        pieces.append((rest, "period"))
    return [p for p in pieces if p[0]]


def _balanced_cuts(text: str, limit: int, suffix: str = ",") -> list[str]:
    """Cut ``text`` at spaces into parts of at most ``limit`` characters, about equal in length. Parts but the last
    end in ``suffix`` so the voice does not fall as it does at a sentence end. Never cuts inside a word."""
    parts: list[str] = []
    rest = text.strip()
    while len(rest) > limit:
        count = math.ceil(len(rest) / limit)
        target = len(rest) // count
        window = rest[: limit + 1]
        spaces = [m.start() for m in re.finditer(" ", window)]
        if not spaces:
            break
        cut = min(spaces, key=lambda p: (abs(p - target), p))
        head = rest[:cut].rstrip()
        parts.append(head if head[-1:] in ",;:" else head + suffix)
        rest = rest[cut:].lstrip()
    parts.append(rest)
    return parts


def _first_cut(text: str, first_words: int) -> tuple[int, str]:
    """Where the short first clause of ``text`` ends: ``(end index, pause class)``. ``text`` has more than
    ``FIRST_SPLIT_MIN_WORDS`` words. A comma between the third and sixth word wins; else the cut is after
    ``first_words`` words, moved on over a word that cannot end a phrase (an article, a preposition)."""
    low, high = FIRST_WORDS_RANGE
    tokens = [(m.start(), m.end(), m.group(0)) for m in re.finditer(r"\S+", text)]
    counted = [t for t in tokens if _ALNUM.search(t[2])]
    for index, (_, end, token) in enumerate(counted[:high], start=1):
        if index >= low and token[-1] in ",;:":
            return end, {",": "comma", ";": "semicolon", ":": "colon"}[token[-1]]
    n = max(low, min(high, int(first_words)))
    while n <= high and counted[n - 1][2].strip(",;:.!?\"'()").lower() in _FUNCTION_WORDS:
        n += 1
    return counted[n - 1][1], "cut"


# ---- clauses ----------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Clause:
    """One piece of speech: what to read, in which language, and the silence after it."""

    text: str
    lang: str
    pause_ms: int
    first: bool = False
    spans: tuple[Span, ...] = ()


class _Planner:
    """The incremental core: ``feed`` fragments, ``finish`` at the end. ``prepare`` is one feed and one finish."""

    def __init__(self, lang_hint: str, first_words: int, indexer: list[int] | None, roman_strategy: str | None) -> None:
        strategy = roman_strategy or ROMAN_HINDI_STRATEGY
        if strategy not in ROMAN_HINDI_STRATEGIES:
            raise ValueError(f"unknown Roman Hindi strategy {strategy!r}")
        self.lang_hint = lang_hint
        self.first_words = first_words
        self.strategy = strategy
        self._sanitizer = _Sanitizer(indexer)
        self._raw = ""
        self._clean = ""
        self._emitted = 0

    # -- input ---
    def feed(self, fragment: str) -> list[Clause]:
        self._raw += fragment
        self._drain(final=False)
        return self._plan(final=False)

    def finish(self) -> list[Clause]:
        self._drain(final=True)
        return self._plan(final=True)

    def _drain(self, final: bool) -> None:
        if final:
            cut = len(self._raw)
        else:
            found = _LAST_WS.search(self._raw)
            cut = found.end() if found else 0
        if cut:
            self._clean += self._sanitizer.feed(self._raw[:cut])
            self._raw = self._raw[cut:]

    # -- sentences ---
    def _plan(self, final: bool) -> list[Clause]:
        out: list[Clause] = []
        while True:
            s = _normalise(self._clean).lstrip()
            self._clean = s
            if not s:
                return out
            found = _scan_sentence_end(s, final)
            if found is None:
                if self._emitted == 0 and _alnum_words(s) > FIRST_SPLIT_MIN_WORDS:
                    end, kind = _first_cut(s, self.first_words)
                    self._clean = s[end:]
                    out += self._emit(s[:end], kind)
                    continue
                return out
            end, following, kind, paragraph = found
            self._clean = s[following:]
            out += self._sentence(s[:end], kind, paragraph)

    def _sentence(self, raw: str, kind: str, paragraph: bool) -> list[Clause]:
        text = _tidy(raw)
        if not _ALNUM.search(text):
            return []
        end_class = "paragraph" if paragraph else kind
        out: list[Clause] = []
        if self._emitted == 0 and _alnum_words(text) > FIRST_SPLIT_MIN_WORDS:
            end, cut_kind = _first_cut(text, self.first_words)
            out += self._emit(text[:end], cut_kind)
            text = text[end:].strip()
            if not _ALNUM.search(text):
                return out
        pieces = _split_pieces(text)
        pieces[-1] = (pieces[-1][0], end_class)
        current = ""
        current_class = "period"
        for piece, pause in pieces:
            if len(piece) > CLAUSE_SOFT_CHARS:
                if current:
                    out += self._emit(current, current_class)
                    current = ""
                parts = _balanced_cuts(piece, CLAUSE_SOFT_CHARS)
                for part in parts[:-1]:
                    out += self._emit(part, "cut")
                out += self._emit(parts[-1], pause)
            elif current and len(current) + 1 + len(piece) > CLAUSE_SOFT_CHARS:
                out += self._emit(current, current_class)
                current, current_class = piece, pause
            else:
                current = f"{current} {piece}".strip()
                current_class = pause
        if current:
            out += self._emit(current, current_class)
        return out

    # -- one clause ---
    def _emit(self, text: str, pause_class: str) -> list[Clause]:
        text = _tidy(text)
        if not _ALNUM.search(text):
            return []
        text, hinglish = self._final_text(text)
        chunks = _balanced_cuts(text, CLAUSE_SOFT_CHARS) if len(text) > CLAUSE_HARD_CHARS else [text]
        made: list[Clause] = []
        for index, chunk in enumerate(chunks):
            last = index == len(chunks) - 1
            made.append(self._clause(chunk, pause_class if last else "cut", hinglish))
        return made

    def _final_text(self, text: str) -> tuple[str, bool]:
        """Roman Hinglish in Devanagari where it is Hindi, then the digits: ``(text, read by the Hindi voice)``."""
        lang, _ = _clause_language(text, self.lang_hint)
        hinglish = lang == "en" and self.strategy == "devanagari" and (is_roman_hindi(text) or is_roman_hinglish(text))
        if hinglish or _NUMBER.search(text):
            letters_lang, _ = _clause_language(_NUMBER.sub(" ", text), self.lang_hint)
            default = "hi" if letters_lang == "hi" or hinglish else "en"
            text = _tidy(_read_clause(text, default, hinglish=hinglish, unknown_hindi=is_roman_hindi(text)))
        return text, hinglish

    def _clause(self, text: str, pause_class: str, hinglish: bool = False) -> Clause:
        text = text.replace("।", ".").replace("॥", ".")
        if text[-1] not in ".?!,;:\"')":
            text += "," if pause_class == "cut" else "."
        lang, spans = _clause_language(text, self.lang_hint)
        if hinglish:
            lang = "hi"  # Hindi words in Devanagari with English words beside them: the Hindi voice reads all of it
        elif lang == "en" and is_roman_hindi(text):
            lang = {"latin-na": "na", "latin-hi": "hi"}.get(self.strategy, "en")
        first = self._emitted == 0
        self._emitted += 1
        return Clause(text, lang, PAUSE_MS[pause_class], first, spans)


def prepare(
    text: str,
    lang_hint: str = "",
    first_words: int = 5,
    *,
    indexer: list[int] | None = None,
    roman_strategy: str | None = None,
) -> list[Clause]:
    """A whole reply as clauses (see the module note). Empty or unreadable text gives an empty list."""
    planner = _Planner(lang_hint, first_words, indexer, roman_strategy)
    return planner.feed(str(text or "")) + planner.finish()


def clauses(
    text_iter: Iterable[str],
    lang_hint: str = "",
    first_words: int = 5,
    *,
    indexer: list[int] | None = None,
    roman_strategy: str | None = None,
) -> Iterator[Clause]:
    """Clauses of text that arrives in fragments, each as soon as it is closed. Same result as ``prepare``."""
    planner = _Planner(lang_hint, first_words, indexer, roman_strategy)
    for fragment in text_iter:
        yield from planner.feed(str(fragment or ""))
    yield from planner.finish()


# ---- cache key -------------------------------------------------------------------------------------------------


def clause_key(text: str, lang: str, voice_id: str, recipe_version: str | int, speed: float) -> str:
    """A stable SHA-256 hex key for one rendered clause: same text, language, voice, recipe and speed, same key."""
    body = " ".join(unicodedata.normalize("NFC", str(text or "")).split())
    fields = (body, str(lang), str(voice_id), str(recipe_version), f"{float(speed):.3f}")
    return hashlib.sha256("\x1f".join(fields).encode("utf-8")).hexdigest()


# ---- short acknowledgements -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Ack:
    """A short phrase FRIDAY can say at once. ``text`` is what the engine reads, ``lang`` its language."""

    id: str
    lang: str
    text: str
    group: str  # "hi" | "en" | "hinglish"
    meaning: str


ACKS: tuple[Ack, ...] = (
    Ack("hi-haan", "hi", "हाँ.", "hi", "yes"),
    Ack("hi-ji", "hi", "जी.", "hi", "yes, politely"),
    Ack("hi-ji-haan", "hi", "जी हाँ.", "hi", "yes, politely, firm"),
    Ack("hi-theek-hai", "hi", "ठीक है.", "hi", "alright"),
    Ack("hi-ek-second", "hi", "एक सेकंड.", "hi", "one second"),
    Ack("hi-ek-minute", "hi", "एक मिनट.", "hi", "one minute"),
    Ack("hi-hmm", "hi", "हम्म.", "hi", "thinking"),
    Ack("hi-samajh-gayi", "hi", "समझ गई.", "hi", "understood"),
    Ack("hi-bilkul", "hi", "बिल्कुल.", "hi", "of course"),
    Ack("hi-zaroor", "hi", "ज़रूर.", "hi", "certainly"),
    Ack("hi-achha", "hi", "अच्छा.", "hi", "I see"),
    Ack("hi-dekhti-hoon", "hi", "देखती हूँ.", "hi", "let me look"),
    Ack("hi-ho-gaya", "hi", "हो गया.", "hi", "done"),
    Ack("hi-maaf-kijiye", "hi", "माफ़ कीजिए.", "hi", "sorry"),
    Ack("en-yes", "en", "Yes.", "en", "yes"),
    Ack("en-sure", "en", "Sure.", "en", "sure"),
    Ack("en-okay", "en", "Okay.", "en", "okay"),
    Ack("en-one-moment", "en", "One moment.", "en", "one moment"),
    Ack("en-just-a-second", "en", "Just a second.", "en", "one second"),
    Ack("en-hmm", "en", "Hmm.", "en", "thinking"),
    Ack("en-got-it", "en", "Got it.", "en", "understood"),
    Ack("en-of-course", "en", "Of course.", "en", "of course"),
    Ack("en-let-me-check", "en", "Let me check.", "en", "checking"),
    Ack("en-done", "en", "Done.", "en", "done"),
    Ack("en-sorry", "en", "Sorry about that.", "en", "sorry"),
    Ack("hing-haan-boss", "hi", "हाँ boss.", "hinglish", "yes, boss"),
    Ack("hing-theek-hai-boss", "hi", "ठीक है boss.", "hinglish", "alright, boss"),
    Ack("hing-ek-second-boss", "hi", "एक second boss.", "hinglish", "one second, boss"),
    Ack("hing-okay-ji", "hi", "Okay, जी.", "hinglish", "okay, politely"),
    Ack("hing-done-boss", "hi", "Done boss, हो गया.", "hinglish", "done, boss"),
    Ack("hing-samajh-gayi", "hi", "Got it, समझ गई.", "hinglish", "understood"),
)
_ACK_BY_ID = {a.id: a for a in ACKS}


def ack(ack_id: str) -> Ack:
    """One acknowledgement by id. An unknown id raises ``KeyError``."""
    return _ACK_BY_ID[ack_id]


def ack_clause(ack_id: str, *, first: bool = True) -> Clause:
    """An acknowledgement as a clause, so it is played and cached like any other."""
    return replace(prepare(ack(ack_id).text)[0], first=first)
