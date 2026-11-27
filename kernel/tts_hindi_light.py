"""FRIDAY's light Hindi voice: a small Hindi text-to-speech model that runs on this PC with no torch.

The weights are ``sulabhkatiyar/indic-tiny-tts-hindi`` (ONNX: a text encoder, a flow decoder and a Vocos vocoder,
about 91 MB). The model files are CC-BY-4.0 (credit: Sulabh Katiyar, trained on AI4Bharat Rasa), the vocoder is MIT;
the credit is shown in the Models page row. They are downloaded on demand by the Install Manager into
``<FRIDAY root>/models/hindi-light-tts`` at a pinned revision and SHA-256 (``electron/voice-pins.cjs``); this module
never downloads. It is off until they are there and is never the default voice: Supertonic stays the speaker, and
answers whenever this voice is not installed, fails, or is handed text it cannot say in full.

Only numpy and onnxruntime run here. The upstream package also ships a large text normaliser and a Latin-to-Hindi
reader; they are not used. FRIDAY's Speech Prep already writes English words and numbers in Devanagari before the
voice speaks, so this file keeps a thin frontend of its own: Devanagari text only. A line with a Latin letter or a
digit is refused (``speakable``) so a word is never skipped silently, and Supertonic reads it instead.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any

import friday_runtime

MODEL_DIR = "hindi-light-tts"
GRAPHS = ("text_encoder", "flow_decoder", "vocoder")
REQUIRED = (
    "onnx/text_encoder.onnx",
    "onnx/flow_decoder.onnx",
    "onnx/vocoder.onnx",
    "config.json",
    "onnx/onnx_manifest.json",
)
# The smallest pinned graph is 17,695,838 bytes; anything far smaller is a partial download.
MIN_GRAPH_BYTES = 10_000_000
MAX_CHUNK = 250  # characters; the model takes 2,048 tokens, a chunk of 250 letters is about 500
MIN_FRAMES = 2  # a chunk that comes out shorter than this is skipped; the vocoder's inverse STFT needs two frames
SPEED_RANGE = (0.7, 2.0)
VOICES = {"F": "female", "M": "male"}
DEFAULT_VOICE = "female"
LICENSE = "CC-BY-4.0 model weights (credit: Sulabh Katiyar, AI4Bharat Rasa data), MIT code and vocoder"

_INVISIBLE = dict.fromkeys(map(ord, "​﻿⁠­‌‍"))
_PAUSE_LIKE = {":": ",", ";": ",", "…": ".", "–": ",", "—": ","}
_SENTENCE_END = re.compile(r"(?<=[।?!.])\s+")
_SPACES = re.compile(r"\s+")
_engine = None
_engine_dir = ""
_failed_dir = ""


def model_dir() -> Path | None:
    """The folder with every pinned file on disk, or None. This does not download or open the model."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    folder = (Path(root) if root else Path.home() / ".friday") / "models" / MODEL_DIR
    try:
        for name in REQUIRED:
            file = folder / name
            if not file.is_file():
                return None
            if name.endswith(".onnx") and file.stat().st_size < MIN_GRAPH_BYTES:
                return None
    except OSError:
        return None
    return folder


def ready() -> bool:
    return model_dir() is not None


def _devanagari_letter(char: str) -> bool:
    code = ord(char)
    return 0x0904 <= code <= 0x0939 or 0x0958 <= code <= 0x0961


def speakable(text: str) -> bool:
    """True when the whole line is Devanagari this voice can say: no Latin or other letter, no digit to be skipped."""
    value = text or ""
    if not any(_devanagari_letter(char) for char in value):
        return False
    return not any(char.isdigit() or (char.isalpha() and not 0x0900 <= ord(char) <= 0x097F) for char in value)


def frontend(text: str, vocab) -> str:
    """The characters the model reads. The text is kept as written; only what the model has no symbol for changes.

    NFC, invisible joiners removed, a double danda is one danda, a colon or semicolon becomes a comma, an ellipsis a
    full stop; any other symbol the model does not know is a space. Words are never replaced.
    """
    value = unicodedata.normalize("NFC", text or "").translate(_INVISIBLE).replace("॥", "।")
    out = []
    for char in value:
        if char in vocab or char == " ":
            out.append(char)
        elif _PAUSE_LIKE.get(char) in vocab:
            out.append(_PAUSE_LIKE[char])
        else:
            out.append(" ")
    return _SPACES.sub(" ", "".join(out)).strip()


def chunks(text: str) -> list[str]:
    """Sentence-sized pieces, none over ``MAX_CHUNK`` characters, each with a letter in it."""
    pieces: list[str] = []
    for sentence in _SENTENCE_END.split(text or ""):
        while len(sentence) > MAX_CHUNK:
            cut = sentence.rfind(",", 0, MAX_CHUNK)
            cut = cut + 1 if cut > 0 else sentence.rfind(" ", 0, MAX_CHUNK)
            if cut <= 0:
                cut = MAX_CHUNK
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        pieces.append(sentence.strip())
    return [piece for piece in pieces if any(char.isalpha() for char in piece)]


