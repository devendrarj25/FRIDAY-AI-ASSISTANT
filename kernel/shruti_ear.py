"""FRIDAY Ear Swift: a small Hindi, Hinglish and Indian-English ear (numpy and onnxruntime only).

The weights are Shruti (Apache-2.0; the NOTICE that credits its base author stays with the pinned download), exported to
ONNX as three graphs: a frontend (16 kHz audio to features), an encoder (features to audio memory) and a stateful
one-token decoder. The decoding is an attention encoder-decoder search, so none of the CTC or transducer runners fit:
5-beam search with length-normalised scores, language tag tokens (the model's own Hindi and English, picked by the first
decoder step when the caller does not say), SentencePiece-style detokenising from ``shruti.json`` (a leading U+2581 is a
space, ``<0xNN>`` pieces are raw UTF-8 bytes), windows of at most 30 s, a silence guard and a cut for a runaway token
loop. The method follows the Apache-2.0 reference runner; this file is FRIDAY's own port of it with no
``huggingface_hub``, ``soxr`` or number normaliser, and every graph opens through ``friday_runtime`` (thread budget,
hash check, CPU fallback). This module never downloads: the Install Manager puts the files into
``<FRIDAY root>/models/shruti-ear`` at a pinned revision and SHA-256.

It is a final-pass ear (the text arrives when the search ends; there are no word-by-word partials). Like ``hindi_ear``,
``transcribe`` returns None whenever it cannot or should not answer, so the caller's other ear hears the utterance. The
text goes through the script policy (``stt_bench.fix_script``: Hindi words in Devanagari, English words in Latin) and is
never otherwise changed. Not wired into ``stt.py`` routing yet.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import friday_runtime
import numpy as np

MODEL_DIR = "shruti-ear"
FRONTEND, ENCODER, DECODER, VOCAB = "frontend.onnx", "encoder.onnx", "decoder.onnx", "shruti.json"
REQUIRED = (FRONTEND, ENCODER, DECODER, VOCAB)
# The smallest real files (the 4-bit encoder is 10.6 MB, the decoder 20.5 MB); far smaller is a partial download.
MIN_BYTES = {ENCODER: 5_000_000, DECODER: 10_000_000}
SAMPLE_RATE = 16000
MIN_SECONDS = 0.2
MAX_SECONDS = 60
WINDOW_SECONDS = 30.0
BEAMS = 5
TOKENS_PER_SECOND = 12.0  # the decoder's token cap grows with the audio
SILENCE_PEAK = 1e-4  # a window whose loudest sample is below this is digital silence
BASE_TAGS = ("en", "de", "fr", "es", "it", "nl", "pl")  # the base model's tags; a Shruti model adds its own language
LOOP_PERIOD = 8  # a loop is a pattern of up to this many tokens ...
LOOP_REPEATS = 3  # ... repeated this many times back to back
LOAD_MB = 800.0  # the 4-bit build expands to about 0.7 GB in the runtime (int8 about 0.3 GB)
# Number of runtime threads; None lets the voice thread budget decide.
threads: int | None = None


def admit_all(_kind: str, _mb: float) -> bool:
    """The admission of a module run alone (tests, tools): every load may open. The worker sets ``admit_hook``."""
    return True


admit_hook: Callable[[str, float], bool] = admit_all
# A folder the runtime could not open, keyed by the decoder file's mtime and size: tried once, not on every utterance.
_broken: dict[tuple[str, int, int], str] = {}
_last_skip = ""  # why the last read did not run: "", "low-memory" (refused) or "broken"
_last_language = ""
_last_confidence: float | None = None
_ear: ShrutiRunner | None = None
_ear_dir = ""


class EarSkipped(RuntimeError):
    """The ear did not open: ``kind`` is ``low-memory`` (the worker refused the load) or ``broken``."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


# ---- the three graphs and the search ---------------------------------------------------------------------------------


def logsoftmax(x: np.ndarray) -> np.ndarray:
    x = x - x.max(-1, keepdims=True)
    return x - np.log(np.exp(x).sum(-1, keepdims=True))


def cut_loops(ids: list[int], max_period: int = LOOP_PERIOD, repeats: int = LOOP_REPEATS) -> list[int]:
    """Cut a token loop (up to ``max_period`` tokens repeated ``repeats``+ times in a row): keep one copy."""
    n = len(ids)
    for start in range(n):
        for k in range(1, max_period + 1):
            if start + k * repeats > n:
                break
            pattern = ids[start : start + k]
            if all(ids[start + r * k : start + (r + 1) * k] == pattern for r in range(1, repeats)):
                return ids[: start + k]
    return ids


