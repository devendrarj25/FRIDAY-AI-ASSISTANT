"""FRIDAY Ears: the streaming transducer loop, numpy and onnxruntime only (no torch, no sherpa, no vosk).

Interface contract
------------------
``NemotronStream`` runs the pinned cache-aware FastConformer RNN-T export (encoder, decoder and joint ``.onnx`` files
in one folder, plus ``vocab.json``, ``languages.json`` and ``config.json``) one 320 ms chunk at a time.

* ``open(model_dir, providers=None, locale="en-US", hotwords=())`` loads three onnxruntime sessions and reads every
  tensor shape from them (layers, hidden size, cache lengths, chunk frames, prompt slots, vocabulary); ``config.json``
  only fills a dimension a session leaves symbolic. ``providers`` is a list of ``CPUExecutionProvider``,
  ``DmlExecutionProvider``, ``CUDAExecutionProvider`` (or ``cpu``/``directml``/``cuda``/``auto``). CPU is always
  last on the list, a provider that is not installed is dropped, and a session that fails to open (or a GPU run that
  fails) falls back to CPU. The caches are plain numpy arrays, so the switch loses no audio.
* ``feed(pcm)`` takes 16 kHz mono PCM (little-endian int16 bytes, an int16 array, or a float array in [-1, 1]), makes
  mel frames with ``mel_frontend.StreamingMel``, runs the encoder for every 32 frames and decodes with
  ``rnnt_decode``. It returns a list of ``StreamEvent`` (kind ``partial``), one per chunk whose text changed.
* ``finalize()`` pushes ``flush_chunks`` chunks of silence (default 3: the encoder looks ahead) and returns the
  ``StreamResult``. ``reset()`` starts a new utterance and keeps the loaded sessions; ``close()`` drops them.
* The language is a one-hot ``language_mask`` over the prompt slots of ``languages.json`` (en-US 0, hi-IN 6, ...).
  For locale ``auto`` the first ``LANG_ID_FRAMES`` (15) encoder frames, 1.2 s, run in the auto slot; at the first chunk
  boundary at or after that, with at least ``LANG_ID_MIN_WORDS`` words heard, ``identify_language`` reads the partial
  (Devanagari, or a Hindi share of 0.3 in the lexicon, is ``hi``, else ``en``) and the slot is locked for the rest of
  the turn: ``lang``, ``lang_conf`` and ``lang_locked`` report it, and only ``reset()`` or ``configure()`` clear it.
* The decoder state moves only on a non-blank token; at most 10 symbols per frame (3 with hotwords, beam search).
  ``hotwords`` are tokenised with the vocabulary pieces and boosted with ``hotword_trie`` inside the beam.

Failures raise ``TransducerError`` with a short ``kind`` so a caller can fall back. Importing this module is cheap
and has no side effects; numpy and onnxruntime are imported by the code that needs them.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import friday_runtime
import numpy as np
import numpy.typing as npt
import voice_budget
from hotword_trie import HotwordTrie
from mel_frontend import StreamingMel, nemo_config
from rnnt_decode import RnntBeamDecoder, RnntGreedyDecoder

CPU = "CPUExecutionProvider"
DML = "DmlExecutionProvider"
CUDA = "CUDAExecutionProvider"
_PROVIDER_ALIASES = {"cpu": CPU, "directml": DML, "dml": DML, "cuda": CUDA}

WORD_MARK = "▁"  # U+2581, the SentencePiece word start
SAMPLE_RATE = 16000
FRAME_MS = 80  # one encoder output frame (subsampling 8 over a 10 ms hop)
DEFAULT_FLUSH_CHUNKS = 3
DEFAULT_BEAM = 2
GREEDY_SYMBOLS = 10
BEAM_SYMBOLS = 3
MAX_PHRASE_PIECES = 24
LANG_ID_FRAMES = 15  # encoder frames (80 ms each) decoded in the auto slot before the language is locked
LANG_ID_MIN_WORDS = 3  # a turn with fewer words stays in the auto slot
_EDGE_MARKS = ".,;:!?\"'()[]{}-\u0964\u0965"  # punctuation and the Devanagari danda around a word

ENCODER_INPUTS = (
    "audio_signal",
    "audio_length",
    "language_mask",
    "pre_cache",
    "cache_last_channel",
    "cache_last_time",
    "cache_last_channel_len",
)
ENCODER_OUTPUTS = (
    "encoded_output",
    "encoded_length",
    "new_pre_cache",
    "new_cache_last_channel",
    "new_cache_last_time",
    "new_cache_last_channel_len",
)
DECODER_INPUTS = ("token", "h", "c")
DECODER_OUTPUTS = ("decoder_output", "h_out", "c_out")
JOINT_INPUTS = ("encoder_output", "decoder_output")

_NUMPY_TYPES: dict[str, Any] = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int32)": np.int32,
    "tensor(int64)": np.int64,
}


class TransducerError(RuntimeError):
    """A failure with a short machine-readable ``kind`` (``contract``, ``files``, ``runtime``, ``locale``, ...)."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class StreamEvent:
    kind: str  # "partial"
    text: str  # the whole hypothesis so far
    audio_ms: int  # audio the encoder has consumed
    tokens: int  # tokens in the hypothesis
    compute_ms: float  # wall time of this chunk (encoder plus decoding)