def token_ids(chunk: str, table: dict) -> list[int]:
    """Symbol ids with a blank (id 0) around every symbol, the way the model was trained. KeyError for a stranger."""
    ids = [table["c:" + char] for char in chunk]
    out = [0] * (2 * len(ids) + 1)
    out[1::2] = ids
    return out


def durations(logw, length_scale: float, frame_multiple: int):
    """Per-token frame counts, the frame count and its padded size: ceil(exp(logw)) * scale, at least one frame."""
    import numpy as np  # type: ignore

    w_ceil = np.ceil(np.exp(np.asarray(logw, dtype=np.float32))).astype(np.float32) * np.float32(length_scale)
    frames = int(max(np.float32(np.sum(w_ceil, dtype=np.float64)), np.float32(1.0)))
    padded = -(-frames // frame_multiple) * frame_multiple
    return w_ceil, frames, padded


def length_regulate(mu_x, w_ceil, frames: int, padded: int):
    """Spread each token's vector over its frames: ([channels, padded] vectors, [padded] mask of real frames)."""
    import numpy as np  # type: ignore

    cum = np.cumsum(np.asarray(w_ceil).astype(np.float64)).astype(np.float32)
    position = np.arange(padded, dtype=np.float32)
    token = np.searchsorted(cum, position, side="right")  # the first token whose running total passes the frame
    valid = (token < len(cum)) & (position < np.float32(frames))
    mu_y = np.where(valid[None, :], mu_x[:, np.minimum(token, len(cum) - 1)], np.float32(0.0)).astype(np.float32)
    return mu_y, valid.astype(np.float32)


def istft(real, imag, n_fft: int, hop: int, padding: str = "center"):
    """A [bins, frames] spectrum back to a waveform: overlap-add of Hann-windowed frames, envelope-normalised."""
    import numpy as np  # type: ignore

    if padding not in ("center", "same"):
        raise ValueError(padding)
    spec = np.asarray(real, dtype=np.float64) + 1j * np.asarray(imag, dtype=np.float64)
    count = spec.shape[1]
    window = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n_fft) / n_fft)
    frames = np.fft.irfft(spec, n=n_fft, axis=0).T * window
    total = n_fft + hop * (count - 1)
    signal = np.zeros(total)
    envelope = np.zeros(total)
    for index in range(count):
        signal[index * hop : index * hop + n_fft] += frames[index]
        envelope[index * hop : index * hop + n_fft] += window * window
    pad = n_fft // 2 if padding == "center" else (n_fft - hop) // 2
    signal, envelope = signal[pad : total - pad], envelope[pad : total - pad]
    if (envelope < 1e-11).any():
        raise RuntimeError("the inverse STFT windows do not overlap enough")
    return (signal / envelope).astype(np.float32)


def _linspace(steps: int):
    import numpy as np  # type: ignore

    return np.linspace(0.0, 1.0, steps).astype(np.float32)


