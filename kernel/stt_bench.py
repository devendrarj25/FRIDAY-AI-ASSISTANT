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

import re
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