@dataclass(frozen=True)
class StreamWord:
    text: str
    start_ms: int | None  # None under beam search, which keeps no frame per token
    end_ms: int | None


@dataclass(frozen=True)
class StreamResult:
    text: str
    words: tuple[StreamWord, ...]
    tokens: tuple[int, ...]
    audio_ms: int  # real audio fed (without the flush silence)
    chunks: int
    compute_ms: float


@dataclass
class _Contract:
    n_mels: int
    chunk_frames: int
    pre_frames: int
    prompts: int
    layers: int
    attn_len: int
    hidden: int
    conv_len: int
    dec_layers: int
    dec_hidden: int
    vocab_size: int  # logits width, the blank included
    blank_id: int
    len_dtype: Any
    mask_dtype: Any
    float_dtype: Any
    time_major: bool  # encoded_output is (1, frames, hidden); False means (1, hidden, frames)
    hop: int = 160
    n_fft: int = 512
    win: int = 400
    preemph: float = 0.97
    sample_rate: int = SAMPLE_RATE
    enc_rank: int = 3  # rank of the joint's encoder and decoder inputs
    dec_rank: int = 3


# ---- providers ----------------------------------------------------------------------------------------------------


def pick_providers(requested: Iterable[str] | str | None, available: Iterable[str] | None = None) -> list[str]:
    """The provider list to try, CPU always last. ``None`` or an empty request means CPU only (the verified path)."""
    names = [requested] if isinstance(requested, str) else list(requested or [])
    have = list(available) if available is not None else None
    wanted: list[str] = []
    for raw in names:
        key = str(raw).strip()
        if key.lower() == "auto":
            wanted += [CUDA, DML]
            continue
        wanted.append(_PROVIDER_ALIASES.get(key.lower(), key))
    chosen: list[str] = []
    for name in wanted:
        if name == CPU or name in chosen:
            continue
        if have is not None and name not in have:
            continue
        chosen.append(name)
    return [*chosen, CPU]


def default_session_factory(path: str, providers: list[str], threads: int) -> Any:
    """Open one onnxruntime session. Imported here so a missing runtime only fails the feature that needs it."""

    def configure(options: Any, ort: Any, used: list[str]) -> None:
        options.log_severity_level = 3
        if DML in used:  # DirectML needs a sequential plan and no memory pattern
            options.enable_mem_pattern = False
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

    return friday_runtime.open_session(path, "asr_stream", intra=threads, providers=providers, configure=configure)


def available_providers() -> list[str]:
    try:
        import onnxruntime as ort  # type: ignore

        return list(ort.get_available_providers())
    except Exception:  # noqa: BLE001 — no runtime means CPU request only, the open call reports it
        return [CPU]


# ---- vocabulary and language --------------------------------------------------------------------------------------


