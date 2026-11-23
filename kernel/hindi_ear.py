"""FRIDAY's Hindi ear: a Hindi speech recogniser that runs on this PC with no torch.

The weights are the Hindi IndicConformer model exported to ONNX (MIT), the int8 file only, run by the
``onnx-asr`` package (MIT; it needs numpy and onnxruntime, nothing else). They are downloaded on demand by
the Install Manager into ``<FRIDAY root>/models/hindi-ear`` at a pinned revision and SHA-256
(``electron/voice-pins.cjs``); this module never downloads.

It is used only when the owner picks Hindi. English stays on Moonshine or faster-whisper, and Hinglish and
auto stay on faster-whisper, which also answers whenever this ear is missing, fails, or hears nothing in
Devanagari, so a missing file or a bad run can never lose an utterance. Text stays as heard; nothing is
transliterated. When the optional punctuation model (``hindi_punct.py``) is installed, marks are added to a line the
ear wrote without any; the words themselves are never changed.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import hindi_punct

MODEL_DIR = "hindi-ear"
MODEL_FILE = "model.int8.onnx"
REQUIRED = (MODEL_FILE, "vocab.txt", "config.json")
MODEL_TYPE = "nemo-conformer-ctc"
# The pinned file is 137,677,313 bytes; anything far smaller is a partial download.
MIN_MODEL_BYTES = 100_000_000
SAMPLE_RATE = 16000
MIN_SECONDS = 0.2
MAX_SECONDS = 60
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_model = None
_model_dir = ""
_timed = None  # (model, its timed reader)


def model_dir() -> Path | None:
    """The folder with the three files on disk, or None. This does not download or open the model."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    folder = (Path(root) if root else Path.home() / ".friday") / "models" / MODEL_DIR
    try:
        for name in REQUIRED:
            if not (folder / name).is_file():
                return None
        if (folder / MODEL_FILE).stat().st_size < MIN_MODEL_BYTES:
            return None
    except OSError:
        return None
    return folder


def ready() -> bool:
    return model_dir() is not None


def wants_hindi(language: str, speech_pref: str) -> bool:
    """Only when Hindi is chosen. Hinglish, auto and English are not Hindi-only speech."""
    raw = (speech_pref or "").strip().lower().replace("_", "-") or (language or "").strip().lower().replace("_", "-")
    if raw == "hi-latn" or raw.startswith("hi-latn-"):  # Roman-letter Hindi (any region) is the Hinglish (Roman) mode
        return False
    return raw == "hi" or raw.startswith("hi-")


def listen_mode(language: str, speech_pref: str) -> str:
    """How the owner chose to be heard: ``hi``, ``roman`` (Hinglish in Roman letters), ``en``, ``auto`` or ``other``.

    No choice at all (the warm-up and the live preview send none) is ``auto``.
    """
    raw = (speech_pref or "").strip().lower().replace("_", "-") or (language or "").strip().lower().replace("_", "-")
    if not raw or raw in {"auto", "mixed"}:
        return "auto"
    if raw == "hi-latn" or raw.startswith("hi-latn-") or raw == "hinglish-roman":
        return "roman"
    if raw == "hi" or raw.startswith("hi-"):
        return "hi"
    if raw == "en" or raw.startswith("en-"):
        return "en"
    return "other"


def tries_ear(language: str, speech_pref: str) -> bool:
    """Hindi chosen, or no language chosen (auto): the ear listens first, and its own confidence decides whether it
    keeps the line. English, Roman Hinglish and every other language never reach it."""
    return listen_mode(language, speech_pref) in {"hi", "auto"}


# Mean token log-probability of the ear's own reading below which it is not trusted. Measured on synthetic speech
# (Supertonic F2, 22 sentences, clean and with noise): Hindi sentences read -0.00 to -0.26 (code-mixed Devanagari
# -0.27), English read -0.13 to -1.2 (mostly below -0.35, transliterated into Devanagari words that mean nothing).
# Hindi chosen is more lenient, since the owner asked for Hindi and the ear is far the better Hindi reader; auto is
# stricter, since English is likely. Real microphones are noisier than this clean set: unverified on the owner's PC.
EAR_MIN_LOGPROB = {"hi": -0.40, "auto": -0.33}


def confident(mode: str, mean_logprob: float | None) -> bool:
    """True when the ear's line stands. No score (an old runtime, or none measured) is today's behaviour: it stands."""
    if mean_logprob is None or mode not in EAR_MIN_LOGPROB:
        return True
    return float(mean_logprob) >= EAR_MIN_LOGPROB[mode]


_last_confidence: float | None = None


def last_confidence() -> float | None:
    """The mean token log-probability of the most recent reading, or None when it was not measured."""
    return _last_confidence


def _load(folder: Path):
    global _model, _model_dir
    if _model is not None and _model_dir == str(folder):
        return _model
    import onnx_asr  # type: ignore

    _model = onnx_asr.load_model(MODEL_TYPE, path=str(folder), quantization="int8")
    _model_dir = str(folder)
    return _model


def loaded() -> bool:
    """True while the ear holds its model in memory."""
    return _model is not None


def unload() -> bool:
    """Drop the model and its timed reader so the memory returns; True when one was open. It loads again on demand."""
    global _model, _model_dir, _timed
    was_open = _model is not None
    _model, _model_dir, _timed = None, "", None
    return was_open


def _read(model, audio):
    """``(text, mean token logprob or None)``. The timed reader is the same decode and also reports the scores."""
    global _timed
    timed = None
    if getattr(model, "with_timestamps", None) is not None:
        if _timed is None or _timed[0] is not model:
            _timed = (model, model.with_timestamps())
        timed = _timed[1]
    if timed is not None:
        heard = timed.recognize(audio, sample_rate=SAMPLE_RATE)
        scores = [float(v) for v in (getattr(heard, "logprobs", None) or [])]
        mean = sum(scores) / len(scores) if scores else None
        return str(getattr(heard, "text", "") or "").strip(), mean
    return str(model.recognize(audio, sample_rate=SAMPLE_RATE) or "").strip(), None


def transcribe(samples) -> str | None:
    """Hindi text for 16 kHz mono float samples, or None to let faster-whisper answer."""
    global _last_confidence
    _last_confidence = None
    folder = model_dir()
    if folder is None:
        return None
    try:
        import numpy as np  # type: ignore

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size < int(SAMPLE_RATE * MIN_SECONDS):
            return None
        audio = audio[: SAMPLE_RATE * MAX_SECONDS]
        text, _last_confidence = _read(_load(folder), audio)
    except Exception:  # noqa: BLE001 — any failure here means faster-whisper hears it instead
        _last_confidence = None
        return None
    # A Hindi recogniser that wrote no Devanagari heard nothing it understands.
    return hindi_punct.apply(text) if _DEVANAGARI.search(text) else None
