"""FRIDAY Voice: the own speech engine, numpy and onnxruntime only.

It runs the four pinned ONNX graphs of the voice (a duration predictor, a text encoder, a flow-matching vector
estimator and a vocoder) straight from the model folder, with no speech package in between. One call makes one
clause: text and a language in, mono float32 audio at the model's own rate out.

Interface contract
------------------
* ``open_voice(model_dir)`` returns a cached ``FridayVoice`` or ``None`` when the folder, onnxruntime or numpy is
  missing. It never raises and never downloads.
* ``FridayVoice.synth(text, lang, style, steps=5, speed=1.0, seed=None)`` makes audio for one clause (up to about
  300 characters). ``lang`` is one of ``LANGUAGES`` or ``"na"``. ``seed`` fixes the noise so a clause repeats exactly;
  without it the noise is fresh.
* ``Style`` holds the two voice vectors (``ttl`` for the text side, ``dp`` for the duration side). ``load_style`` reads
  one style file, ``blend_styles`` mixes styles with weights into a new one, and ``FridayVoice.style(name)`` reads a
  preset (``F1`` to ``F5``, ``M1`` to ``M5``) once and keeps it.
* ``clean_text`` and ``encode`` are the text steps alone, so a frontend can check what the engine will read.
* The graphs are opened lazily and can be handed in (``sessions=``) so tests run with stand-ins and no model file.

Nothing in this file writes to disk or opens a socket.
"""

from __future__ import annotations

import json
import os
import re
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import voice_budget

LANGUAGES = (
    "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu", "id", "it",
    "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
)  # fmt: skip
UNKNOWN_LANGUAGE = "na"
SPEED_RANGE = (0.7, 2.0)
STEP_RANGE = (1, 16)
MAX_CLAUSE_CHARS = 500
GRAPHS = {
    "duration": "duration_predictor.onnx",
    "text": "text_encoder.onnx",
    "estimator": "vector_estimator.onnx",
    "vocoder": "vocoder.onnx",
}
PRESETS = tuple(f"{g}{n}" for g in "FM" for n in range(1, 6))

_EMOJI = re.compile(
    "[\U0001f600-\U0001f64f\U0001f300-\U0001f5ff\U0001f680-\U0001f6ff\U0001f700-\U0001f77f\U0001f780-\U0001f7ff"
    "\U0001f800-\U0001f8ff\U0001f900-\U0001f9ff\U0001fa00-\U0001fa6f\U0001fa70-\U0001faff☀-⛿✀-➿"
    "\U0001f1e6-\U0001f1ff]+"
)
_SYMBOLS = {
    "–": "-", "‑": "-", "—": "-", "¯": " ", "_": " ", "“": '"', "”": '"',
    "‘": "'", "’": "'", "´": "'", "`": "'", "[": " ", "]": " ", "|": " ", "/": " ", "#": " ",
    "→": " ", "←": " ",
}  # fmt: skip
_DECOR = re.compile(r"[♥☆♡©\\]")
_SPACING = tuple((re.compile(re.escape(f" {mark}")), mark) for mark in (",", ".", "!", "?", ";", ":", "'"))
_DUPLICATE_QUOTES = re.compile(r"([\"'`])\1+")
_SPACES = re.compile(r"\s+")
_ENDS = re.compile(r"[.!?;:,'\")\]}…。」』】〉》›»]$")


def clean_text(text: str, lang: str | None = None) -> str:
    """The text the graphs read: normalised, no pictographs or decoration, one space, a full stop at the end.

    With ``lang`` the text is wrapped in the language tags the model was
    trained with (``<hi>...</hi>``).
    """
    value = unicodedata.normalize("NFKD", str(text or ""))
    value = _EMOJI.sub("", value)
    for old, new in _SYMBOLS.items():
        value = value.replace(old, new)
    value = _DECOR.sub("", value)
    value = value.replace("@", " at ")
    for pattern, replacement in _SPACING:
        value = pattern.sub(replacement, value)
    value = _DUPLICATE_QUOTES.sub(r"\1", value)
    value = _SPACES.sub(" ", value).strip()
    if value and not _ENDS.search(value):
        value += "."
    if lang is not None:
        if lang not in LANGUAGES and lang != UNKNOWN_LANGUAGE:
            raise ValueError(f"unsupported language {lang!r}")
        value = f"<{lang}>{value}</{lang}>"
    return value


def encode(text: str, indexer: list[int]) -> np.ndarray:
    """Code points to model ids. A character the model does not know is left out, never sent as a bad id."""
    ids = [indexer[ord(ch)] for ch in text if ord(ch) < len(indexer) and indexer[ord(ch)] >= 0]
    return np.asarray(ids, dtype=np.int64)


