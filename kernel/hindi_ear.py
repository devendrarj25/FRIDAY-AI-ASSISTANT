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


def _load(folder: Path):
    global _model, _model_dir
    if _model is not None and _model_dir == str(folder):
        return _model
    import onnx_asr  # type: ignore

    _model = onnx_asr.load_model(MODEL_TYPE, path=str(folder), quantization="int8")
    _model_dir = str(folder)
    return _model


def transcribe(samples) -> str | None:
    """Hindi text for 16 kHz mono float samples, or None to let faster-whisper answer."""
    folder = model_dir()
    if folder is None:
        return None
    try:
        import numpy as np  # type: ignore

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size < int(SAMPLE_RATE * MIN_SECONDS):
            return None
        audio = audio[: SAMPLE_RATE * MAX_SECONDS]
        heard = _load(folder).recognize(audio, sample_rate=SAMPLE_RATE)
        text = str(heard or "").strip()
    except Exception:  # noqa: BLE001 — any failure here means faster-whisper hears it instead
        return None
    # A Hindi recogniser that wrote no Devanagari heard nothing it understands.
    return hindi_punct.apply(text) if _DEVANAGARI.search(text) else None
