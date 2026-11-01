"""Which speech model hears the owner best, measured on his own recorded phrases.

A folder holds pairs ``name.wav`` (or .mp3, .m4a, .ogg, .flac) and ``name.txt`` (what was said, written in the
script the model is expected to answer in). Each candidate model transcribes every recording and is scored by word
and character error rate against the text, under one fixed normalizer, so the numbers can be compared. The
normalizer matters: error rate swings widely with it (case, punctuation, digits), so it is part of the result and
is the same for every model. Nothing leaves the PC and nothing is saved.

Devanagari and Roman spellings of the same Hinglish word are different strings here. Write the reference in the
script the model is set to produce, or the error rate will mostly measure the spelling.
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
    """NFC, lower case, Devanagari digits to ASCII, punctuation (including the danda) removed, spaces collapsed."""
    t = unicodedata.normalize("NFC", str(text)).lower().translate(_DEVANAGARI_DIGITS)
    t = re.sub(r"[।॥]", " ", t)
    t = "".join(
        " " if unicodedata.category(c).startswith("P") or unicodedata.category(c).startswith("S") else c for c in t
    )
    return re.sub(r"\s+", " ", t).strip()


def _edits(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def wer(reference: str, hypothesis: str) -> float:
    ref = normalise(reference).split()
    hyp = normalise(hypothesis).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    return _edits(ref, hyp) / len(ref)


def cer(reference: str, hypothesis: str) -> float:
    ref = list(normalise(reference).replace(" ", ""))
    hyp = list(normalise(hypothesis).replace(" ", ""))
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
) -> list[dict]:
    """One result per model: mean word and character error, how many files, how many failed, seconds per file."""
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
            w.append(wer(reference, heard))
            c.append(cer(reference, heard))
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