@dataclass(frozen=True)
class Style:
    """The two voice vectors of one voice, each shaped ``(1, rows, width)``."""

    ttl: np.ndarray
    dp: np.ndarray

    def __post_init__(self) -> None:
        if self.ttl.ndim != 3 or self.dp.ndim != 3:
            raise ValueError("a style needs two rank-3 arrays")


def load_style(path: str | os.PathLike[str]) -> Style:
    """Read one style file: ``{"style_ttl": {"dims": [...], "data": [...]}, "style_dp": {...}}``."""
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    parts: dict[str, np.ndarray] = {}
    for key in ("style_ttl", "style_dp"):
        part = raw[key]
        parts[key] = np.asarray(part["data"], dtype=np.float32).reshape(*[int(d) for d in part["dims"]])
    return Style(parts["style_ttl"], parts["style_dp"])


def blend_styles(styles: list[Style], weights: list[float] | None = None) -> Style:
    """A weighted mean of styles of the same shape: a new voice that is none of its parts.

    Weights are normalised to sum to one; a negative or all-zero weight set is refused.
    """
    if not styles:
        raise ValueError("nothing to blend")
    w = np.asarray(weights if weights is not None else [1.0] * len(styles), dtype=np.float64)
    if w.shape != (len(styles),) or not np.all(np.isfinite(w)) or np.any(w < 0) or float(w.sum()) <= 0:
        raise ValueError("blend weights must be one non-negative number per style")
    w = w / w.sum()
    for style in styles[1:]:
        if style.ttl.shape != styles[0].ttl.shape or style.dp.shape != styles[0].dp.shape:
            raise ValueError("styles of different shapes cannot be blended")
    ttl = sum(float(k) * s.ttl.astype(np.float64) for k, s in zip(w, styles, strict=True))
    dp = sum(float(k) * s.dp.astype(np.float64) for k, s in zip(w, styles, strict=True))
    return Style(np.asarray(ttl, dtype=np.float32), np.asarray(dp, dtype=np.float32))


def _length_mask(lengths: np.ndarray, width: int) -> np.ndarray:
    return (np.arange(width)[None, :] < lengths[:, None]).astype(np.float32).reshape(len(lengths), 1, width)


