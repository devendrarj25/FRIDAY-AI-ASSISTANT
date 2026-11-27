"""FRIDAY Ear Quick: the fast English final-pass ear, an own runner for the Moonshine tiny ONNX pair.

Two graphs (an encoder, and a merged decoder with a key/value cache) are opened through ``friday_runtime.open_session``
under the ``asr_final`` budget, so the thread budget, the SHA-256 check and the CPU fallback are the same as for every
other voice graph. The text comes from ``tokenizer.json`` of the same model; its decoder is a few lines of Python (a
SentencePiece style byte-fallback vocabulary), so no tokenizer package is needed.

Contract: raw 16 kHz mono float32 audio goes into the encoder (no normalisation); the decoder runs greedily from the
start token to the end token; the cache of the decoder grows each step and the cache of the encoder is fixed after the
first step. The model hears about 30 s at most, so longer audio is cut into windows and the texts are joined. This is
the non-streaming network: it gives a final text, not live partials.

Not wired into ``stt.py`` yet; the numbers and the swap point are in docs/FRIDAY_VOICE_ENGINE.md when it is.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import friday_runtime
import numpy as np

ROLE = "asr_final"
SAMPLE_RATE = 16000
MIN_SAMPLES = 1600  # 0.1 s; the encoder cannot frame less
WINDOW_SECONDS = 25.0  # the model hears about 30 s; stay well inside
TOKENS_PER_SECOND = 6.5  # upper bound of speech, used only to stop a runaway loop
BOS, EOS = 1, 2
ENCODER_FILE = "encoder_model.onnx"
DECODER_FILE = "decoder_model_merged.onnx"
TOKENIZER_FILE = "tokenizer.json"
_BYTE_TOKEN = re.compile(r"^<0x([0-9A-Fa-f]{2})>$")
_KV_PARTS = ("decoder.key", "decoder.value", "encoder.key", "encoder.value")


class EarQuickError(RuntimeError):
    """The model could not be opened, or the graphs do not look like the Moonshine decoder."""


class Detokenizer:
    """Ids to text for a SentencePiece style byte-level vocabulary (``tokenizer.json`` of Moonshine)."""

    def __init__(self, pieces: dict[int, str], special: set[int]) -> None:
        self._pieces = pieces
        self._special = special

    @classmethod
    def from_file(cls, path: str | Path) -> Detokenizer:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            vocab = data["model"]["vocab"]
            pieces = {int(i): str(t) for t, i in vocab.items()}
            special = {int(a["id"]) for a in data.get("added_tokens", []) if a.get("special")}
            for added in data.get("added_tokens", []):
                pieces.setdefault(int(added["id"]), str(added["content"]))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise EarQuickError(f"tokenizer file unreadable: {type(exc).__name__}") from exc
        return cls(pieces, special | {0, BOS, EOS})

    def decode(self, ids: Sequence[int]) -> str:
        out = bytearray()
        for token in ids:
            if token in self._special:
                continue
            piece = self._pieces.get(int(token))
            if piece is None:
                continue
            byte = _BYTE_TOKEN.match(piece)
            out += bytes([int(byte.group(1), 16)]) if byte else piece.replace("▁", " ").encode("utf-8")
        return out.decode("utf-8", errors="replace").strip()


def _to_float32(audio: Any, sample_rate: int) -> np.ndarray:
    if sample_rate != SAMPLE_RATE:
        raise EarQuickError(f"Ear Quick takes {SAMPLE_RATE} Hz audio, not {sample_rate}")
    data = np.asarray(audio)
    if data.dtype.kind in "iu":
        data = data.astype(np.float32) / 32768.0
    return np.ascontiguousarray(data.reshape(-1), dtype=np.float32)


class EarQuick:
    """Moonshine tiny, greedy, with the decoder cache fed back each step. One instance serves one thread at a time."""

    def __init__(self, encoder: Any, decoder: Any, tokens: Detokenizer) -> None:
        self._encoder = encoder
        self._decoder = decoder
        self._tokens = tokens
        inputs = list(decoder.get_inputs())
        self._input_names = {i.name for i in inputs}
        self._cache_inputs = [i for i in inputs if i.name.startswith("past_key_values.")]
        if not self._cache_inputs:
            raise EarQuickError("the decoder has no cache inputs")
        shape = self._cache_inputs[0].shape
        try:
            self._heads, self._head_dim = int(shape[1]), int(shape[3])
        except (TypeError, ValueError, IndexError) as exc:
            raise EarQuickError("the decoder cache shape is not [batch, heads, steps, dim]") from exc
        self._outputs = [o.name for o in decoder.get_outputs()]
        self._encoder_input = list(encoder.get_inputs())[0].name

    @classmethod
    def load(
        cls,
        folder: str | Path,
        quantized: bool = True,
        tokenizer: str | Path | None = None,
        sha256: dict[str, str] | None = None,
        intra: int | None = None,
    ) -> EarQuick:
        """Open ``folder/{quantized|float}`` (the layout of the upstream repository); ``tokenizer`` defaults to
        ``folder/tokenizer.json``. ``sha256`` maps a file name to its pinned hash and makes the door check it;
        ``intra`` is a thread count the caller was told to use (the role's budget otherwise)."""
        base = Path(folder)
        graphs = base / ("quantized" if quantized else "float")
        pins = sha256 or {}
        try:
            encoder = friday_runtime.open_session(
                graphs / ENCODER_FILE, ROLE, sha256=pins.get(ENCODER_FILE), intra=intra
            )
            decoder = friday_runtime.open_session(
                graphs / DECODER_FILE, ROLE, sha256=pins.get(DECODER_FILE), intra=intra
            )
        except friday_runtime.FridayRuntimeError as exc:
            raise EarQuickError(str(exc)) from exc
        return cls(encoder, decoder, Detokenizer.from_file(tokenizer or base / TOKENIZER_FILE))

    def transcribe(self, audio: Any, sample_rate: int = SAMPLE_RATE) -> str:
        """The English text of ``audio`` (float32 in -1..1 or int16 PCM), windows of 25 s joined with a space."""
        samples = _to_float32(audio, sample_rate)
        window = int(WINDOW_SECONDS * SAMPLE_RATE)
        parts: list[str] = []
        for start in range(0, len(samples), window):
            chunk = samples[start : start + window]
            if len(chunk) < MIN_SAMPLES:
                continue
            text = self._transcribe_window(chunk)
            if text:
                parts.append(text)
        return " ".join(parts)

    def _transcribe_window(self, samples: np.ndarray) -> str:
        hidden = self._encoder.run(None, {self._encoder_input: samples.reshape(1, -1)})[0]
        empty = np.zeros((1, self._heads, 0, self._head_dim), dtype=np.float32)
        cache = {spec.name: empty for spec in self._cache_inputs}
        limit = int(len(samples) / SAMPLE_RATE * TOKENS_PER_SECOND) + 4
        ids: list[int] = []
        current, warm = BOS, False
        for _ in range(limit):
            feed: dict[str, Any] = {
                "input_ids": np.array([[current]], dtype=np.int64),
                "encoder_hidden_states": hidden,
                **cache,
            }
            if "use_cache_branch" in self._input_names:
                feed["use_cache_branch"] = np.array([warm])
            result = self._decoder.run(None, feed)
            following = int(np.argmax(result[0][0, -1]))
            for name, value in zip(self._outputs[1:], result[1:], strict=False):
                key = name.replace("present.", "past_key_values.", 1)
                if warm and ".encoder." in key:
                    continue  # the encoder side of the cache is fixed after the first step
                cache[key] = value
            warm = True
            if following == EOS:
                break
            ids.append(following)
            current = following
        return self._tokens.decode(ids)
