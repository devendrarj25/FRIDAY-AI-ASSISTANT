"""Which speech model hears the owner best, measured on his own recorded phrases.

A folder holds pairs ``name.wav`` (or .mp3, .m4a, .ogg, .flac) and ``name.txt`` (what was said, written in the
script the model is expected to answer in). Each candidate model transcribes every recording and is scored by word
and character error rate against the text, under one fixed normalizer, so the numbers can be compared. The
normalizer matters: error rate swings widely with it (case, punctuation, digits), so it is part of the result and
is the same for every model. Nothing leaves the PC and nothing is saved.

Devanagari and Roman spellings of the same Hinglish word are different strings here. Write the reference in the
script the model is set to produce, or the error rate will mostly measure the spelling.

Roman Hinglish (the optional Hinglish ear writes it) has no standard spelling: "kaam" and "kam", "aaj" and "āj" are
one word. ``roman=True`` scores with ``normalise_roman``, which also strips accents and folds repeated letters, so
the number measures hearing and not spelling. It never transliterates: a Devanagari answer to a Roman reference is
still wrong, and it is counted as wrong.

The Devanagari fold (nukta, anusvara and chandrabindu, a nasal plus virama, chandra vowels, zero-width marks, danda)
lives in ``text_norm``. ``english=True`` scores English with ``text_norm.normalise_english`` (contractions, number
words, spelling variants and fillers), the published-style form, so an English number is comparable to others.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
import unicodedata
from collections.abc import Callable
from pathlib import Path

import text_norm

AUDIO = (".wav", ".mp3", ".m4a", ".ogg", ".flac")
MAX_PAIRS = 60


def normalise(text: str) -> str:
    """``text_norm.fold_devanagari`` (NFC, Devanagari digits to ASCII, nukta dropped so फ़ and फ are one spelling,
    chandrabindu and nasal plus virama as the anusvara, chandra vowels plain, zero-width marks out, danda to a space),
    lower case, punctuation removed, spaces collapsed."""
    t = text_norm.fold_devanagari(str(text)).lower()
    t = "".join(
        " " if unicodedata.category(c).startswith("P") or unicodedata.category(c).startswith("S") else c for c in t
    )
    return re.sub(r"\s+", " ", t).strip()


def normalise_roman(text: str) -> str:
    """The Roman Hinglish normaliser: ``normalise``, then accents removed and a doubled letter written once."""
    t = unicodedata.normalize("NFKD", normalise(text))
    t = "".join(c for c in t if not unicodedata.combining(c) or "\u0900" <= c <= "\u097f")
    t = unicodedata.normalize("NFC", t)
    return re.sub(r"([a-z])\1+", r"\1", t)


def _edits(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def _normaliser(roman: bool, english: bool) -> Callable[[str], str]:
    return text_norm.normalise_english if english else normalise_roman if roman else normalise


def wer(reference: str, hypothesis: str, roman: bool = False, english: bool = False) -> float:
    norm = _normaliser(roman, english)
    ref = norm(reference).split()
    hyp = norm(hypothesis).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    return _edits(ref, hyp) / len(ref)


def cer(reference: str, hypothesis: str, roman: bool = False, english: bool = False) -> float:
    norm = _normaliser(roman, english)
    ref = list(norm(reference).replace(" ", ""))
    hyp = list(norm(hypothesis).replace(" ", ""))
    if not ref:
        return 0.0 if not hyp else 1.0
    return _edits(ref, hyp) / len(ref)


def pairs(folder: Path) -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    for audio in sorted(p for p in folder.iterdir() if p.suffix.lower() in AUDIO):
        text = audio.with_suffix(".txt")
        if text.is_file():
            out.append((audio, text.read_text(encoding="utf-8", errors="replace").strip()))
        if len(out) >= MAX_PAIRS:
            break
    return out


def score(
    rows: list[tuple[Path, str]],
    models: list[str],
    transcribe: Callable[[Path, str], str],
    clock: Callable[[], float] = time.perf_counter,
    roman: bool = False,
    english: bool = False,
) -> list[dict]:
    """One result per model: mean word and character error, how many files, how many failed, seconds per file.

    ``roman=True`` scores Roman Hinglish with ``normalise_roman`` (see the module note);
    ``english=True`` scores with ``text_norm.normalise_english``. The default is unchanged.
    """
    results: list[dict] = []
    for model in models:
        w: list[float] = []
        c: list[float] = []
        failed = 0
        started = clock()
        for path, reference in rows:
            try:
                heard = transcribe(path, model)
            except Exception:  # noqa: BLE001 — a model that cannot run on a file counts as a failure of that file
                failed += 1
                continue
            w.append(wer(reference, heard, roman, english))
            c.append(cer(reference, heard, roman, english))
        elapsed = clock() - started
        done = len(w)
        results.append(
            {
                "model": model,
                "files": len(rows),
                "scored": done,
                "failed": failed,
                "wer": round(sum(w) / done, 4) if done else None,
                "cer": round(sum(c) / done, 4) if done else None,
                "seconds_per_file": round(elapsed / max(done, 1), 3),
            }
        )
    return sorted(results, key=lambda r: (r["wer"] is None, r["wer"] if r["wer"] is not None else 9, r["model"]))


# ----------------------------------------------------------------------------------------------------------------
# The folded scorer and the baseline harness (P0-bench).
#
# ``wer`` above is the strict number: Roman and Devanagari spellings of one Hinglish word are two words. The folded
# number below puts both on one Roman skeleton (and writes digits and number words as digits), so it measures hearing,
# and a separate count measures the script policy (Hindi in Devanagari, English in Latin). Both are reported, never
# one instead of the other. The same algorithm, tables and vectors live in
# ``src/lib/friday/voice-engine/transcript-scorer.ts``; ``core/fixtures/voice-eval/fold-vectors.json`` pins the two
# together. Metric keys are camelCase on purpose, so a baseline file and the TypeScript side read the same names.
# ----------------------------------------------------------------------------------------------------------------

FOLD_VERSION = "fold-1"
BASELINE_SCHEMA = 1
BOOTSTRAP_SEED = 7919
BOOTSTRAP_DRAWS = 1000
DEFAULT_MAX_WER_RISE = 0.02
REPO_ROOT = Path(__file__).resolve().parents[1]
_EPS = 1e-9

_VOWELS = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ii", "उ": "u", "ऊ": "uu", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
    "ऑ": "o", "ऋ": "ri",
}  # fmt: skip
_MATRAS = {
    "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "े": "e", "ै": "ai",
    "ो": "o", "ौ": "au", "ॉ": "o", "ृ": "ri",
}  # fmt: skip
_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
    "ष": "sh", "स": "s", "ह": "h",
}  # fmt: skip
_VIRAMA = "्"
_DEVANAGARI = re.compile("[ऀ-ॿ]")
# Arabic-Indic, extended Arabic-Indic and full-width digits (Devanagari digits are already ASCII after ``normalise``).
_OTHER_DIGITS = {**{0x0660 + i: str(i) for i in range(10)}, **{0x06F0 + i: str(i) for i in range(10)},
                 **{0xFF10 + i: str(i) for i in range(10)}}  # fmt: skip
# Number words that mean one number only. "do" and "दो" (also "give") and the English "no"/"to" are left as words.
_NUMBER_WORDS = {
    **{w: str(i) for i, w in enumerate("zero one two three four five six seven eight nine ten".split())},
    "शून्य": "0", "एक": "1", "तीन": "3", "चार": "4", "पांच": "5", "पाँच": "5", "छह": "6", "छः": "6", "सात": "7",
    "आठ": "8", "नौ": "9", "दस": "10",
    "shunya": "0", "ek": "1", "teen": "3", "char": "4", "panch": "5", "paanch": "5", "chhe": "6", "chhah": "6",
    "saat": "7", "aath": "8", "nau": "9", "das": "10",
}  # fmt: skip


def _romanise(word: str) -> str:
    """Devanagari to a plain Roman spelling: the inherent "a" is written, but not at the end of a word."""
    chars = list(word)
    out = ""
    i = 0
    while i < len(chars):
        c = chars[i]
        if c in _CONSONANTS:
            out += _CONSONANTS[c]
            nxt = chars[i + 1] if i + 1 < len(chars) else None
            if nxt == _VIRAMA:
                i += 1
            elif nxt is not None and nxt in _MATRAS:
                out += _MATRAS[nxt]
                i += 1
            elif nxt is not None:
                out += "a"
        elif c in _VOWELS:
            out += _VOWELS[c]
        elif c in "ंँ":
            out += "n"
        elif c == "ः":
            out += "h"
        elif c in _MATRAS:
            out += _MATRAS[c]
        elif c != _VIRAMA:
            out += c
        i += 1
    return out


def _skeleton(word: str) -> str:
    t = _romanise(word) if _DEVANAGARI.search(word) else word
    t = "".join(c for c in unicodedata.normalize("NFD", t) if not unicodedata.category(c).startswith("M")).lower()
    for pattern, repl in (
        ("ph", "f"), ("w", "v"), ("z", "j"), ("ai|ei|ae", "e"), ("au|ou", "o"), ("ee|ii", "i"), ("oo|uu", "u"),
    ):  # fmt: skip
        t = re.sub(pattern, repl, t)
    return re.sub(r"([a-z])\1+", r"\1", t)


def fold_token(token: str) -> str:
    """One word on its fold: a number word is its digits, anything else is its spelling-tolerant Roman skeleton."""
    word = token.lower()
    return _NUMBER_WORDS.get(word) or _skeleton(word)


def _fold_text(text: str) -> list[str]:
    return normalise(text).translate(_OTHER_DIGITS).split()


def fold_tokens(text: str) -> list[str]:
    return [fold_token(t) for t in _fold_text(text)]


def _script_class(token: str) -> str:
    if _DEVANAGARI.search(token):
        return "devanagari"
    return "latin" if re.search("[a-z]", token) else "none"


def _align(ref: list[str], hyp: list[str]) -> list[tuple[str, int | None, int | None]]:
    """Edit operations. Ties go to a substitution or match first, then a deletion, then an insertion (the same rule as
    the TypeScript scorer, so hits, substitutions and insertions agree between the two)."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]))
    ops: list[tuple[str, int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            ops.append(("hit" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            ops.append(("del", i - 1, None))
            i -= 1
        else:
            ops.append(("ins", None, j - 1))
            j -= 1
    ops.reverse()
    return ops


def folded_counts(reference: str, hypothesis: str) -> dict:
    """Everything the folded scores are made of for one utterance, as counts that add up across a corpus."""
    rraw, hraw = _fold_text(reference), _fold_text(hypothesis)
    rf, hf = [fold_token(t) for t in rraw], [fold_token(t) for t in hraw]
    ops = _align(rf, hf)
    kinds = [k for k, _a, _b in ops]
    to_latin = to_deva = 0
    for kind, a, b in ops:
        if kind != "hit" or a is None or b is None:
            continue
        rs, hs = _script_class(rraw[a]), _script_class(hraw[b])
        if rs == "devanagari" and hs == "latin":
            to_latin += 1
        elif rs == "latin" and hs == "devanagari":
            to_deva += 1
    rchars, hchars = "".join(rf), "".join(hf)
    return {
        "words": len(rf),
        "edits": len(kinds) - kinds.count("hit"),
        "hits": kinds.count("hit"),
        "subs": kinds.count("sub"),
        "dels": kinds.count("del"),
        "ins": kinds.count("ins"),
        "chars": len(rchars),
        "charEdits": _edits(list(rchars), list(hchars)),
        "strictEdits": _edits(normalise(reference).split(), normalise(hypothesis).split()),
        "devanagariToLatin": to_latin,
        "latinToDevanagari": to_deva,
        "violations": to_latin + to_deva,
    }


def _rate(edits: int, total: int) -> float:
    return edits / total if total else (1.0 if edits else 0.0)


def folded_wer(reference: str, hypothesis: str) -> float:
    c = folded_counts(reference, hypothesis)
    return _rate(c["edits"], c["words"])


def folded_cer(reference: str, hypothesis: str) -> float:
    c = folded_counts(reference, hypothesis)
    return _rate(c["charEdits"], c["chars"])


def mer(reference: str, hypothesis: str) -> float:
    """Match error rate: edits over hits plus edits, so it stays within 0 to 1 where a word error rate can pass 1."""
    c = folded_counts(reference, hypothesis)
    span = c["hits"] + c["edits"]
    return c["edits"] / span if span else 0.0


# ---- T-WER, the switch-point error rate and Wilson ranges -----------------------------------------------------------
# A small closed lexicon of Hindi and English mixed in one sentence. The same tables and rules live in
# ``src/lib/friday/voice-engine/hinglish-lexicon.ts``; ``core/fixtures/voice-eval/twer-vectors.json`` pins the two
# together (a hash of the tables and hand-set vectors). Only words in the tables change; a word that is both Hindi and
# English (do, main, to, me, hai ...) stays as written unless a word next to it is surely Hindi.

LEXICON_VERSION = "hinglish-lex-1"
_SURE_HINDI = (
    ("kal", "कल"), ("aaj|aj", "आज"), ("subah|subha|subeh", "सुबह"), ("shaam|sham", "शाम"), ("raat", "रात"),
    ("abhi", "अभी"), ("ab", "अब"), ("phir|fir", "फिर"), ("kya", "क्या"), ("kyun|kyu", "क्यों"),
    ("kyunki", "क्योंकि"), ("kaise", "कैसे"), ("kahan|kaha", "कहाँ"), ("kab", "कब"), ("kaun", "कौन"),
    ("kitna", "कितना"), ("kitne", "कितने"), ("mujhe", "मुझे"), ("mera", "मेरा"), ("meri", "मेरी"),
    ("mere", "मेरे"), ("tum", "तुम"), ("tumhe", "तुम्हें"), ("aap", "आप"), ("humein|hame", "हमें"),
    ("yeh", "यह"), ("ye", "ये"), ("woh|wo|vo", "वो"), ("nahi|nahin|nhi", "नहीं"), ("haan|han", "हाँ"),
    ("theek|thik", "ठीक"), ("achha|accha|acha", "अच्छा"), ("bahut|bohot", "बहुत"), ("thoda", "थोड़ा"),
    ("zyada|jyada|jyaada", "ज़्यादा"), ("kaam", "काम"), ("ghar", "घर"), ("paani|pani", "पानी"),
    ("khana", "खाना"), ("laga", "लगा"), ("lagao", "लगाओ"), ("lagana", "लगाना"), ("karo", "करो"),
    ("karna", "करना"), ("dijiye", "दीजिए"), ("bhejo", "भेजो"), ("bata", "बता"), ("batao", "बताओ"),
    ("dikhao", "दिखाओ"), ("kholo", "खोलो"), ("chalu", "चालू"), ("shuru", "शुरू"), ("rukho", "रुको"),
    ("suno", "सुनो"), ("dekho", "देखो"), ("chalo", "चलो"), ("bolo", "बोलो"), ("chahiye", "चाहिए"),
    ("hoon|hun", "हूँ"), ("hain", "हैं"), ("tha", "था"), ("thi", "थी"), ("raha", "रहा"), ("rahi", "रही"),
    ("rahe", "रहे"), ("jao", "जाओ"), ("aao", "आओ"), ("se", "से"), ("ko", "को"), ("ka", "का"), ("ki", "की"),
    ("ke", "के"), ("bhi", "भी"), ("aur", "और"), ("lekin", "लेकिन"), ("agar", "अगर"), ("toh", "तो"),
    ("sab", "सब"), ("kuch", "कुछ"), ("koi", "कोई"), ("bhai", "भाई"), ("dost", "दोस्त"), ("paise", "पैसे"),
    ("baje", "बजे"), ("samajh", "समझ"), ("pata", "पता"), ("zaroor|jaroor", "ज़रूर"), ("bilkul", "बिल्कुल"),
    ("dhanyavaad|dhanyavad", "धन्यवाद"), ("namaste", "नमस्ते"), ("shukriya", "शुक्रिया"), ("kripya", "कृपया"),
    ("jaldi", "जल्दी"), ("baad", "बाद"), ("pehle|pahle", "पहले"),
)  # fmt: skip
_AMBIGUOUS = (
    ("do", "दो"), ("main", "मैं"), ("to", "तो"), ("me", "में"), ("mein", "में"), ("hai", "है"), ("hum", "हम"),
    ("par", "पर"), ("band", "बंद"), ("hi", "ही"), ("sun", "सुन"), ("chal", "चल"),
)  # fmt: skip
_LOANWORDS = (
    ("description", "डिस्क्रिप्शन|डिस्क्रिपशन"), ("meeting", "मीटिंग"), ("alarm", "अलार्म|अलारम"),
    ("phone", "फोन"), ("mobile", "मोबाइल"), ("computer", "कंप्यूटर|कम्प्यूटर"), ("laptop", "लैपटॉप"),
    ("email", "ईमेल"), ("message", "मैसेज|मेसेज"), ("reminder", "रिमाइंडर"), ("calendar", "कैलेंडर|कैलेण्डर"),
    ("battery", "बैटरी"), ("internet", "इंटरनेट"), ("wifi", "वाईफाई|वायफाय"), ("bluetooth", "ब्लूटूथ"),
    ("volume", "वॉल्यूम|वॉल्युम"), ("screen", "स्क्रीन"), ("screenshot", "स्क्रीनशॉट"), ("file", "फाइल"),
    ("folder", "फोल्डर"), ("download", "डाउनलोड"), ("upload", "अपलोड"), ("app", "ऐप|एप"),
    ("application", "एप्लीकेशन|एप्लिकेशन"), ("update", "अपडेट"), ("settings", "सेटिंग्स|सेटिंग"),
    ("password", "पासवर्ड"), ("camera", "कैमरा"), ("photo", "फोटो"), ("video", "वीडियो"), ("music", "म्यूजिक"),
    ("song", "सॉन्ग|सांग"), ("play", "प्ले"), ("pause", "पॉज"), ("stop", "स्टॉप"), ("next", "नेक्स्ट"),
    ("call", "कॉल"), ("number", "नंबर"), ("time", "टाइम"), ("ok", "ओके"), ("sorry", "सॉरी"),
    ("thanks", "थैंक्स"), ("please", "प्लीज"), ("report", "रिपोर्ट"), ("document", "डॉक्यूमेंट|डाक्यूमेंट"),
    ("schedule", "शेड्यूल"), ("notification", "नोटिफिकेशन"), ("search", "सर्च"), ("google", "गूगल"),
    ("youtube", "यूट्यूब"), ("whatsapp", "व्हाट्सएप|व्हाट्सऐप"), ("chrome", "क्रोम"), ("desktop", "डेस्कटॉप"),
    ("window", "विंडो"), ("mute", "म्यूट"), ("brightness", "ब्राइटनेस"), ("timer", "टाइमर"), ("note", "नोट"),
    ("task", "टास्क"), ("list", "लिस्ट"), ("mail", "मेल"), ("madam", "मैडम"), ("office", "ऑफिस"),
    ("bank", "बैंक"), ("doctor", "डॉक्टर"), ("hospital", "हॉस्पिटल"), ("train", "ट्रेन"), ("taxi", "टैक्सी"),
    ("ticket", "टिकट"), ("online", "ऑनलाइन"), ("offline", "ऑफलाइन"), ("mode", "मोड"), ("voice", "वॉइस|वॉयस"),
    ("friday", "फ्राइडे"), ("button", "बटन"), ("click", "क्लिक"), ("open", "ओपन"), ("close", "क्लोज"),
    ("send", "सेंड"), ("save", "सेव"), ("delete", "डिलीट"), ("project", "प्रोजेक्ट"),
    ("presentation", "प्रेजेंटेशन"), ("cancel", "कैंसल"), ("reply", "रिप्लाई"), ("problem", "प्रॉब्लम"),
    ("plan", "प्लान"), ("data", "डेटा"), ("traffic", "ट्रैफिक"), ("weather", "वेदर"), ("news", "न्यूज"),
    ("lunch", "लंच"), ("dinner", "डिनर"), ("movie", "मूवी"), ("bill", "बिल"), ("card", "कार्ड"),
    ("link", "लिंक"), ("share", "शेयर"), ("chat", "चैट"), ("team", "टीम"), ("client", "क्लाइंट"),
    ("budget", "बजट"), ("final", "फाइनल"), ("flight", "फ्लाइट"), ("hotel", "होटल"),
    ("restaurant", "रेस्टोरेंट"),
)  # fmt: skip


def lexicon_key(word: str) -> str:
    """A word on its lexicon key: NFC, lower case, the nukta dropped and the chandrabindu written as the anusvara."""
    return unicodedata.normalize("NFC", word).lower().replace("\u093c", "").replace("\u0901", "\u0902")


_SURE_MAP = {v: deva for variants, deva in _SURE_HINDI for v in variants.split("|")}
_AMBIGUOUS_MAP = dict(_AMBIGUOUS)
_LOAN_MAP = {lexicon_key(s): latin for latin, spellings in _LOANWORDS for s in spellings.split("|")}


def lexicon_lines() -> list[str]:
    """One line per table entry, sorted, so two implementations can compare a hash of their tables."""
    lines = [f"sure|{k}|{v}" for k, v in _SURE_MAP.items()]
    lines += [f"ambiguous|{k}|{v}" for k, v in _AMBIGUOUS_MAP.items()]
    lines += [f"loan|{k}|{v}" for k, v in _LOAN_MAP.items()]
    return sorted(lines)


def _first_pass(core: str) -> dict:
    if not any(unicodedata.category(c).startswith("L") for c in core):
        return {"lang": "none"}
    key = lexicon_key(core)
    if _DEVANAGARI.search(key):
        latin = _LOAN_MAP.get(key)
        return {"lang": "en", "latin": latin} if latin is not None else {"lang": "hi"}
    if key in _SURE_MAP:
        return {"lang": "hi", "deva": _SURE_MAP[key]}
    if key in _AMBIGUOUS_MAP:
        return {"lang": "en", "deva": _AMBIGUOUS_MAP[key], "maybe": True}
    return {"lang": "en"}


def _classify(cores: list[str]) -> list[dict]:
    first = [_first_pass(c) for c in cores]
    out = []
    for i, kind in enumerate(first):
        if not kind.get("maybe"):
            out.append(kind)
            continue
        beside = (i > 0 and first[i - 1]["lang"] == "hi") or (i + 1 < len(first) and first[i + 1]["lang"] == "hi")
        out.append({"lang": "hi", "deva": kind["deva"]} if beside else {"lang": "en"})
    return out


def label_languages(cores: list[str]) -> list[str]:
    """Hindi, English or none for each word. A Devanagari loanword is English, a sure Roman Hindi word is Hindi."""
    return [k["lang"] for k in _classify(cores)]


def fix_cores(cores: list[str], policy: str = "codemix") -> list[str]:
    """The words of ``cores`` rewritten to the policy; every other word is returned as it came."""
    if policy not in ("codemix", "hindi", "english"):
        raise ValueError(f"unknown script policy {policy!r}")
    to_deva, to_latin = policy != "english", policy != "hindi"
    out = []
    for kind, core in zip(_classify(cores), cores, strict=True):
        if to_deva and kind["lang"] == "hi" and kind.get("deva") is not None:
            out.append(kind["deva"])
        elif to_latin and kind["lang"] == "en" and kind.get("latin") is not None:
            out.append(kind["latin"])
        else:
            out.append(core)
    return out


def _is_word_char(c: str) -> bool:
    return unicodedata.category(c)[0] in "LMN"


def fix_script(text: str, expected_policy: str = "codemix") -> str:
    """Put a transcript on the script policy: ``codemix`` writes Hindi words in Devanagari and English words in Latin;
    ``hindi`` only turns Roman Hindi into Devanagari; ``english`` only turns Devanagari loanwords back into Latin.
    Spacing and the punctuation around a word are kept; a word that is not in the tables is left exactly as it was."""
    pieces = re.split(r"(\s+)", str(text))
    slots: list[tuple[int, str, str, str]] = []
    for at, piece in enumerate(pieces):
        if not piece or piece.isspace():
            continue
        start, end = 0, len(piece)
        while start < end and not _is_word_char(piece[start]):
            start += 1
        while end > start and not _is_word_char(piece[end - 1]):
            end -= 1
        slots.append((at, piece[:start], piece[start:end], piece[end:]))
    fixed = fix_cores([s[2] for s in slots], expected_policy)
    for (at, lead, _core, tail), word in zip(slots, fixed, strict=True):
        pieces[at] = lead + word + tail
    return "".join(pieces)


def _twer_fold(words: list[str]) -> list[str]:
    return [fold_token(lexicon_key(w)) for w in fix_cores(words)]


def twer_tokens(text: str) -> list[str]:
    """The words of a text on the T-WER fold: डिस्क्रिप्शन and description, कल and kal are one word."""
    return _twer_fold(_fold_text(text))


def twer_counts(reference: str, hypothesis: str) -> dict:
    """The counts behind T-WER and the switch-point error rate for one utterance; they add up across a corpus.
    ``twerEdits``: word edits after the T-WER fold. ``switchPoints``: places in the reference where the language changes
    from one word to the next (digits are skipped). ``switchErrors``: switch points where a word on either side was
    substituted or deleted. ``policyFixes``: words of the hypothesis the script policy would rewrite."""
    rraw, hraw = _fold_text(reference), _fold_text(hypothesis)
    ops = _align(_twer_fold(rraw), _twer_fold(hraw))
    wrong = {a for kind, a, _b in ops if kind in ("sub", "del")}
    langs = label_languages(rraw)
    points = errors = 0
    previous = -1
    for i, lang in enumerate(langs):
        if lang == "none":
            continue
        if previous >= 0 and langs[previous] != lang:
            points += 1
            if previous in wrong or i in wrong:
                errors += 1
        previous = i
    fixed = fix_cores(hraw)
    return {
        "twerEdits": sum(1 for kind, _a, _b in ops if kind != "hit"),
        "switchPoints": points,
        "switchErrors": errors,
        "policyFixes": sum(1 for w, f in zip(hraw, fixed, strict=True) if w != f),
        "hypWords": len(hraw),
    }


def twer(reference: str, hypothesis: str) -> float:
    return _rate(twer_counts(reference, hypothesis)["twerEdits"], len(_fold_text(reference)))


def wilson_rate(hits: int, total: int, z: float = 1.96) -> dict:
    """A rate with its 95% Wilson interval; no interval (None) over zero trials."""
    if total <= 0:
        return {"estimate": 0.0, "low": None, "high": None, "n": 0}
    p = hits / total
    z2 = z * z
    denom = 1 + z2 / total
    centre = (p + z2 / (2 * total)) / denom
    margin = (z * math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom
    return {"estimate": p, "low": max(0.0, centre - margin), "high": min(1.0, centre + margin), "n": total}


def aggregate_twer(rows: list[dict], seed: int = BOOTSTRAP_SEED, draws: int = BOOTSTRAP_DRAWS) -> dict:
    """The T-WER, switch-point, script-mismatch and policy numbers of a corpus, from rows that carry both the folded
    and the T-WER counts. Totals first, then the rates. The script mismatch is the share of correctly heard words
    (hits) that sit in the other script than the reference; it is reported on its own, never inside a word error
    rate."""

    def total(key: str) -> int:
        return sum(r[key] for r in rows)

    words, edits = total("words"), total("twerEdits")
    ci = bootstrap_wer([{"edits": r["twerEdits"], "words": r["words"]} for r in rows], seed=seed, draws=draws)
    sp = wilson_rate(total("switchErrors"), total("switchPoints"))
    sm = wilson_rate(total("violations"), total("hits"))
    pf = wilson_rate(total("policyFixes"), total("hypWords"))
    return {
        "lexicon": LEXICON_VERSION,
        "twerEdits": edits,
        "twer": _rate(edits, words),
        "twerLow": ci["low"],
        "twerHigh": ci["high"],
        "switchPoints": total("switchPoints"),
        "switchErrors": total("switchErrors"),
        "switchPointErrorRate": sp["estimate"],
        "switchPointErrorLow": sp["low"],
        "switchPointErrorHigh": sp["high"],
        "scriptMismatchRate": sm["estimate"],
        "scriptMismatchLow": sm["low"],
        "scriptMismatchHigh": sm["high"],
        "hypWords": total("hypWords"),
        "policyFixes": total("policyFixes"),
        "policyFixRate": pf["estimate"],
        "policyFixLow": pf["low"],
        "policyFixHigh": pf["high"],
    }


# ---- latency from a timeline of events --------------------------------------------------------------------------

EVENT_KINDS = ("speech_start", "partial", "speech_end", "endpoint", "final")


def latency_metrics(timeline: dict) -> dict:
    """One utterance's timing from events on one monotonic clock (milliseconds; a fake clock in tests).

    ``speech_start``/``speech_end`` are the true edges of the speech (known from the recording), ``partial`` is a shown
    partial, ``endpoint`` is the moment the endpointer decided, ``final`` is the settled text. ``audioMs`` is the
    length of the audio and ``computeMs`` the busy time the engine spent, so ``rtf`` is compute over audio.
    """
    events = timeline.get("events", [])
    last = None
    for e in events:
        if e.get("kind") not in EVENT_KINDS:
            raise ValueError(f"unknown event kind {e.get('kind')!r}")
        t = e.get("t")
        if not isinstance(t, (int, float)) or isinstance(t, bool):
            raise ValueError("an event needs a numeric t")
        if last is not None and t < last:
            raise ValueError("the timeline runs backwards")
        last = t

    def first(kind: str):
        return next((e["t"] for e in events if e["kind"] == kind), None)

    start, end = first("speech_start"), first("speech_end")
    if start is None:
        raise ValueError("a timeline needs a speech_start event")
    partial, endpoint, final = first("partial"), first("endpoint"), first("final")
    audio, compute = timeline.get("audioMs"), timeline.get("computeMs")
    return {
        "timeToFirstPartialMs": None if partial is None else partial - start,
        "endpointLatencyMs": None if endpoint is None or end is None else endpoint - end,
        "finalisationLagMs": None if final is None or end is None else final - end,
        "rtf": compute / audio if isinstance(audio, (int, float)) and audio > 0 and compute is not None else None,
        "prematureEndpoint": endpoint is not None and end is not None and endpoint < end,
        "complete": final is not None,
    }


def percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile, the same rule as the TypeScript scorer."""
    if not values:
        return None
    ordered = sorted(values)
    rank = min(len(ordered), max(1, math.ceil(p / 100 * len(ordered))))
    return ordered[rank - 1]


def summarise_latency(values: list[float | None]) -> dict:
    got = [v for v in values if v is not None]
    if not got:
        return {"n": 0, "p50": None, "p90": None, "p99": None, "mean": None}
    return {
        "n": len(got),
        "p50": percentile(got, 50),
        "p90": percentile(got, 90),
        "p99": percentile(got, 99),
        "mean": sum(got) / len(got),
    }


def aggregate_latency(timelines: list[dict]) -> dict:
    per = [latency_metrics(t) for t in timelines]
    return {
        "utterances": len(per),
        "timeToFirstPartialMs": summarise_latency([m["timeToFirstPartialMs"] for m in per]),
        "endpointLatencyMs": summarise_latency([m["endpointLatencyMs"] for m in per]),
        "finalisationLagMs": summarise_latency([m["finalisationLagMs"] for m in per]),
        "rtf": summarise_latency([m["rtf"] for m in per]),
        "prematureEndpoints": sum(1 for m in per if m["prematureEndpoint"]),
        "unfinished": sum(1 for m in per if not m["complete"]),
    }


# ---- flicker ------------------------------------------------------------------------------------------------------


def flicker(partials: list[str], final: str | None = None) -> dict:
    """How much shown text is taken back. Words are compared by position after ``normalise`` (case and punctuation are
    not flicker). A word counts as shown when it first appears at its position and as revised when a later frame
    (the final text included) shows something else there, or nothing."""
    frames = [*partials, *([final] if final is not None else [])]
    shown: list[str] = []
    shown_words = revised = revisions = 0
    for frame in frames:
        tokens = normalise(frame).split()
        changed = sum(1 for i, w in enumerate(shown) if i >= len(tokens) or tokens[i] != w)
        shown_words += sum(1 for i, w in enumerate(tokens) if i >= len(shown) or shown[i] != w)
        revised += changed
        revisions += 1 if changed else 0
        shown = tokens
    rate = _rate_or_zero(revised, shown_words)
    return {"shownWords": shown_words, "revisedWords": revised, "revisions": revisions, "rate": rate}


def _rate_or_zero(num: int, den: int) -> float:
    return num / den if den else 0


def aggregate_flicker(parts: list[dict]) -> dict:
    shown = sum(p["shownWords"] for p in parts)
    revised = sum(p["revisedWords"] for p in parts)
    return {
        "utterances": len(parts),
        "shownWords": shown,
        "revisedWords": revised,
        "revisions": sum(p["revisions"] for p in parts),
        "rate": _rate_or_zero(revised, shown),
    }


# ---- corpus numbers, bootstrap and the regression gate ----------------------------------------------------------


def seeded(seed: int) -> Callable[[], float]:
    """The small seeded generator of the TypeScript scorer (mulberry32), so a range is the same in both languages."""
    mask = 0xFFFFFFFF
    state = [seed & mask]

    def draw() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & mask
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & mask
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & mask)) & mask
        return ((t ^ (t >> 14)) & mask) / 4294967296

    return draw


def _ratio(rows: list[dict]) -> float:
    return _rate(sum(r["edits"] for r in rows), sum(r["words"] for r in rows))


def bootstrap_wer(rows: list[dict], seed: int = BOOTSTRAP_SEED, draws: int = BOOTSTRAP_DRAWS) -> dict:
    """Corpus rate (total edits over total words) with a 95% range from resampling the utterances; no range below 2."""
    estimate = _ratio(rows)
    if len(rows) < 2:
        return {"estimate": estimate, "low": None, "high": None, "n": len(rows)}
    nxt = seeded(seed)
    n = len(rows)
    out = [_ratio([rows[math.floor(nxt() * n)] for _ in range(n)]) for _ in range(draws)]
    return {"estimate": estimate, "low": percentile(out, 2.5), "high": percentile(out, 97.5), "n": n}


def paired_bootstrap(
    baseline: list[dict], candidate: list[dict], seed: int = BOOTSTRAP_SEED, draws: int = BOOTSTRAP_DRAWS
) -> dict:
    """Candidate minus baseline corpus rate over resampled utterances (the same picks for both runs)."""
    ids = [r["id"] for r in baseline]
    by_id = {r["id"]: r for r in candidate}
    if len(set(ids)) != len(ids) or len(candidate) != len(by_id) or set(ids) != set(by_id):
        raise ValueError("a paired comparison needs the same utterances in both runs")
    cand = [by_id[i] for i in ids]
    delta = _ratio(cand) - _ratio(baseline)
    if len(baseline) < 2:
        return {"delta": delta, "low": None, "high": None, "excludesZero": False, "n": len(baseline)}
    nxt = seeded(seed)
    n = len(baseline)
    out = []
    for _ in range(draws):
        picks = [math.floor(nxt() * n) for _ in range(n)]
        out.append(_ratio([cand[k] for k in picks]) - _ratio([baseline[k] for k in picks]))
    low, high = percentile(out, 2.5), percentile(out, 97.5)
    excludes = low is not None and high is not None and (low > _EPS or high < -_EPS)
    return {"delta": delta, "low": low, "high": high, "excludesZero": excludes, "n": n}


def regression_gate(
    baseline: list[dict], candidate: list[dict], max_wer_rise: float = DEFAULT_MAX_WER_RISE, seed: int = BOOTSTRAP_SEED,
    draws: int = BOOTSTRAP_DRAWS,
) -> dict:  # fmt: skip
    """Fail a candidate run against a baseline run over the same utterances (rows: id, lang, words, edits, violations).

    It fails when the folded WER is up by more than ``max_wer_rise`` AND the paired range excludes zero (a rise that
    noise could explain does not fail), when the T-WER is up by more than ``max_wer_rise`` under the same proof (when
    both runs carry ``twerEdits``; a baseline made before T-WER has none, and that leg is then ``None``), or when the
    script-policy violations rose. The whole corpus and each language are judged, so one language cannot hide in the
    total."""
    if sorted(r["id"] for r in baseline) != sorted(r["id"] for r in candidate):
        return {"pass": False, "reasons": ["the two runs must cover the same utterances"], "groups": {}}
    cand_by_id = {r["id"]: r for r in candidate}
    langs = sorted({r["lang"] for r in baseline})
    groups: dict[str, dict] = {}
    reasons: list[str] = []
    for name in ["all", *langs]:
        base = [r for r in baseline if name == "all" or r["lang"] == name]
        cand = [cand_by_id[r["id"]] for r in base]
        paired = paired_bootstrap(base, cand, seed=seed, draws=draws)
        bw, cw = sum(r["words"] for r in base), sum(r["words"] for r in cand)
        bv, cv = sum(r.get("violations", 0) for r in base), sum(r.get("violations", 0) for r in cand)
        wer_failed = paired["delta"] > max_wer_rise + _EPS and paired["excludesZero"]
        tw = None
        if base and all(isinstance(r.get("twerEdits"), int) for r in [*base, *cand]):
            tw = paired_bootstrap(
                [{"id": r["id"], "words": r["words"], "edits": r["twerEdits"]} for r in base],
                [{"id": r["id"], "words": r["words"], "edits": r["twerEdits"]} for r in cand],
                seed=seed, draws=draws,
            )  # fmt: skip
        twer_failed = tw is not None and tw["delta"] > max_wer_rise + _EPS and tw["excludesZero"]
        viol_failed = _rate_or_zero(cv, cw) > _rate_or_zero(bv, bw) + 1e-12
        if wer_failed:
            reasons.append(
                f"{name}: folded WER up {paired['delta'] * 100:.1f} points (range {paired['low'] * 100:.1f} to "
                f"{paired['high'] * 100:.1f}), limit {max_wer_rise * 100:.1f}"
            )
        if tw is not None and twer_failed:
            reasons.append(
                f"{name}: T-WER up {tw['delta'] * 100:.1f} points (range {tw['low'] * 100:.1f} to "
                f"{tw['high'] * 100:.1f}), limit {max_wer_rise * 100:.1f}"
            )
        if viol_failed:
            reasons.append(f"{name}: script-policy violations rose from {bv} to {cv}")
        groups[name] = {
            "baselineWer": _ratio(base),
            "candidateWer": _ratio(cand),
            "delta": paired["delta"],
            "low": paired["low"],
            "high": paired["high"],
            "excludesZero": paired["excludesZero"],
            "baselineViolations": bv,
            "candidateViolations": cv,
            "twer": None
            if tw is None
            else {
                "baselineTwer": _rate(sum(r["twerEdits"] for r in base), bw),
                "candidateTwer": _rate(sum(r["twerEdits"] for r in cand), cw),
                "delta": tw["delta"],
                "low": tw["low"],
                "high": tw["high"],
                "excludesZero": tw["excludesZero"],
                "failed": twer_failed,
            },
            "failed": wer_failed or twer_failed or viol_failed,
        }
    return {"pass": not reasons, "reasons": reasons, "groups": groups}


_SUM_KEYS = (
    "words", "edits", "hits", "subs", "dels", "ins", "chars", "charEdits", "strictEdits", "devanagariToLatin",
    "latinToDevanagari", "violations",
)  # fmt: skip


def aggregate_counts(rows: list[dict], seed: int = BOOTSTRAP_SEED, draws: int = BOOTSTRAP_DRAWS) -> dict:
    """Micro aggregation: totals first, then the rates, so a long sentence counts for more than a short one."""
    t = {k: sum(r[k] for r in rows) for k in _SUM_KEYS}
    span = t["hits"] + t["edits"]
    ci = bootstrap_wer(rows, seed=seed, draws=draws)
    return {
        "utterances": len(rows),
        **t,
        "strictWer": _rate(t["strictEdits"], t["words"]),
        "foldedWer": _rate(t["edits"], t["words"]),
        "foldedWerLow": ci["low"],
        "foldedWerHigh": ci["high"],
        "foldedCer": _rate(t["charEdits"], t["chars"]),
        "mer": t["edits"] / span if span else 0.0,
        "violationRate": _rate_or_zero(t["violations"], t["words"]),
    }


def build_report(samples: list[dict], engine: str, created: str, set_info: dict | None = None) -> dict:
    """A baseline from scored samples: ``{id, lang, reference, hypothesis}`` plus optional ``partials`` (shown partial
    texts) and ``timeline`` (see ``latency_metrics``). ``created`` is given by the caller, never read from a clock."""
    rows = []
    for s in samples:
        rows.append(
            {
                "id": s["id"],
                "lang": s["lang"],
                **folded_counts(s["reference"], s["hypothesis"]),
                **twer_counts(s["reference"], s["hypothesis"]),
            }
        )

    def part(group: list[dict]) -> dict:
        ids = {r["id"] for r in group}
        chosen = [s for s in samples if s["id"] in ids]
        return {
            **aggregate_counts(group),
            **aggregate_twer(group),
            "latency": aggregate_latency([s["timeline"] for s in chosen if s.get("timeline")]),
            "flicker": aggregate_flicker(
                [flicker(s["partials"], s["hypothesis"]) for s in chosen if s.get("partials")]
            ),
        }

    langs = sorted({r["lang"] for r in rows})
    return {
        "schema": BASELINE_SCHEMA,
        "kind": "stt-baseline",
        "normaliser": FOLD_VERSION,
        "lexicon": LEXICON_VERSION,
        "engine": engine,
        "created": created,
        "set": set_info,
        "overall": part(rows),
        "languages": {lang: part([r for r in rows if r["lang"] == lang]) for lang in langs},
        "rows": rows,
    }


def write_baseline(path: Path, report: dict) -> None:
    """Write the baseline whole or not at all (a temp file in the same folder, then a rename)."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def read_baseline(path: Path) -> dict:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"cannot read the baseline {path}: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"the baseline {path} is not valid JSON") from exc
    if not isinstance(data, dict) or data.get("kind") != "stt-baseline":
        raise ValueError("this is not an stt-baseline file")
    if data.get("schema") != BASELINE_SCHEMA:
        raise ValueError(
            f"baseline schema {data.get('schema')!r} is not supported (this reader knows {BASELINE_SCHEMA})"
        )
    if data.get("normaliser") != FOLD_VERSION:
        raise ValueError(
            f"the baseline normaliser {data.get('normaliser')!r} differs from {FOLD_VERSION}: not comparable"
        )
    if not isinstance(data.get("rows"), list) or not isinstance(data.get("overall"), dict):
        raise ValueError("the baseline has no rows")
    return data


# ---- offline doubles ------------------------------------------------------------------------------------------------


class FakeClock:
    """A clock that only moves when told to (milliseconds), so a latency test reads the same on every machine."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = float(start)

    def __call__(self) -> float:
        return self.now

    def advance(self, ms: float) -> None:
        self.now += ms


class FakeTranscriber:
    """A transcriber that never touches audio: ``script`` maps a file stem to ``{"text", "partials"?, "audioMs"?,
    "computeMs"?}``. Called as ``(path, model)`` it fits ``score``; ``sample`` makes a scored sample with a scripted
    timeline (partials 250 ms apart, speech end at the audio length, endpoint 200 ms and final 300 ms after it)."""

    def __init__(self, script: dict[str, dict]) -> None:
        self.script = script

    def __call__(self, path: Path, model: str = "fake") -> str:
        return self.script[Path(path).stem]["text"]

    def sample(self, item_id: str, lang: str, reference: str) -> dict:
        entry = self.script[item_id]
        partials = list(entry.get("partials", []))
        out = {"id": item_id, "lang": lang, "reference": reference, "hypothesis": entry["text"]}
        if partials:
            out["partials"] = partials
        audio = entry.get("audioMs")
        if audio is not None:
            events = [{"t": 0, "kind": "speech_start"}]
            events += [{"t": 250 * (k + 1), "kind": "partial", "text": p} for k, p in enumerate(partials)]
            events += [
                {"t": audio, "kind": "speech_end"},
                {"t": audio + 200, "kind": "endpoint"},
                {"t": audio + 300, "kind": "final", "text": entry["text"]},
            ]
            timeline: dict = {"audioMs": audio, "events": events}
            if entry.get("computeMs") is not None:
                timeline["computeMs"] = entry["computeMs"]
            out["timeline"] = timeline
        return out


# ---- a public set pinned by hash, kept outside the repository ---------------------------------------------------


class EvalSetError(Exception):
    """A set that cannot be trusted: no items are returned, so no number can be made from it."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


def is_inside_repo(path: Path) -> bool:
    return Path(path).resolve().is_relative_to(REPO_ROOT)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _text_sha256(text: str) -> str:
    return hashlib.sha256(unicodedata.normalize("NFC", text).encode("utf-8")).hexdigest()


def load_eval_set(
    manifest_path: Path, references_path: Path, audio_dir: Path, *, pin: str, split: str = "test",
    allow_in_repo: bool = False,
) -> list[dict]:  # fmt: skip
    """Items of one split of an evaluation set in the manifest format of ``voice-eval-set.ts``.

    ``pin`` is the SHA-256 the owner recorded for the manifest file. Every audio file must match its ``sha256`` and
    every reference its ``referenceSha256`` (NFC, UTF-8); any difference raises ``EvalSetError``. Real sets live
    outside the repository: a path inside it is refused unless ``allow_in_repo`` (the synthetic fixture). Nothing is
    downloaded here; the owner fetches a public set himself and records its hashes."""
    manifest_path, references_path, audio_dir = Path(manifest_path), Path(references_path), Path(audio_dir)
    if not allow_in_repo and any(is_inside_repo(p) for p in (manifest_path, references_path, audio_dir)):
        raise EvalSetError(["an evaluation set must live outside the repository"])
    try:
        raw = manifest_path.read_bytes()
        refs = json.loads(references_path.read_text(encoding="utf-8"))
        manifest = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise EvalSetError([f"cannot read the set: {exc}"]) from exc
    if hashlib.sha256(raw).hexdigest() != pin.lower():
        raise EvalSetError(["the manifest does not match its pin"])
    if not isinstance(manifest, dict) or manifest.get("schema") != 1 or not isinstance(refs, dict):
        raise EvalSetError(["the manifest or the references have an unknown shape"])
    problems: list[str] = []
    items: list[dict] = []
    for item in manifest.get("items", []):
        if item.get("split") != split:
            continue
        name = str(item.get("id", ""))
        if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
            problems.append(f"{name!r}: not a safe item id")
            continue
        audio = next((audio_dir / f"{name}{ext}" for ext in AUDIO if (audio_dir / f"{name}{ext}").is_file()), None)
        if audio is None:
            problems.append(f"{name}: audio file missing")
        elif _file_sha256(audio) != item.get("sha256"):
            problems.append(f"{name}: audio does not match its hash")
        text = refs.get(name)
        if not isinstance(text, str):
            problems.append(f"{name}: reference missing")
        elif _text_sha256(text) != item.get("referenceSha256"):
            problems.append(f"{name}: reference does not match its hash")
        if audio is not None and isinstance(text, str):
            items.append(
                {"id": name, "lang": item.get("language"), "reference": text, "path": audio,
                 "durationMs": item.get("durationMs"), "speaker": item.get("speaker")}
            )  # fmt: skip
    if problems:
        raise EvalSetError(problems)
    return items


# ---- the run entry: score a set with one streaming engine, write the baseline on the owner's PC -------------------

EXIT_OK, EXIT_USAGE, EXIT_REFUSED, EXIT_NO_DATA = 0, 1, 2, 3
CHUNK_MS = 160
_ENGINE_NAME = re.compile(r"[A-Za-z0-9._-]{1,64}")


def baseline_path(root: Path, engine: str) -> Path:
    """``<root>/reports/stt-baseline-<engine>.json``; a root inside the repository or an unsafe engine name is refused,
    so a baseline (which holds the owner's phrases) can never land in the tree."""
    if not _ENGINE_NAME.fullmatch(engine):
        raise ValueError(f"{engine!r} is not a safe engine name")
    if is_inside_repo(Path(root)):
        raise ValueError("a baseline is written on the owner's PC, never inside the repository")
    return Path(root) / "reports" / f"stt-baseline-{engine}.json"


def run_baseline(
    items: list[dict], sampler: Callable[[dict], dict], engine: str, root: Path, created: str,
    set_info: dict | None = None,
) -> tuple[Path, dict]:  # fmt: skip
    """Score every item (``sampler`` returns ``{hypothesis, partials?, timeline?}`` for one) and write the baseline."""
    dest = baseline_path(root, engine)
    samples = []
    for item in items:
        got = sampler(item)
        samples.append({"id": item["id"], "lang": item["lang"], "reference": item["reference"], **got})
    report = build_report(samples, engine, created, set_info)
    dest.parent.mkdir(parents=True, exist_ok=True)
    write_baseline(dest, report)
    return dest, report


def _read_pcm16(path: Path) -> bytes:
    import wave

    with wave.open(str(path), "rb") as handle:
        if (handle.getframerate(), handle.getnchannels(), handle.getsampwidth()) != (16000, 1, 2):
            raise ValueError("the stream bench reads 16 kHz mono 16-bit wav only")
        return handle.readframes(handle.getnframes())


def _speech_end_ms(pcm: bytes, item: dict) -> int | None:
    """The true end of the speech: the fixture's ``speechEndMs`` when it knows it, else the end of the last voiced 20 ms
    frame. Silence only gives ``None`` (no speech end is claimed, so no endpoint can be called premature)."""
    known = item.get("speechEndMs")
    if isinstance(known, (int, float)) and not isinstance(known, bool):
        return int(known)
    import array

    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    if sys.byteorder == "big":
        samples.byteswap()
    frame = 320  # 20 ms at 16 kHz
    levels = [
        (sum(abs(v) for v in samples[i : i + frame]) / max(1, len(samples[i : i + frame])))
        for i in range(0, len(samples), frame)
    ]
    peak = max(levels, default=0.0)
    if peak < 50:
        return None
    gate = max(50.0, peak * 0.1)
    last = max((i for i, level in enumerate(levels) if level >= gate), default=None)
    return None if last is None else (last + 1) * 20


def stream_sampler(host, engine: str, clock: Callable[[], float] = time.perf_counter) -> Callable[[dict], dict]:
    """A sampler that feeds one recording through a ``StreamHost`` in 160 ms chunks and keeps the shown partials and
    a timeline on the audio clock (the engine is fed faster than real time; compute time is the real cost)."""
    import base64

    def sample(item: dict) -> dict:
        pcm = _read_pcm16(Path(item["path"]))
        locale = {"hi": "hi", "en": "en", "hinglish": "hi-en"}.get(str(item["lang"]), "")
        opened = host.handle({"op": "stream-open", "streamEngine": engine, "locale": locale, "streamId": "bench"})
        if not opened.get("ok"):
            raise RuntimeError(str(opened.get("reason") or "open-failed"))
        step = CHUNK_MS * 32  # 16 kHz, 2 bytes
        events: list[dict] = [{"t": 0, "kind": "speech_start"}]
        partials: list[str] = []
        audio_ms = len(pcm) // 32
        started = clock()
        for at in range(0, len(pcm), step):
            fed = host.handle(
                {"op": "stream-feed", "streamId": "bench", "pcm": base64.b64encode(pcm[at : at + step]).decode()}
            )
            if not fed.get("ok"):
                raise RuntimeError(str(fed.get("reason") or "feed-failed"))
            t = min(audio_ms, (at + step) // 32)
            for ev in fed.get("events", []):
                text = str(ev.get("text", fed.get("text", "")))
                if ev.get("type") == "partial" and text and (not partials or partials[-1] != text):
                    partials.append(text)
                    events.append({"t": t, "kind": "partial", "text": text})
                elif ev.get("type") == "endpoint" and ev.get("event") == "EndOfTurn":
                    events.append({"t": t, "kind": "endpoint"})
        closing = clock()
        done = host.handle({"op": "stream-close", "streamId": "bench", "finalize": True})
        if not done.get("ok"):
            raise RuntimeError(str(done.get("reason") or "close-failed"))
        end = clock()
        text = str(done.get("text", ""))
        speech_end = _speech_end_ms(pcm, item)
        if speech_end is not None:
            events.append({"t": speech_end, "kind": "speech_end"})
        events.append({"t": audio_ms + int((end - closing) * 1000), "kind": "final", "text": text})
        events.sort(key=lambda e: (e["t"], e["kind"] == "final"))
        timeline = {"audioMs": audio_ms, "computeMs": int((end - started) * 1000), "events": events}
        return {"hypothesis": text, "partials": partials, "timeline": timeline}

    return sample


def main(argv: list[str] | None = None, *, host=None, out: Callable[[str], None] = print) -> int:
    """``run --engine NAME --manifest F --references F --audio DIR --pin SHA256 [--split test] [--root DIR]
    [--fake SCRIPT.json]``. Exit 0 done, 1 usage, 2 refused (no weights, a hash differs), 3 no data."""
    import argparse
    from datetime import UTC, datetime

    ap = argparse.ArgumentParser(prog="stt_bench.py")
    ap.add_argument("command", choices=["run"])
    ap.add_argument("--engine", default="stream-ear-nemotron")
    ap.add_argument("--manifest")
    ap.add_argument("--references")
    ap.add_argument("--audio")
    ap.add_argument("--pin")
    ap.add_argument("--split", default="test")
    ap.add_argument("--root", default=os.environ.get("FRIDAY_ROOT", ""))
    ap.add_argument("--fake", help="a JSON script for the offline fake transcriber (tests)")
    ap.add_argument("--allow-in-repo", action="store_true", help="only for the synthetic fixture")
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        return EXIT_USAGE
    missing = [n for n in ("manifest", "references", "audio", "pin") if not getattr(args, n)]
    if missing or not args.root:
        need = [f"--{n}" for n in missing] + ([] if args.root else ["--root"])
        out("NO DATA: nothing was measured. Missing: " + ", ".join(need))
        return EXIT_NO_DATA
    try:
        items = load_eval_set(
            Path(args.manifest), Path(args.references), Path(args.audio), pin=args.pin, split=args.split,
            allow_in_repo=args.allow_in_repo,
        )  # fmt: skip
    except EvalSetError as exc:
        out("REFUSED: " + "; ".join(exc.problems))
        return EXIT_REFUSED
    if not items:
        out(f"NO DATA: no items in split {args.split!r}")
        return EXIT_NO_DATA
    sampler: Callable[[dict], dict]
    if args.fake:
        fake = FakeTranscriber(json.loads(Path(args.fake).read_text(encoding="utf-8")))

        def fake_sampler(item: dict) -> dict:
            made = fake.sample(item["id"], item["lang"], item["reference"])
            return {k: made[k] for k in ("hypothesis", "partials", "timeline") if k in made}

        sampler = fake_sampler
    else:
        if host is None:
            import stream_ear

            host = stream_ear.HOST
        sampler = stream_sampler(host, args.engine)
    created = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        dest, report = run_baseline(items, sampler, args.engine, Path(args.root), created, {"split": args.split})
    except ValueError as exc:
        out(f"REFUSED: {exc}")
        return EXIT_REFUSED
    except RuntimeError as exc:
        out(f"REFUSED: the stream ear could not run ({exc}); no weights or runtime, nothing was measured")
        return EXIT_REFUSED
    for lang, part in report["languages"].items():
        out(f"{lang}: folded WER {part['foldedWer']:.4f} over {part['utterances']} utterances")
        out(
            f"{lang}: T-WER {part['twer']:.4f}, switch-point error {part['switchPointErrorRate']:.4f} over "
            f"{part['switchPoints']} switch points, script mismatch {part['scriptMismatchRate']:.4f}"
        )
    out(f"baseline written: {dest}")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
