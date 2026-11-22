"""Two optional faster-whisper ears that download on demand and are never bundled.

* The Hinglish ear: a Whisper-base fine-tune (Apache-2.0, 78 MB, CTranslate2 int8) that writes Hindi speech in
  Roman letters. It must be decoded with ``language="en"`` (with ``"hi"`` it falls back to Devanagari). Roman
  Hinglish conflicts with the default script policy (Hindi stays in Devanagari), so it is used ONLY when the owner
  picks the explicit ``hi-Latn`` listening mode. No other setting, language or fallback ever reaches it.
* The Hindi fallback: Collabora's Whisper-small Hindi fine-tune (CC-BY-4.0, credit shown on the Models page). It
  stands in for generic faster-whisper small only when Hindi is chosen, the Hindi ear is missing, and these
  weights are installed.

The weights sit in ``<FRIDAY root>/models/<id>`` at the revision and SHA-256 pinned in ``electron/voice-pins.cjs``;
this module only looks at the disk and never downloads. Whatever is missing, broken or silent falls back to the
engine that works today.
"""

from __future__ import annotations

import os
from pathlib import Path

HINGLISH_ID = "hinglish-ear"
HINDI_FALLBACK_ID = "hindi-fallback-ear"
# What a faster-whisper folder needs to open (every one is pinned by revision, size and SHA-256).
REQUIRED = ("model.bin", "config.json", "tokenizer.json", "vocabulary.json", "preprocessor_config.json")
# The pinned model files are 76,396,677 and 483,546,977 bytes; anything far smaller is a partial download.
MIN_BYTES = {HINGLISH_ID: 70_000_000, HINDI_FALLBACK_ID: 450_000_000}
# `hi-Latn` is the BCP 47 tag for Hindi written in Roman letters; `hinglish-roman` is the plain-words alias.
ROMAN_MODES = frozenset({"hi-latn", "hinglish-roman"})

_failed: set[str] = set()


def _norm(value: str) -> str:
    return (value or "").strip().lower().replace("_", "-")


def model_dir(ear_id: str) -> Path | None:
    """The folder with every pinned file on disk, or None. This does not download or open the model."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    folder = (Path(root) if root else Path.home() / ".friday") / "models" / ear_id
    try:
        for name in REQUIRED:
            if not (folder / name).is_file():
                return None
        if (folder / "model.bin").stat().st_size < MIN_BYTES[ear_id]:
            return None
    except OSError:
        return None
    return folder


def hinglish_ready() -> bool:
    return model_dir(HINGLISH_ID) is not None


def hindi_fallback_ready() -> bool:
    return model_dir(HINDI_FALLBACK_ID) is not None


def wants_roman_hinglish(language: str, speech_pref: str) -> bool:
    """True only for the explicit Hinglish (Roman) mode. Hindi, English, Hinglish in Devanagari and auto are not."""
    raw = _norm(speech_pref) or _norm(language)
    return raw in ROMAN_MODES


def mark_failed(ear_id: str) -> None:
    """A broken ear is not tried again in this worker, so one bad file cannot slow every utterance."""
    _failed.add(ear_id)


def reset_failures() -> None:
    _failed.clear()


def choose(language: str, speech_pref: str, hindi_ear_ready: bool, hindi_chosen: bool) -> dict | None:
    """The faster-whisper folder to listen with instead of the generic model, or None for the engine of today.

    ``hindi_chosen`` is the Hindi-only test of the Hindi ear (never true in the Roman mode).
    """
    if wants_roman_hinglish(language, speech_pref):
        folder = None if HINGLISH_ID in _failed else model_dir(HINGLISH_ID)
        if folder is not None:
            # Decode as "en": the fine-tune writes Roman Hinglish for English-tagged decoding only.
            return {"id": HINGLISH_ID, "path": str(folder), "decode": "en", "report": "hi", "engine": "hinglish-ear"}
        return None
    if hindi_chosen and not hindi_ear_ready:
        folder = None if HINDI_FALLBACK_ID in _failed else model_dir(HINDI_FALLBACK_ID)
        if folder is not None:
            return {
                "id": HINDI_FALLBACK_ID,
                "path": str(folder),
                "decode": "hi",
                "report": "hi",
                "engine": "hindi-fallback-ear",
            }
    return None