class ShrutiRunner:
    """The frontend, encoder and decoder sessions of one Shruti model, and the beam search over them."""

    def __init__(self, frontend: Any, encoder: Any, decoder: Any, meta: Mapping[str, Any]) -> None:
        self.frontend, self.encoder, self.decoder = frontend, encoder, decoder
        self.vocab: list[str] = list(meta["vocab"])
        cfg = meta["config"]
        self.hop = int(cfg["hop"])
        self.max_tokens = int(cfg["max_tokens"])
        self.text, self.bos, self.eos = int(cfg["text"]), int(cfg["bos"]), int(cfg["eos"])
        tag_names = list(cfg["languages"])
        self.tags = {lang: self.text + i for i, lang in enumerate(tag_names)}
        own = [lang for lang in tag_names if lang not in BASE_TAGS]
        self.languages: tuple[str, str] = (own[0] if own else "hi", "en")  # the model's own language and English
        inputs = list(decoder.get_inputs())
        self.state_names = [i.name for i in inputs][2:]
        shapes = {i.name: i.shape for i in inputs}
        self.state_shapes = {n: [d if isinstance(d, int) else 0 for d in shapes[n]] for n in self.state_names}
        self.confidence: float | None = None  # mean log-probability per token of the last beam-searched window

    def detok(self, ids: Sequence[int]) -> str:
        """Pieces to text: U+2581 is a space, ``<0xNN>`` pieces are raw UTF-8 bytes, other ``<...>`` are control."""
        out: list[str] = []
        raw = bytearray()
        for i in ids:
            piece = self.vocab[i] if 0 <= i < len(self.vocab) else ""
            if len(piece) == 6 and piece.startswith("<0x") and piece.endswith(">"):
                try:
                    raw.append(int(piece[3:5], 16))
                    continue
                except ValueError:
                    pass
            if raw:
                out.append(raw.decode("utf-8", "ignore"))
                raw.clear()
            if not (piece.startswith("<") and piece.endswith(">")):
                out.append(piece)
        if raw:
            out.append(raw.decode("utf-8", "ignore"))
        return "".join(out).replace("▁", " ").strip()

    def init_state(self, batch: int) -> dict[str, np.ndarray]:
        state: dict[str, np.ndarray] = {}
        for name in self.state_names:
            shape = list(self.state_shapes[name])
            if name == "pos":
                state[name] = np.zeros(1, np.int64)
                continue
            shape[0] = batch
            state[name] = np.zeros(shape, np.int64 if name == "hist" else np.float32)
        return state

    def step(
        self, tokens: np.ndarray, cross: np.ndarray, state: dict[str, np.ndarray]
    ) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        out = self.decoder.run(None, {"tokens": tokens, "cross": cross, **state})
        return np.array(out[0][:, 0], dtype=np.float32), dict(zip(self.state_names, out[1:], strict=False))

    def encode(self, wav: np.ndarray) -> np.ndarray:
        feats = self.frontend.run(None, {"audio": wav[None].astype(np.float32)})[0]
        frames = np.array([len(wav) // self.hop], np.int64)
        return self.encoder.run(None, {"features": feats, "frames": frames})[0]

    def transcribe(
        self,
        audio: Any,
        language: str | None = None,
        beams: int = BEAMS,
        window_s: float = WINDOW_SECONDS,
        loops: str = "cut",
    ) -> dict[str, Any]:
        """16 kHz mono float samples in [-1, 1] -> ``{"text", "language", "tokens", "confidence"}``.

        ``language`` is the model's own language, ``en`` or None to detect between them. ``beams`` 5 is the engine's
        search, 1 is greedy. ``loops`` ``cut`` drops a token loop after its first copy, ``off`` keeps the output.
        Up to ``window_s`` is one pass; longer audio is cut into equal windows of at most that length."""
        if language is not None and language not in self.languages:
            raise ValueError(f"language must be one of {self.languages} or None, not {language!r}")
        wav = np.asarray(audio, np.float32).reshape(-1)
        self.confidence = None
        if wav.size == 0 or float(np.abs(wav).max()) < SILENCE_PEAK:  # digital silence: nothing to hear
            return {"text": "", "language": language, "tokens": [], "confidence": None}
        count = max(1, int(np.ceil(wav.size / (window_s * SAMPLE_RATE))))
        parts = [self._window(w, language, beams, loops) for w in np.array_split(wav, count)]
        scores = [p["confidence"] for p in parts if p["confidence"] is not None]
        self.confidence = float(np.mean(scores)) if scores else None
        return {
            "text": " ".join(p["text"] for p in parts if p["text"]),
            "language": parts[0]["language"],
            "tokens": [t for p in parts for t in p["tokens"]],
            "confidence": self.confidence,
        }

    def _window(self, wav: np.ndarray, language: str | None, beams: int, loops: str) -> dict[str, Any]:
        tidy: Callable[[list[int]], list[int]] = cut_loops if loops == "cut" else (lambda ids: ids)
        cross = self.encode(wav)
        cap = int(min(self.max_tokens - 2, wav.size / SAMPLE_RATE * TOKENS_PER_SECOND + 8))
        state = self.init_state(1)
        if language is None:
            lg, state = self.step(np.array([[self.bos]], np.int64), cross, state)
            language = max(self.languages, key=lambda lang: float(lg[0, self.tags[lang]]))
            lg, state = self.step(np.array([[self.tags[language]]], np.int64), cross, state)
        else:
            lg, state = self.step(np.array([[self.bos, self.tags[language]]], np.int64), cross, state)
        lg[:, self.text :] = -np.inf
        if beams <= 1:
            ids: list[int] = []
            for _ in range(cap):
                k = int(lg[0].argmax())
                if k == self.eos:
                    break
                ids.append(k)
                lg, state = self.step(np.array([[k]], np.int64), cross, state)
                lg[:, self.text :] = -np.inf
            ids = tidy(ids)
            return {"text": self.detok(ids), "language": language, "tokens": ids, "confidence": None}

        def norm(score: float, seq: Sequence[int]) -> float:
            return score / (len(seq) + 1)

        logp = logsoftmax(lg[0])
        first = np.argsort(-logp)[:beams]
        seqs: list[list[int]] = [[int(k)] for k in first]
        scores = logp[first].astype(np.float64)
        finished: list[tuple[float, list[int]]] = [
            (float(scores[i]), s[:-1]) for i, s in enumerate(seqs) if s[-1] == self.eos
        ]
        live = [i for i, s in enumerate(seqs) if s[-1] != self.eos]
        seqs, scores = [seqs[i] for i in live], scores[live]
        state = {n: (v if n == "pos" else np.repeat(v, len(seqs), 0)) for n, v in state.items()}
        for _ in range(cap - 1):
            if not seqs:
                break
            lg, state = self.step(np.array([[s[-1]] for s in seqs], np.int64), cross, state)
            lg[:, self.text :] = -np.inf
            cand = scores[:, None] + logsoftmax(lg)
            new_seqs: list[list[int]] = []
            new_scores: list[float] = []
            src: list[int] = []
            for flat in np.argsort(-cand, axis=None)[: 2 * beams]:
                b, k = divmod(int(flat), cand.shape[1])
                if k == self.eos:
                    finished.append((float(cand[b, k]), seqs[b]))
                else:
                    new_seqs.append(seqs[b] + [k])
                    new_scores.append(float(cand[b, k]))
                    src.append(b)
                if len(new_seqs) == beams:
                    break
            best_done = max((norm(sc, s) for sc, s in finished), default=-np.inf)
            if len(finished) >= beams and (
                not new_scores or max(norm(sc, s) for sc, s in zip(new_scores, new_seqs, strict=True)) < best_done
            ):
                break
            seqs, scores = new_seqs, np.array(new_scores)
            state = {n: (v if n == "pos" else v[src]) for n, v in state.items()}
        if not finished:
            finished = [(float(sc), s) for sc, s in zip(scores, seqs, strict=True)]
        best_score, best_seq = max(finished, key=lambda f: norm(*f))
        best = tidy(best_seq)
        return {
            "text": self.detok(best),
            "language": language,
            "tokens": best,
            "confidence": norm(best_score, best_seq),
        }


# ---- the module surface the speech worker uses (same shape as hindi_ear) ---------------------------------------------


def model_dir() -> Path | None:
    """The folder with the four files on disk, or None. This does not download or open the model."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    folder = (Path(root) if root else Path.home() / ".friday") / "models" / MODEL_DIR
    try:
        for name in REQUIRED:
            if not (folder / name).is_file():
                return None
        for name, least in MIN_BYTES.items():
            if (folder / name).stat().st_size < least:
                return None
    except OSError:
        return None
    return folder


def _folder_key(folder: Path) -> tuple[str, int, int]:
    try:
        stat = (folder / DECODER).stat()
    except OSError:
        return (str(folder), 0, 0)
    return (str(folder), stat.st_mtime_ns, stat.st_size)


def ready() -> bool:
    """The files are on disk and this worker has not found them unreadable."""
    folder = model_dir()
    return folder is not None and _folder_key(folder) not in _broken


def error() -> str | None:
    """Why the ear on disk cannot open (no folder names), or None."""
    folder = model_dir()
    return None if folder is None else _broken.get(_folder_key(folder))


def last_skip() -> str:
    """Why the last read did not run: "" (it ran, or there was nothing to read), "low-memory" or "broken"."""
    return _last_skip


def last_language() -> str:
    """The language the last read was decoded in (``hi`` or ``en``), or "" when it did not run."""
    return _last_language


def last_confidence() -> float | None:
    """Mean log-probability per token of the last beam-searched read, or None."""
    return _last_confidence


def _error_text(exc: BaseException) -> str:
    try:
        from voice_runtime import _safe_error

        return _safe_error(exc)
    except Exception:  # noqa: BLE001 - without the scrubber only the class name leaves
        return type(exc).__name__


def _open(path: Path) -> Any:
    def quiet(options: Any, _ort: Any, _used: list[str]) -> None:
        options.log_severity_level = 3

    return friday_runtime.open_session(path, "asr_final", intra=threads, configure=quiet)


def load_runner(folder: Path, opener: Callable[[Path], Any] | None = None) -> ShrutiRunner:
    """Open the three graphs of ``folder`` (through ``opener``, else the runtime door) and read its vocabulary."""
    open_graph = opener or _open
    meta = json.loads((folder / VOCAB).read_text(encoding="utf-8"))
    return ShrutiRunner(open_graph(folder / FRONTEND), open_graph(folder / ENCODER), open_graph(folder / DECODER), meta)


def _load(folder: Path) -> ShrutiRunner:
    """The open ear for ``folder``. Raises ``EarSkipped`` when the worker refuses the memory or the folder already
    failed to open in this worker (a re-download changes the file and is tried again)."""
    global _ear, _ear_dir, _last_skip
    if _ear is not None and _ear_dir == str(folder):
        return _ear
    key = _folder_key(folder)
    if key in _broken:
        _last_skip = "broken"
        raise EarSkipped("broken")
    if not admit_hook("shruti-ear", LOAD_MB):
        _last_skip = "low-memory"
        raise EarSkipped("low-memory")
    try:
        runner = load_runner(folder)
    except Exception as exc:  # noqa: BLE001 - remembered, so the other ear answers at once
        _broken[key] = _error_text(exc)
        _last_skip = "broken"
        raise EarSkipped("broken") from exc
    _ear, _ear_dir = runner, str(folder)
    return runner


def loaded() -> bool:
    """True while the ear holds its model in memory."""
    return _ear is not None


def unload() -> bool:
    """Drop the model so the memory returns; True when one was open. It loads again on demand."""
    global _ear, _ear_dir
    was_open = _ear is not None
    _ear, _ear_dir = None, ""
    return was_open


def _policy(text: str, language: str) -> str:
    """The script policy: Hindi words in Devanagari, English in Latin. Raw text when the tables are missing."""
    try:
        import stt_bench

        return stt_bench.fix_script(text, "english" if language == "en" else "codemix")
    except Exception:  # noqa: BLE001 - the words as heard are still right
        return text


def transcribe(samples: Any, language: str | None = None, beams: int = BEAMS) -> str | None:
    """Text for 16 kHz mono float samples, or None to let the other ear answer (no files, refused, failed, silence).

    ``language`` is ``hi``, ``en`` or None to let the model pick; ``last_language()`` tells which it used."""
    global _last_skip, _last_language, _last_confidence
    _last_skip, _last_language, _last_confidence = "", "", None
    folder = model_dir()
    if folder is None:
        return None
    try:
        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size < int(SAMPLE_RATE * MIN_SECONDS):
            return None
        audio = audio[: SAMPLE_RATE * MAX_SECONDS]
        runner = _load(folder)
        wish = language if language in runner.languages else None
        heard = runner.transcribe(audio, language=wish, beams=beams)
    except Exception:  # noqa: BLE001 - any failure here means the other ear hears it instead
        return None
    text = str(heard["text"]).strip()
    if not text:
        return None
    _last_language = str(heard["language"] or "")
    _last_confidence = heard["confidence"]
    return _policy(text, _last_language) or None