class _OnnxEngine:
    """The three ONNX graphs behind the small interface ``synthesize`` uses (a fake takes its place in tests)."""

    def __init__(self, folder: Path):
        import numpy as np  # type: ignore

        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        manifest = json.loads((folder / "onnx" / "onnx_manifest.json").read_text(encoding="utf-8"))
        vocab = config["vocab"]
        if vocab.get("mode") != "chr" or not vocab.get("add_blank", True):
            raise ValueError("this model does not read characters with blanks")
        self.table = {symbol: index for index, symbol in enumerate(vocab["symbols"])}
        self.vocab = frozenset(symbol[2:] for symbol in vocab["symbols"] if symbol.startswith("c:"))
        self.sample_rate = int(config["sample_rate"])
        self.voices = dict(config["voices"])
        self.ids = config["ids"]
        synthesis = config.get("synthesis", {})
        self.steps = int(synthesis.get("n_timesteps", 4))
        self.temperature = float(synthesis.get("temperature", 0.667))
        self.length_scale = dict(synthesis.get("length_scale", {}))
        self.style = synthesis.get("style", "read")
        self.pause_seconds = float(synthesis.get("sentence_pause_s", 0.15))
        self.mel_mean, self.mel_std = (np.float32(value) for value in config["mel_stats"])
        head = config["vocoder"]["head"]
        self.n_fft, self.hop, self.padding = int(head["n_fft"]), int(head["hop_length"]), head.get("padding", "center")
        self.frame_multiple = int(manifest["frame_multiple"])
        self.max_tokens = int(manifest["max_tokens"])

        def configure(options: Any, runtime: Any, _used: list[str]) -> None:
            options.graph_optimization_level = runtime.GraphOptimizationLevel.ORT_ENABLE_ALL

        self.sessions = {
            name: friday_runtime.open_session(folder / "onnx" / f"{name}.onnx", "tts_light", configure=configure)
            for name in GRAPHS
        }

    def synth_chunk(self, chunk: str, voice: str, speed: float, rng):
        import numpy as np  # type: ignore

        ids = token_ids(chunk, self.table)
        if len(ids) > self.max_tokens:
            raise ValueError("the text is longer than the model takes")
        speaker = self.voices[voice]
        i64 = np.int64
        encoded = self.sessions["text_encoder"].run(
            None,
            {
                "tokens": np.asarray([ids], dtype=i64),
                "token_lengths": np.asarray([len(ids)], dtype=i64),
                "language": np.asarray([self.ids["language"]], dtype=i64),
                "speaker": np.asarray([self.ids["speakers"][speaker]], dtype=i64),
                "style": np.asarray([self.ids["styles"][self.style]], dtype=i64),
            },
        )
        mu_x, logw, cond = (np.asarray(array) for array in encoded)
        scale = float(self.length_scale.get(speaker, 1.0)) / float(speed)
        w_ceil, frames, padded = durations(logw[0, 0], scale, self.frame_multiple)
        if frames < MIN_FRAMES:
            return np.zeros(0, dtype=np.float32)
        mu_y, mask = length_regulate(mu_x[0], w_ceil, frames, padded)
        x = rng.standard_normal((1, mu_y.shape[0], padded), dtype=np.float32) * np.float32(self.temperature)
        mu = mu_y.reshape(1, *mu_y.shape).astype(np.float32)
        mask = mask.reshape(1, 1, -1).astype(np.float32)
        span = _linspace(self.steps + 1)
        t, dt = span[0], span[1] - span[0]
        for step in range(1, len(span)):  # Euler steps along the flow
            fed = {"x": x, "mask": mask, "mu": mu, "t": np.asarray([t], np.float32), "cond": cond}
            x = x + dt * np.asarray(self.sessions["flow_decoder"].run(None, fed)[0])
            t = t + dt
            if step < len(span) - 1:
                dt = span[step + 1] - t
        mel = (x[:, :, :frames] * self.mel_std + self.mel_mean).astype(np.float32)
        real, imag = (np.asarray(array) for array in self.sessions["vocoder"].run(None, {"mel": mel}))
        return np.clip(istft(real[0], imag[0], self.n_fft, self.hop, self.padding), -1.0, 1.0)


def _load_engine(folder: Path):
    return _OnnxEngine(folder)


def _voice_for(style: str) -> str:
    """Female for F1..F5 and anything unknown, male for M1..M5 (the same style names the other voice takes)."""
    first = (style or "").strip().upper()[:1]
    return VOICES.get(first, DEFAULT_VOICE)


def synthesize(text: str, speed: float = 1.0, style: str = "", seed: int | None = None):
    """(float32 mono samples, sample rate) for a Devanagari line, or None to let the caller's own voice speak."""
    global _engine, _engine_dir, _failed_dir
    folder = model_dir()
    if folder is None or _failed_dir == str(folder) or not speakable(text):
        return None
    try:
        import numpy as np  # type: ignore

        if _engine is None or _engine_dir != str(folder):
            _engine = _load_engine(folder)
            _engine_dir = str(folder)
    except Exception:  # noqa: BLE001 — a model that will not open is remembered; the other voice speaks instead
        _failed_dir = str(folder)
        _engine = None
        return None
    engine = _engine
    try:
        rate = min(SPEED_RANGE[1], max(SPEED_RANGE[0], float(speed or 1.0)))
        voice = _voice_for(style)
        rng = np.random.default_rng(seed)
        pause = np.zeros(int(engine.pause_seconds * engine.sample_rate), dtype=np.float32)
        parts = []
        for chunk in chunks(frontend(text, engine.vocab)):
            audio = np.asarray(engine.synth_chunk(chunk, voice, rate, rng), dtype=np.float32).reshape(-1)
            if not audio.size:
                continue
            if parts:
                parts.append(pause)
            parts.append(audio)
        if not parts:
            return None
        return np.clip(np.concatenate(parts), -1.0, 1.0).astype(np.float32), int(engine.sample_rate)
    except Exception:  # noqa: BLE001 — a failing run is the caller's fallback, never a crash or a silent line
        return None


def status() -> dict:
    """What the voice status op reports: installed or not. Opening the model is not done here."""
    installed = ready()
    return {
        "ready": installed,
        "engine": "hindi-light",
        "voices": sorted(VOICES.values()),
        "reason": "" if installed else "the light Hindi voice is not installed",
        "license": LICENSE,
    }