def load_vocab(path: Path) -> dict[int, str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        return {int(k): str(v) for k, v in raw.items()}
    return {i: str(v) for i, v in enumerate(raw)}


def load_prompt_slots(path: Path) -> tuple[dict[str, int], int | None]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    table = {str(k): int(v) for k, v in dict(raw.get("promptDictionary") or {}).items()}
    auto = raw.get("autoSlot")
    return table, (int(auto) if isinstance(auto, int) else table.get("auto"))


def language_slot(locale: str, table: dict[str, int], auto_slot: int | None = None) -> int:
    """The prompt slot of a locale ("hi-IN", "hi_IN", "hi", "EN-us"). Empty or "auto" uses the auto slot."""
    raw = (locale or "").strip().replace("_", "-")
    if not raw or raw.lower() == "auto":
        if auto_slot is None:
            raise TransducerError("locale", "this model has no automatic language slot")
        return auto_slot
    folded = {k.lower(): v for k, v in table.items()}
    key = raw.lower()
    if key in folded:
        return folded[key]
    base = key.split("-")[0]
    if base in folded:
        return folded[base]
    raise TransducerError("locale", f"locale {locale!r} is not one of this model's prompt slots")


def identify_language(text: str) -> tuple[str, float]:
    """``("hi" | "en", confidence 0-1)`` for the partial of one turn, or ``("auto", 0.0)`` under ``LANG_ID_MIN_WORDS``
    words. Devanagari, or at least ``ROMAN_HINGLISH_SHARE`` sure Roman Hindi words (``hinglish_lexicon``), is Hindi."""
    words = [w for w in (p.strip(_EDGE_MARKS) for p in str(text).split()) if any(ch.isalpha() for ch in w)]
    if len(words) < LANG_ID_MIN_WORDS:
        return "auto", 0.0
    try:
        import hinglish_lexicon as lex
    except (ImportError, OSError, KeyError, ValueError):  # the table is missing: the script alone decides
        hindi = any("\u0900" <= ch <= "\u097f" for ch in text)
        return ("hi", 1.0) if hindi else ("en", 1.0)
    share = lex.label_languages(words).count("hi") / len(words)
    if lex.detect_turn_language(" ".join(words))["lang"] in ("hi", "hi-en"):
        return "hi", min(1.0, max(share, lex.ROMAN_HINGLISH_SHARE))
    return "en", min(1.0, max(0.0, 1.0 - share))


def piece_text(piece: str) -> str | None:
    """The text a vocabulary piece adds, or None for a control piece such as ``<unk>``."""
    if piece.startswith("<"):
        return None
    return piece


def ids_to_text(ids: Sequence[int], vocab: dict[int, str]) -> str:
    out = []
    for i in ids:
        text = piece_text(vocab.get(int(i), ""))
        if text:
            out.append(text)
    return "".join(out).replace(WORD_MARK, " ").strip()


def ids_to_words(emissions: Sequence[tuple[int, int]], vocab: dict[int, str]) -> list[StreamWord]:
    """Group ``(token, frame)`` pairs into words. A word starts at a piece that begins with the word mark."""
    words: list[list[Any]] = []  # [text, first_frame, last_frame]
    boundary = True
    for token, frame in emissions:
        text = piece_text(vocab.get(int(token), ""))
        if text is None:
            continue
        starts = text.startswith(WORD_MARK)
        body = text.replace(WORD_MARK, "")
        if starts:
            boundary = True
        if not body:
            continue
        if boundary or not words:
            words.append([body, frame, frame])
            boundary = False
        else:
            words[-1][0] += body
            words[-1][2] = frame
    return [StreamWord(w[0], int(w[1]) * FRAME_MS, (int(w[2]) + 1) * FRAME_MS) for w in words]


class PieceTokenizer:
    """Phrase to vocabulary ids with the fewest pieces (dynamic programming over the piece table)."""

    def __init__(self, vocab: dict[int, str]) -> None:
        self._ids: dict[str, int] = {}
        for token, piece in vocab.items():
            if piece and not piece.startswith("<") and piece not in self._ids:
                self._ids[piece] = token
        self._longest = max((len(p) for p in self._ids), default=1)

    def encode(self, phrase: str) -> list[int] | None:
        words = phrase.split()
        if not words:
            return None
        text = "".join(WORD_MARK + w for w in words)
        n = len(text)
        best: list[tuple[int, int] | None] = [None] * (n + 1)  # (pieces, previous index)
        best[0] = (0, 0)
        for end in range(1, n + 1):
            for start in range(max(0, end - self._longest), end):
                prior = best[start]
                if prior is None or text[start:end] not in self._ids:
                    continue
                cand = (prior[0] + 1, start)
                if best[end] is None or cand[0] < best[end][0]:  # type: ignore[index]
                    best[end] = cand
        if best[n] is None:
            return None
        out: list[int] = []
        at = n
        while at > 0:
            prev = best[at]
            if prev is None:
                return None
            out.append(self._ids[text[prev[1] : at]])
            at = prev[1]
        out.reverse()
        return out if len(out) <= MAX_PHRASE_PIECES else None


# ---- the stream ---------------------------------------------------------------------------------------------------


def _dim(shape: Sequence[Any] | None, index: int, fallback: int) -> int:
    if shape is not None and -len(shape) <= index < len(shape):
        value = shape[index]
        if isinstance(value, int) and value > 0:
            return value
    return fallback


def _by_name(items: Iterable[Any]) -> dict[str, Any]:
    return {item.name: item for item in items}


def _np_type(info: Any, fallback: Any) -> Any:
    return _NUMPY_TYPES.get(str(getattr(info, "type", "")), fallback)


def _read_config(folder: Path) -> dict[str, Any]:
    try:
        data = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def read_contract(enc: Any, dec: Any, joi: Any, config: dict[str, Any]) -> _Contract:
    """Shapes and types come from the loaded sessions; ``config.json`` only fills what a session leaves symbolic."""
    ins, outs = _by_name(enc.get_inputs()), _by_name(enc.get_outputs())
    missing = [n for n in ENCODER_INPUTS if n not in ins] + [n for n in ENCODER_OUTPUTS if n not in outs]
    d_ins, d_outs = _by_name(dec.get_inputs()), _by_name(dec.get_outputs())
    missing += [n for n in DECODER_INPUTS if n not in d_ins] + [n for n in DECODER_OUTPUTS if n not in d_outs]
    j_ins, j_outs = _by_name(joi.get_inputs()), list(joi.get_outputs())
    missing += [n for n in JOINT_INPUTS if n not in j_ins]
    if not j_outs:
        missing.append("joint output")
    if missing:
        raise TransducerError("contract", "the model does not have the expected tensors: " + ", ".join(missing))
    stream = dict(config.get("streaming") or {})
    audio, mask = ins["audio_signal"].shape, ins["language_mask"].shape
    chan, conv, pre = ins["cache_last_channel"].shape, ins["cache_last_time"].shape, ins["pre_cache"].shape
    hidden = _dim(chan, -1, int(config.get("encoderHidden", 1024)))
    out_shape = outs["encoded_output"].shape
    time_major = _dim(out_shape, -1, hidden) == hidden
    h_shape = d_ins["h"].shape
    logits = j_outs[0].shape
    vocab_size = _dim(logits, -1, int(config.get("vocabSize", 0)) + 1)
    return _Contract(
        n_mels=_dim(audio, 1, int(config.get("numMelBins", 128))),
        chunk_frames=_dim(audio, 2, int(stream.get("melFrames", 32))),
        pre_frames=_dim(pre, -1, int(stream.get("preCacheSize", 9))),
        prompts=_dim(mask, -1, int(config.get("numPrompts", 128))),
        layers=_dim(chan, 0, int(config.get("encoderLayers", 24))),
        attn_len=_dim(chan, 2, int(config.get("attentionLeftContext", 56))),
        hidden=hidden,
        conv_len=_dim(conv, -1, int(config.get("convCacheSize", 8))),
        dec_layers=_dim(h_shape, 0, int(config.get("decoderLayers", 2))),
        dec_hidden=_dim(h_shape, -1, int(config.get("decoderHidden", 640))),
        vocab_size=vocab_size,
        blank_id=int(config["blankTokenId"]) if "blankTokenId" in config else vocab_size - 1,
        len_dtype=_np_type(ins["cache_last_channel_len"], np.int32),
        mask_dtype=_np_type(ins["language_mask"], np.float32),
        float_dtype=_np_type(ins["audio_signal"], np.float32),
        time_major=time_major,
        hop=int(config.get("hopLength", 160)),
        n_fft=int(config.get("nFFT", 512)),
        win=int(config.get("winLength", 400)),
        preemph=float(config.get("preEmphasis", 0.97)),
        sample_rate=int(config.get("sampleRate", SAMPLE_RATE)),
        enc_rank=len(j_ins["encoder_output"].shape or [1, 1, 1]),
        dec_rank=len(j_ins["decoder_output"].shape or [1, 1, 1]),
    )


def to_float_pcm(pcm: bytes | bytearray | memoryview | npt.NDArray[Any], carry: bytearray) -> npt.NDArray[np.float32]:
    """Bytes are little-endian int16 (an odd trailing byte waits in ``carry``); arrays are int16 or float in [-1, 1]."""
    if isinstance(pcm, (bytes, bytearray, memoryview)):
        data = bytes(carry) + bytes(pcm)
        usable = len(data) - (len(data) % 2)
        carry.clear()
        carry.extend(data[usable:])
        return (np.frombuffer(data[:usable], dtype="<i2").astype(np.float32) / 32768.0).astype(np.float32)
    arr = np.asarray(pcm)
    if arr.ndim != 1:
        raise TransducerError("audio", "audio must be one channel")
    if arr.dtype == np.int16:
        return (arr.astype(np.float32) / 32768.0).astype(np.float32)
    return np.clip(arr.astype(np.float32), -1.0, 1.0)


class NemotronStream:
    """One loaded model, one utterance at a time. Not thread safe: the worker serialises its requests."""

    def __init__(
        self,
        session_factory: Callable[[str, list[str], int], Any] | None = None,
        *,
        available: Callable[[], list[str]] | None = None,
        threads: int | None = None,
        flush_chunks: int = DEFAULT_FLUSH_CHUNKS,
        beam_width: int = DEFAULT_BEAM,
    ) -> None:
        if flush_chunks < 0 or beam_width < 1:
            raise ValueError("flush_chunks must be >= 0 and beam_width >= 1")
        self._factory = session_factory or default_session_factory
        self._available = available or available_providers
        self.threads = threads or voice_budget.steady("asr_stream")
        self.flush_chunks = flush_chunks
        self.beam_width = beam_width
        self._sessions: dict[str, Any] = {}
        self._paths: dict[str, str] = {}
        self.providers: list[str] = [CPU]
        self.active_providers: list[str] = []
        self.contract: _Contract | None = None
        self.vocab: dict[int, str] = {}
        self._slots: dict[str, int] = {}
        self._auto_slot: int | None = None
        self._tokenizer: PieceTokenizer | None = None
        self.locale = ""
        self.hotword_count = 0
        self._trie: HotwordTrie | None = None
        self._decoder: RnntGreedyDecoder | RnntBeamDecoder | None = None
        self._mel: StreamingMel | None = None
        self._mask: npt.NDArray[Any] | None = None  # the slot the encoder runs with now (a lock replaces it)
        self._base_mask: npt.NDArray[Any] | None = None  # the slot configure() chose; every new turn starts here
        self._auto = False  # the configured locale is "auto": the language is read from the first frames
        self._config: dict[str, Any] = {}
        self._joint_output = "logits"
        self._reset_state()

    # ---- lifecycle ----

    @property
    def is_open(self) -> bool:
        return self.contract is not None and self._decoder is not None

    @property
    def chunk_ms(self) -> int:
        c = self.contract
        return 0 if c is None else c.chunk_frames * c.hop * 1000 // c.sample_rate

    def open(
        self,
        model_dir: str | Path,
        providers: Iterable[str] | str | None = None,
        locale: str = "en-US",
        hotwords: Iterable[str] = (),
    ) -> dict[str, Any]:
        """Load the three sessions and the tables. Raises ``TransducerError`` (never a bare onnxruntime error)."""
        folder = Path(model_dir)
        names = {"encoder": "encoder.onnx", "decoder": "decoder.onnx", "joint": "joint.onnx"}
        for label in (*names.values(), "vocab.json", "languages.json"):
            if not (folder / label).is_file():
                raise TransducerError("files", f"{label} is missing from {folder}")
        self.close()
        self._config = _read_config(folder)
        order = pick_providers(providers, self._available())
        started = time.perf_counter()
        try:
            for key, label in names.items():
                self._paths[key] = str(folder / label)
                self._sessions[key] = self._open_session(self._paths[key], order)
            self.providers = order
            self.active_providers = self._current_providers()
            enc, dec, joi = self._sessions["encoder"], self._sessions["decoder"], self._sessions["joint"]
            self.contract = read_contract(enc, dec, joi, self._config)
            self._joint_output = joi.get_outputs()[0].name
            self.vocab = load_vocab(folder / "vocab.json")
            self._slots, self._auto_slot = load_prompt_slots(folder / "languages.json")
        except TransducerError:
            self.close()
            raise
        except Exception as exc:  # noqa: BLE001 — one clear error kind for any load failure
            self.close()
            raise TransducerError("runtime", f"{type(exc).__name__}: {exc}"[-400:]) from exc
        self._tokenizer = PieceTokenizer(self.vocab)
        self.configure(locale, hotwords)
        return {
            "providers": list(self.active_providers),
            "chunkMs": self.chunk_ms,
            "melBins": self.contract.n_mels,
            "vocab": self.contract.vocab_size,
            "blankId": self.contract.blank_id,
            "loadMs": int((time.perf_counter() - started) * 1000),
        }

    def _open_session(self, path: str, order: list[str]) -> Any:
        try:
            return self._factory(path, order, self.threads)
        except Exception:
            if order == [CPU]:
                raise
            return self._factory(path, [CPU], self.threads)  # a GPU provider that cannot open degrades to CPU

    def _current_providers(self) -> list[str]:
        used: list[str] = []
        for session in self._sessions.values():
            try:
                names = [str(n) for n in session.get_providers()]
            except AttributeError:  # a session double without the call
                names = [CPU]
            for name in names:
                if name not in used:
                    used.append(name)
        return used or [CPU]

    def configure(self, locale: str, hotwords: Iterable[str] = ()) -> None:
        """Set the language and the hotwords for the next utterance, then reset the stream."""
        c = self._need_open()
        mask = self._slot_mask(c, language_slot(locale, self._slots, self._auto_slot))
        self._mask = self._base_mask = mask
        self._auto = locale.strip().lower() in ("", "auto")
        self.locale = locale
        trie = HotwordTrie()
        tokenizer = self._tokenizer
        for phrase in hotwords:
            ids = tokenizer.encode(str(phrase)) if tokenizer else None
            if ids:
                trie.add_phrase(ids)
        self._trie = trie if trie else None
        self.hotword_count = len(trie)
        self._mel = StreamingMel(
            nemo_config(
                sample_rate=c.sample_rate,
                n_mels=c.n_mels,
                n_fft=c.n_fft,
                win_length=c.win,
                hop_length=c.hop,
                preemph=c.preemph,
            ),
            cache_frames=0,  # the model keeps its own pre-encode cache
        )
        self._decoder = self._build_decoder(c)
        self._reset_state()

    @staticmethod
    def _slot_mask(c: _Contract, slot: int) -> npt.NDArray[Any]:
        if not 0 <= slot < c.prompts:
            raise TransducerError("locale", f"prompt slot {slot} is outside the model's {c.prompts} slots")
        mask = np.zeros((1, c.prompts), dtype=c.mask_dtype)
        mask[0, slot] = 1.0
        return mask

    @property
    def lang_auto(self) -> bool:
        """True when the locale is ``auto`` and this turn's language is read from its first frames."""
        return self._auto and self.is_open

    @property
    def lang(self) -> str:
        """``auto`` until the slot is locked, then ``hi`` or ``en``; a fixed locale reports its own base language."""
        if self._auto or not self.is_open:
            return self._lang
        return self.locale.strip().replace("_", "-").split("-")[0].lower()

    @property
    def lang_conf(self) -> float:
        """0 to 1: how sure the lock is (0 before it); 1 for a language the owner declared."""
        return self._lang_conf if self._auto or not self.is_open else 1.0

    @property
    def lang_locked(self) -> bool:
        """True once the slot is fixed for this turn (always true for a fixed locale)."""
        return self._lang_locked if self._auto or not self.is_open else True

    def _maybe_lock(self, text: str) -> None:
        """Lock the language slot once, at the first chunk boundary after ``LANG_ID_FRAMES`` frames with enough words.
        No lock is ever undone inside a turn; a model without the ``hi`` or ``en`` slot stays on auto."""
        c = self.contract
        if not self._auto or self._lang_locked or c is None or self._frames < LANG_ID_FRAMES:
            return
        lang, conf = identify_language(text)
        if lang == "auto":
            return
        try:
            mask = self._slot_mask(c, language_slot(lang, self._slots, self._auto_slot))
        except TransducerError:
            return
        self._mask = mask
        self._lang, self._lang_conf, self._lang_locked = lang, conf, True

    def _build_decoder(self, c: _Contract) -> RnntGreedyDecoder | RnntBeamDecoder:
        initial = (
            np.zeros((c.dec_layers, 1, c.dec_hidden), dtype=c.float_dtype),
            np.zeros((c.dec_layers, 1, c.dec_hidden), dtype=c.float_dtype),
        )
        if self._trie is not None:
            return RnntBeamDecoder(
                self._decode_token,
                self._joint,
                blank_id=c.blank_id,
                beam_width=self.beam_width,
                max_symbols_per_step=BEAM_SYMBOLS,
                hotwords=self._trie,
                initial_state=initial,
            )
        return RnntGreedyDecoder(
            self._decode_token,
            self._joint,
            blank_id=c.blank_id,
            max_symbols_per_step=GREEDY_SYMBOLS,
            initial_state=initial,
        )

    def close(self) -> None:
        self._sessions.clear()
        self._paths.clear()
        self.contract = None
        self._decoder = None
        self._mel = None
        self._mask = None
        self._trie = None
        self._base_mask = None
        self._auto = False
        self._tokenizer = None
        self.vocab = {}
        self.active_providers = []
        self._reset_state()

    def reset(self) -> None:
        """Start a new utterance; the sessions, the language and the hotwords stay."""
        if self._mel is not None:
            self._mel.reset()
        if self._decoder is not None:
            self._decoder.reset()
        self._reset_state()

    def _reset_state(self) -> None:
        c = self.contract
        self._pending: npt.NDArray[np.float32] = np.zeros((0, c.n_mels if c else 0), dtype=np.float32)
        self._carry = bytearray()
        self._primed = False
        self._finished = False
        self._samples = 0
        self._chunks = 0
        self._compute_ms = 0.0
        self._last_text = ""
        self._emissions: list[tuple[int, int]] = []
        self._frames = 0  # encoder frames decoded this turn
        self._lang, self._lang_conf, self._lang_locked = "auto", 0.0, False
        self._mask = self._base_mask  # a lock from the last turn is dropped: every turn starts in the auto slot
        if c is not None:
            f = c.float_dtype
            self._pre = np.zeros((1, c.n_mels, c.pre_frames), dtype=f)
            self._chan = np.zeros((c.layers, 1, c.attn_len, c.hidden), dtype=f)
            self._conv = np.zeros((c.layers, 1, c.hidden, c.conv_len), dtype=f)
            self._chan_len = np.zeros(1, dtype=c.len_dtype)

    def _need_open(self) -> _Contract:
        if self.contract is None:
            raise TransducerError("closed", "the stream is not open")
        return self.contract

    # ---- model calls ----

    def _run(self, key: str, feeds: dict[str, Any], outputs: list[str]) -> list[Any]:
        try:
            return self._sessions[key].run(outputs, feeds)
        except Exception:
            if self.active_providers in ([CPU], []) or CPU not in self.providers:
                raise
            self._degrade_to_cpu()
            return self._sessions[key].run(outputs, feeds)

    def _degrade_to_cpu(self) -> None:
        """A GPU run failed: reopen the three sessions on CPU. Caches and decoder state are numpy: nothing is lost."""
        self.providers = [CPU]
        for key, path in self._paths.items():
            self._sessions[key] = self._factory(path, [CPU], self.threads)
        self.active_providers = self._current_providers()

    def _decode_token(self, token: int, state: Any) -> tuple[npt.NDArray[Any], Any]:
        c = self._need_open()
        h, cell = state
        out = self._run(
            "decoder",
            {"token": np.array([[token]], dtype=np.int64), "h": h, "c": cell},
            list(DECODER_OUTPUTS),
        )
        return np.asarray(out[0]).reshape(-1).astype(c.float_dtype, copy=False), (out[1], out[2])

    def _joint(self, frame: npt.NDArray[Any], decoder_out: npt.NDArray[Any]) -> npt.NDArray[Any]:
        c = self._need_open()
        enc = np.asarray(frame, dtype=c.float_dtype).reshape((1,) * (c.enc_rank - 1) + (-1,))
        dec = np.asarray(decoder_out, dtype=c.float_dtype).reshape((1,) * (c.dec_rank - 1) + (-1,))
        out = self._run("joint", {"encoder_output": enc, "decoder_output": dec}, [self._joint_output])
        return np.asarray(out[0]).reshape(-1)

    def _encode(self, chunk: npt.NDArray[np.float32]) -> npt.NDArray[Any]:
        """One chunk of shape (1, n_mels, chunk_frames) through the encoder. Returns (frames, hidden)."""
        c = self._need_open()
        if self._mask is None:
            raise TransducerError("closed", "the stream has no language set")
        feeds = {
            "audio_signal": chunk.astype(c.float_dtype, copy=False),
            "audio_length": np.array([c.chunk_frames], dtype=c.len_dtype),
            "language_mask": self._mask,
            "pre_cache": self._pre,
            "cache_last_channel": self._chan,
            "cache_last_time": self._conv,
            "cache_last_channel_len": self._chan_len,
        }
        out = self._run("encoder", feeds, list(ENCODER_OUTPUTS))
        self._pre, self._chan, self._conv, self._chan_len = out[2], out[3], out[4], out[5]
        frames = np.asarray(out[0])[0]
        if not c.time_major:
            frames = frames.T
        return frames[: int(np.asarray(out[1]).reshape(-1)[0])]

    # ---- streaming ----

    def feed(self, pcm: bytes | bytearray | memoryview | npt.NDArray[Any]) -> list[StreamEvent]:
        c = self._need_open()
        if self._finished:
            raise TransducerError("finished", "finalize() was called; reset() starts a new utterance")
        samples = to_float_pcm(pcm, self._carry)
        events: list[StreamEvent] = []
        if not self._primed:
            self._primed = True
            # The model's frames are centred: frame i covers samples i*hop +- win/2, so half a window of zeros first.
            self._take(np.zeros(c.win // 2, dtype=np.float32), events)
        self._samples += int(samples.size)
        self._take(samples, events)
        return events

    def _take(self, samples: npt.NDArray[np.float32], events: list[StreamEvent]) -> None:
        c = self._need_open()
        if self._mel is None:
            raise TransducerError("closed", "the stream is not open")
        if samples.size:
            frames = self._mel.push(samples).frames
            if frames.shape[0]:
                self._pending = np.concatenate((self._pending, frames), axis=0)
        while self._pending.shape[0] >= c.chunk_frames:
            chunk = self._pending[: c.chunk_frames]
            self._pending = self._pending[c.chunk_frames :]
            event = self._step(chunk.T[None, :, :])
            if event is not None:
                events.append(event)

    def _step(self, chunk: npt.NDArray[np.float32]) -> StreamEvent | None:
        c = self._need_open()
        decoder = self._decoder
        if decoder is None:
            raise TransducerError("closed", "the stream is not open")
        started = time.perf_counter()
        enc = self._encode(chunk)
        self._frames += int(enc.shape[0])
        if isinstance(decoder, RnntGreedyDecoder):
            self._emissions += [(e.token, e.frame) for e in decoder.decode_chunk(enc)]
            tokens: Sequence[int] = decoder.tokens
        else:
            decoder.decode_chunk(enc)
            tokens = decoder.best().tokens
        self._chunks += 1
        spent = (time.perf_counter() - started) * 1000
        self._compute_ms += spent
        text = ids_to_text(tokens, self.vocab)
        self._maybe_lock(text)
        if text == self._last_text:
            return None
        self._last_text = text
        return StreamEvent(
            "partial", text, self._chunks * c.chunk_frames * c.hop * 1000 // c.sample_rate, len(tokens), spent
        )

    def text(self) -> str:
        """The hypothesis so far."""
        return self._last_text

    def finalize(self) -> StreamResult:
        c = self._need_open()
        decoder = self._decoder
        if decoder is None:
            raise TransducerError("closed", "the stream is not open")
        if not self._finished:
            tail: list[StreamEvent] = []
            if not self._primed:
                self._primed = True
                self._take(np.zeros(c.win // 2, dtype=np.float32), tail)
            self._take(np.zeros(self.flush_chunks * c.chunk_frames * c.hop, dtype=np.float32), tail)
            if self._pending.shape[0]:  # a part chunk is padded with silence, the value silence makes
                pad = np.full((c.chunk_frames - self._pending.shape[0], c.n_mels), np.log(2.0**-24), dtype=np.float32)
                chunk = np.concatenate((self._pending, pad), axis=0)
                self._pending = self._pending[:0]
                self._step(chunk.T[None, :, :])
            self._finished = True
        if isinstance(decoder, RnntGreedyDecoder):
            tokens: tuple[int, ...] = tuple(decoder.tokens)
            words = ids_to_words(self._emissions, self.vocab)
        else:
            tokens = tuple(decoder.best().tokens)
            words = [StreamWord(w.text, None, None) for w in ids_to_words([(t, 0) for t in tokens], self.vocab)]
        return StreamResult(
            text=ids_to_text(tokens, self.vocab),
            words=tuple(words),
            tokens=tokens,
            audio_ms=self._samples * 1000 // c.sample_rate,
            chunks=self._chunks,
            compute_ms=self._compute_ms,
        )
