"""Hindi punctuation restoration: an optional second pass on what the Hindi ear heard, with no torch.

The Hindi ear writes words and nothing else. This module asks a small multilingual punctuation model
(1-800-BAD-CODE ``punct_cap_seg_47_language``, Apache-2.0, an ONNX graph plus a SentencePiece model) where a
comma, a danda or a question mark belongs, and writes only those marks. The model is run directly through
``sentencepiece`` and ``onnxruntime``; the ``punctuators`` package that normally runs it needs torch and is not used.

The files are downloaded on demand by the Install Manager into ``<FRIDAY root>/models/hindi-punct`` at a pinned
revision and SHA-256 (``electron/voice-pins.cjs``); this module never downloads. It is off until they are there.

It never changes a word: it works on the words as heard (split on white space), and the only thing it can do is
append one mark to the end of a word. Capital letters are not restored (Devanagari has none). Any failure, a model
that will not open, a tokeniser that disagrees about the words, a bad label, leaves the text exactly as heard.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

MODEL_DIR = "hindi-punct"
MODEL_FILE = "punct_cap_seg_47lang.onnx"
SPM_FILE = "spe_unigram_64k_lowercase_47lang.model"
CONFIG_FILE = "config.yaml"
REQUIRED = (MODEL_FILE, SPM_FILE, CONFIG_FILE)
# The pinned graph is 232,986,305 bytes; anything far smaller is a partial download.
MIN_MODEL_BYTES = 200_000_000
# The same lists as the pinned config.yaml; the file is read first and these stand in when it cannot be read.
DEFAULT_POST_LABELS = (
    "<NULL>", ".", ",", "?", "？", "，", "。", "、", "・", "।", "؟", "،", ";", "።", "፣", "፧",
)  # fmt: skip
DEFAULT_MAX_LENGTH = 128
OVERLAP = 16
OFF_VALUES = frozenset({"0", "off", "false", "no"})

_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_ENDS_WITH_MARK = re.compile(r"[।॥.,?!;:？！，。]$")
_ANY_MARK = re.compile(r"[।॥.,?!;:？！，。]")
_STOPS = frozenset({".", "。", "।"})
_COMMAS = frozenset({",", "，", "،", "、", ";"})
_QUESTIONS = frozenset({"?", "？", "؟"})

_runtime = None
_runtime_dir = ""
_failed_dir = ""


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


def read_config(folder: Path) -> tuple[list[str], int]:
    """(post labels, window length) from the pinned config.yaml; the pinned defaults when it cannot be read."""
    labels: list[str] = list(DEFAULT_POST_LABELS)
    max_length: int = DEFAULT_MAX_LENGTH
    try:
        text = (folder / CONFIG_FILE).read_text(encoding="utf-8")
    except OSError:
        return labels, max_length
    block = re.search(r"post_labels:\s*\[(.*?)\]", text, re.DOTALL)
    found: list[str] = re.findall(r'"([^"]*)"', block.group(1)) if block else []
    size = re.search(r"max_length:\s*(\d+)", text)
    return (found or labels), (int(size.group(1)) if size else max_length)


def needs_punctuation(text: str) -> bool:
    """Hindi words with no mark at all. One word, other scripts and text that already has a mark are left alone."""
    words = (text or "").split()
    return len(words) >= 2 and bool(_DEVANAGARI.search(text)) and not _ANY_MARK.search(text)


class _Runtime:
    """The SentencePiece model and the ONNX graph behind the small interface the rest of this file uses."""

    def __init__(self, sp, session, labels: list[str], max_length: int):
        self._sp = sp
        self._session = session
        self.labels = labels
        self.max_length = max_length

    def encode(self, text: str):
        ids = [int(i) for i in self._sp.encode(text)]
        return ids, [self._sp.id_to_piece(i) for i in ids]

    def predict(self, ids: list[int]) -> list[int]:
        import numpy as np  # type: ignore

        wrapped = [int(self._sp.bos_id()), *ids, int(self._sp.eos_id())]
        (post,) = self._session.run(["post_preds"], {"input_ids": np.asarray([wrapped], dtype=np.int64)})
        return [int(value) for value in post[0][1:-1]]


def _load_runtime(folder: Path) -> _Runtime:
    import onnxruntime as ort  # type: ignore
    import sentencepiece  # type: ignore

    sp = sentencepiece.SentencePieceProcessor()
    # Loaded from bytes so a folder name with non-ASCII letters opens on Windows too.
    sp.LoadFromSerializedProto((folder / SPM_FILE).read_bytes())
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    session = ort.InferenceSession(str(folder / MODEL_FILE), options, providers=["CPUExecutionProvider"])
    labels, max_length = read_config(folder)
    return _Runtime(sp, session, labels, max_length)


def _windows(count: int, window: int, overlap: int) -> list[tuple[int, int]]:
    """Start and stop of each model window over ``count`` tokens; each after the first reaches back ``overlap``."""
    spans: list[tuple[int, int]] = []
    start = 0
    while start < count:
        begin = start - (0 if not spans else overlap)
        stop = begin + window
        spans.append((begin, min(stop, count)))
        start = stop
    return spans


def _predict_all(runtime, ids: list[int]) -> list[int]:
    window = max(8, int(runtime.max_length) - 2)
    spans = _windows(len(ids), window, OVERLAP)
    merged = [0] * len(ids)
    for index, (begin, stop) in enumerate(spans):
        preds = list(runtime.predict(ids[begin:stop]))
        if len(preds) != stop - begin:
            raise ValueError("the model answered for a different number of tokens")
        keep_from = begin + (OVERLAP // 2 if index else 0)
        keep_to = stop - (OVERLAP // 2 if index < len(spans) - 1 else 0)
        for position in range(keep_from, keep_to):
            merged[position] = preds[position - begin]
    return merged


def _mark(label: str, word: str) -> str:
    """The Hindi mark for one model label, or nothing. A word that already ends in a mark gets no second one."""
    if not label or _ENDS_WITH_MARK.search(word):
        return ""
    if label in _STOPS:
        return "।" if _DEVANAGARI.match(word[-1]) else "."
    if label in _COMMAS:
        return ","
    if label in _QUESTIONS:
        return "?"
    return ""


def punctuate(text: str) -> str | None:
    """The text with marks added, or None when the model is missing, fails or disagrees about the words."""
    global _runtime, _runtime_dir, _failed_dir
    folder = model_dir()
    if folder is None or _failed_dir == str(folder):
        return None
    words = (text or "").split()
    if not words:
        return None
    try:
        if _runtime is None or _runtime_dir != str(folder):
            _runtime = _load_runtime(folder)
            _runtime_dir = str(folder)
    except Exception:  # noqa: BLE001 — a model that will not open is remembered, the Hindi ear still answers
        _failed_dir = str(folder)
        _runtime = None
        return None
    try:
        ids, pieces = _runtime.encode(" ".join(words))
        # One group per word: a piece that starts with the SentencePiece word marker begins the next word.
        last: list[int] = []
        for index, piece in enumerate(pieces):
            if piece.startswith("▁") and index:
                last.append(index - 1)
        if pieces:
            last.append(len(pieces) - 1)
        if len(last) != len(words):
            return None
        preds = _predict_all(_runtime, ids)
        labels = list(_runtime.labels)
        out = []
        for word, token in zip(words, last, strict=True):
            out.append(word + _mark(labels[preds[token]], word))
        return " ".join(out)
    except Exception:  # noqa: BLE001 — any failure here means the words stay as heard
        return None


def apply(text: str) -> str:
    """The text as heard, with marks only when the model is installed, wanted and the text has none."""
    if os.environ.get("FRIDAY_HINDI_PUNCT", "").strip().lower() in OFF_VALUES:
        return text
    if not needs_punctuation(text) or not ready():
        return text
    return punctuate(text) or text
