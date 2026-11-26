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
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import time
import unicodedata
from collections.abc import Callable
from pathlib import Path

AUDIO = (".wav", ".mp3", ".m4a", ".ogg", ".flac")
MAX_PAIRS = 60
_DEVANAGARI_DIGITS = {ord("०") + i: str(i) for i in range(10)}


def normalise(text: str) -> str:
    """NFC, lower case, Devanagari digits to ASCII, nukta dropped (फ़ and फ are one spelling), punctuation (including
    the danda) removed, spaces collapsed."""
    t = unicodedata.normalize("NFC", str(text)).lower().translate(_DEVANAGARI_DIGITS).replace("\u093c", "")
    t = re.sub(r"[।॥]", " ", t)
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


def wer(reference: str, hypothesis: str, roman: bool = False) -> float:
    norm = normalise_roman if roman else normalise
    ref = norm(reference).split()
    hyp = norm(hypothesis).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    return _edits(ref, hyp) / len(ref)


def cer(reference: str, hypothesis: str, roman: bool = False) -> float:
    norm = normalise_roman if roman else normalise
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
) -> list[dict]:
    """One result per model: mean word and character error, how many files, how many failed, seconds per file.

    ``roman=True`` scores Roman Hinglish with ``normalise_roman`` (see the module note); the default is unchanged.
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
            w.append(wer(reference, heard, roman))
            c.append(cer(reference, heard, roman))
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
    noise could explain does not fail), or when the script-policy violations rose. The whole corpus and each language
    are judged, so one language cannot hide in the total."""
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
        viol_failed = _rate_or_zero(cv, cw) > _rate_or_zero(bv, bw) + 1e-12
        if wer_failed:
            reasons.append(
                f"{name}: folded WER up {paired['delta'] * 100:.1f} points (range {paired['low'] * 100:.1f} to "
                f"{paired['high'] * 100:.1f}), limit {max_wer_rise * 100:.1f}"
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
            "failed": wer_failed or viol_failed,
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
        rows.append({"id": s["id"], "lang": s["lang"], **folded_counts(s["reference"], s["hypothesis"])})

    def part(group: list[dict]) -> dict:
        ids = {r["id"] for r in group}
        chosen = [s for s in samples if s["id"] in ids]
        return {
            **aggregate_counts(group),
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