class FridayVoice:
    """The engine: one object per model folder. Thread-safe for one call at a time (calls are serialised)."""

    def __init__(
        self,
        model_dir: str | os.PathLike[str] | None,
        *,
        threads: int | None = None,
        sessions: dict[str, Any] | None = None,
        config: dict[str, Any] | None = None,
        indexer: list[int] | None = None,
    ) -> None:
        self.model_dir = Path(model_dir) if model_dir else None
        self.threads = threads
        self._sessions: dict[str, Any] = dict(sessions or {})
        self._lock = threading.Lock()
        self._styles: dict[str, Style] = {}
        cfg = config if config is not None else self._read_json("onnx/tts.json")
        self._indexer: list[int] = indexer if indexer is not None else self._read_json("onnx/unicode_indexer.json")
        if not isinstance(self._indexer, list) or not self._indexer:
            raise ValueError("the character table is empty")
        try:
            self.sample_rate = int(cfg["ae"]["sample_rate"])
            self._base_chunk = int(cfg["ae"]["base_chunk_size"])
            self._compress = int(cfg["ttl"]["chunk_compress_factor"])
            self._latent_dim = int(cfg["ttl"]["latent_dim"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"the voice configuration is incomplete: {error}") from error

    # ---- files -------------------------------------------------------------------------------------------------
    def _read_json(self, relative: str) -> Any:
        if self.model_dir is None:
            raise ValueError("no model folder")
        with open(self.model_dir / relative, encoding="utf-8") as handle:
            return json.load(handle)

    def _session(self, name: str) -> Any:
        found = self._sessions.get(name)
        if found is not None:
            return found
        if self.model_dir is None:
            raise RuntimeError("no model folder")
        import onnxruntime as ort  # type: ignore

        options = voice_budget.ort_session_options("tts", intra=self.threads) or ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session = ort.InferenceSession(
            str(self.model_dir / "onnx" / GRAPHS[name]), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self._sessions[name] = session
        return session

    # ---- voices ------------------------------------------------------------------------------------------------
    def style(self, name: str) -> Style:
        """A preset voice (``F1``..``M5``), read once. Anything else is refused."""
        key = str(name or "").strip().upper()
        if key not in PRESETS or self.model_dir is None:
            raise KeyError(f"no voice named {name!r}")
        if key not in self._styles:
            self._styles[key] = load_style(self.model_dir / "voice_styles" / f"{key}.json")
        return self._styles[key]

    # ---- synthesis ---------------------------------------------------------------------------------------------
    def synth(
        self,
        text: str,
        lang: str,
        style: Style,
        *,
        steps: int = 5,
        speed: float = 1.0,
        seed: int | None = None,
    ) -> np.ndarray:
        """One clause as float32 mono audio at ``sample_rate``. An empty clause gives an empty array."""
        if not SPEED_RANGE[0] <= float(speed) <= SPEED_RANGE[1]:
            raise ValueError(f"speed must be between {SPEED_RANGE[0]} and {SPEED_RANGE[1]}")
        n_steps = int(steps)
        if not STEP_RANGE[0] <= n_steps <= STEP_RANGE[1]:
            raise ValueError(f"steps must be between {STEP_RANGE[0]} and {STEP_RANGE[1]}")
        plain = clean_text(str(text or "")[:MAX_CLAUSE_CHARS])
        if encode(plain, self._indexer).size == 0 or not re.search(r"\w", plain):
            return np.zeros(0, dtype=np.float32)
        ids = encode(clean_text(plain, lang), self._indexer)
        text_ids = ids.reshape(1, -1)
        text_mask = _length_mask(np.asarray([ids.size], dtype=np.int64), ids.size)
        with self._lock:
            duration = self._session("duration").run(
                None, {"text_ids": text_ids, "style_dp": style.dp, "text_mask": text_mask}
            )[0]
            duration = np.asarray(duration, dtype=np.float32) / np.float32(speed)
            text_emb = self._session("text").run(
                None, {"text_ids": text_ids, "style_ttl": style.ttl, "text_mask": text_mask}
            )[0]
            latent, latent_mask = self._noisy_latent(duration, seed)
            total = np.asarray([n_steps], dtype=np.float32)
            estimator = self._session("estimator")
            for step in range(n_steps):
                latent = estimator.run(
                    None,
                    {
                        "noisy_latent": latent,
                        "text_emb": text_emb,
                        "style_ttl": style.ttl,
                        "text_mask": text_mask,
                        "latent_mask": latent_mask,
                        "current_step": np.asarray([step], dtype=np.float32),
                        "total_step": total,
                    },
                )[0]
            wav = self._session("vocoder").run(None, {"latent": latent})[0]
        audio = np.asarray(wav, dtype=np.float32).reshape(-1)
        keep = int(float(duration.reshape(-1)[0]) * self.sample_rate)
        if 0 < keep < audio.size:
            audio = audio[:keep]
        return np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)

    def _noisy_latent(self, duration: np.ndarray, seed: int | None) -> tuple[np.ndarray, np.ndarray]:
        seconds = float(duration.reshape(-1)[0])
        samples = np.asarray([int(seconds * self.sample_rate)], dtype=np.int64)
        chunk = self._base_chunk * self._compress
        frames = max(1, int((int(seconds * self.sample_rate) + chunk - 1) // chunk))
        rng = np.random.RandomState(seed) if seed is not None else np.random
        noise = rng.randn(1, self._latent_dim * self._compress, frames).astype(np.float32)
        mask = _length_mask(((samples + chunk - 1) // chunk).astype(np.int64), frames)
        return noise * mask, mask

    def warm_up(self) -> float:
        """One short synthesis so the graphs are opened and their memory is allocated. Seconds taken."""
        import time

        started = time.monotonic()
        self.synth("ok", "en", self.style("F2"), steps=2, seed=1)
        return time.monotonic() - started


# ---- one engine per folder ----------------------------------------------------------------------------------
_cache: dict[str, FridayVoice] = {}
_cache_lock = threading.Lock()
_REQUIRED = tuple(f"onnx/{name}" for name in GRAPHS.values()) + ("onnx/tts.json", "onnx/unicode_indexer.json")


def complete(model_dir: str | os.PathLike[str] | None) -> bool:
    """True when every graph and table is in the folder."""
    if not model_dir:
        return False
    base = Path(model_dir)
    return all((base / name).is_file() for name in _REQUIRED)


def open_voice(model_dir: str | os.PathLike[str] | None, *, threads: int | None = None) -> FridayVoice | None:
    """The engine for a model folder, or ``None`` when it cannot run here. Never raises, never downloads."""
    if not complete(model_dir):
        return None
    key = str(Path(str(model_dir)).resolve())
    with _cache_lock:
        found = _cache.get(key)
        if found is not None:
            return found
        try:
            import onnxruntime  # type: ignore  # noqa: F401

            voice = FridayVoice(model_dir, threads=threads)
        except Exception:  # noqa: BLE001 - a folder that will not open is simply not available
            return None
        _cache[key] = voice
        return voice


def forget() -> None:
    """Drop every cached engine (tests, and a model swap)."""
    with _cache_lock:
        _cache.clear()
