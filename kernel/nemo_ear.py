"""FRIDAY's NeMo ear runner: Conformer CTC, RNN-T and TDT speech models exported to ONNX, run on onnxruntime + numpy.

Interface contract
------------------
* ``NemoEar.load(folder, kind=None, quantization=None)`` opens a model folder: ``vocab.txt`` (``piece id`` per line),
  an optional ``config.json`` (``model_type``, ``features_size``, ``subsampling_factor``, ``max_tokens_per_step``,
  ``durations``) and the graphs: ``model.onnx`` for CTC, ``encoder-model.onnx`` plus ``decoder_joint-model.onnx`` for
  RNN-T and TDT. ``quantization="int8"`` picks ``model.int8.onnx`` (or ``model_int8.onnx``) and so on. ``kind`` is
  ``ctc``, ``rnnt`` or ``tdt`` (or a ``nemo-conformer-<kind>`` model type); without it the config and then the files
  and the width of the joint decide. Nothing is downloaded here; a missing or odd file raises ``NemoEarError``.
* ``recognize(samples)`` gives the text of 16 kHz mono float samples (int16 is scaled). ``with_timestamps()`` gives a
  reader whose ``recognize`` returns a ``NemoReading``: text, the pieces, the time of each piece's first frame in
  seconds and the log probability of each piece. ``hotwords`` (any ``context_graph.TokenBias``: a ``HotwordTrie`` or a
  ``ContextGraph``) turns the CTC prefix beam or the transducer beam on. ``ear.hotword_bias(words)`` builds that graph
  from the owner's words and their Roman and Devanagari spellings (``text_norm.hotword_variants``). A biased CTC
  reading from ``with_timestamps()`` still carries piece times and scores (the beam's pieces are force-aligned to the
  frames, the scores are acoustic only), and when no hotword made it into the beam's best line the greedy reading
  answers, so words that were not spoken change nothing. A biased transducer reading carries no times or scores.
* ``log_probs(samples)`` and ``ctc_head()`` expose the CTC head for the chunked reader; both are None for a transducer.
* The log-mel features are ``NemoFeatures``: the NeMo recipe on ``mel_frontend``'s filterbank, pre-emphasis and power
  spectrum, with NeMo's symmetric Hann window and its utterance mean and variance. ``mel_frontend``'s own Hann is
  periodic, which moves some bins by more than a model should be asked to forgive, so the window is set here.
* Decoding is ``ctc_decode`` (greedy, or the prefix beam with hotwords) and ``rnnt_decode`` (greedy or beam; the TDT
  pair reads the duration logits the joint adds after the token logits).

The module has no import side effects: numpy and onnxruntime are imported where they are used.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import voice_budget
from context_graph import ContextGraph, TokenBias, graph_for_words
from ctc_decode import ctc_align, ctc_greedy, ctc_prefix_beam
from mel_frontend import mel_filterbank, nemo_config, power_spectrum, preemphasis
from rnnt_decode import (
    DEFAULT_DURATIONS,
    RnntBeamDecoder,
    RnntGreedyDecoder,
    TdtBeamDecoder,
    TdtGreedyDecoder,
)

SAMPLE_RATE = 16000
HOP = 160
N_FFT = 512
WIN = 400
WORD_MARK = "▁"  # the SentencePiece word-start mark; the text form of a piece swaps it for a space
BLANK_PIECES = ("<blk>", "<blank>")
KINDS = ("ctc", "rnnt", "tdt")
DEFAULT_FEATURES = 80
DEFAULT_SUBSAMPLING = 8
DEFAULT_MAX_TOKENS_PER_STEP = 10
MAX_SPELLINGS = 8  # spellings tried per owner word (the word itself first)
_SPACES = re.compile(r"\A\s|\s\B|(\s)\b")  # a space survives only between two words


class NemoEarError(RuntimeError):
    """The folder is not a model this runner can open (missing file, odd vocabulary, unknown kind)."""


# ---- features -------------------------------------------------------------------------------------------------------


class NemoFeatures:
    """NeMo log-mel features for one utterance: ``(n_mels, frames)`` float32 and the number of real frames."""

    def __init__(self, n_mels: int = DEFAULT_FEATURES) -> None:
        config = nemo_config(n_mels=n_mels)
        self.n_mels = n_mels
        self._bank = mel_filterbank(config).T  # (n_fft / 2 + 1, n_mels)
        edge = (N_FFT - WIN) // 2
        self._window = np.pad(np.hanning(WIN), (edge, N_FFT - WIN - edge))
        self._preemph = config.preemph
        self._guard = config.log_guard

    def __call__(self, samples: npt.ArrayLike) -> tuple[npt.NDArray[np.float32], int]:
        audio = np.asarray(samples, dtype=np.float64).reshape(-1)
        count = audio.size // HOP  # frames that hold audio; the frame after them is zero, as NeMo feeds it
        if count < 1:
            raise NemoEarError("the clip is shorter than one feature frame")
        boosted = preemphasis(audio, self._preemph)
        padded = np.pad(boosted, (N_FFT // 2, N_FFT // 2))
        frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP]
        logmel = np.log(power_spectrum(np.ascontiguousarray(frames), self._window, N_FFT) @ self._bank + self._guard)
        real = logmel[:count]
        mean = real.mean(axis=0, keepdims=True)
        spread = np.sqrt(((real - mean) ** 2).sum(axis=0, keepdims=True) / max(count - 1, 1))
        out = np.zeros_like(logmel)
        out[:count] = (real - mean) / (spread + 1e-5)
        return out.T.astype(np.float32), count


# ---- files ----------------------------------------------------------------------------------------------------------


def kind_of(model_type: str) -> str | None:
    """``ctc``, ``rnnt`` or ``tdt`` from a name such as ``nemo-conformer-tdt``, or None."""
    tail = str(model_type or "").strip().lower().replace("_", "-").rsplit("-", 1)[-1]
    return tail if tail in KINDS else None


def read_vocab(path: Path) -> dict[int, str]:
    """``{id: piece}`` from ``vocab.txt``. The word mark stays in the piece."""
    pieces: dict[int, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            piece, _, number = line.rstrip("\n").rpartition(" ")
            pieces[int(number)] = piece
    except (OSError, ValueError) as error:
        raise NemoEarError(f"vocab.txt cannot be read: {error}") from error
    if not pieces:
        raise NemoEarError("vocab.txt is empty")
    return pieces


def _one_file(folder: Path, stem: str, quantization: str | None) -> Path:
    """``stem.onnx``, or ``stem.<q>.onnx`` / ``stem_<q>.onnx`` for a quantised graph. Exactly one must match."""
    pattern = f"{stem}?{quantization}" if quantization else stem
    for suffix in (".onnx", ".ort"):
        found = sorted(path for path in folder.glob(pattern + suffix) if path.is_file())
        if len(found) > 1:
            raise NemoEarError(f"more than one file matches {pattern}{suffix}")
        if found:
            return found[0]
    raise NemoEarError(f"{pattern}.onnx is missing")


@dataclass(frozen=True)
class NemoFiles:
    kind: str
    vocab: Path
    encoder: Path  # the whole graph for CTC
    decoder_joint: Path | None
    config: dict[str, Any]


def discover(folder: Path, kind: str | None = None, quantization: str | None = None) -> NemoFiles:
    """Find the graphs, the vocabulary and the config of a model folder, and decide its kind."""
    folder = Path(folder)
    config: dict[str, Any] = {}
    config_path = folder / "config.json"
    if config_path.is_file():
        try:
            loaded = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise NemoEarError(f"config.json cannot be read: {error}") from error
        config = loaded if isinstance(loaded, dict) else {}
    chosen = kind_of(kind) if kind else kind_of(str(config.get("model_type", "")))
    if kind and chosen is None:
        raise NemoEarError(f"unknown kind {kind!r}; this runner reads ctc, rnnt and tdt")
    if chosen is None:  # no word on it: the files say (the width of the joint may later make an rnnt a tdt)
        chosen = "rnnt" if any(folder.glob("encoder-model*")) else "ctc"
    vocab = folder / "vocab.txt"
    if not vocab.is_file():
        raise NemoEarError("vocab.txt is missing")
    if chosen == "ctc":
        return NemoFiles(chosen, vocab, _one_file(folder, "model", quantization), None, config)
    return NemoFiles(
        chosen,
        vocab,
        _one_file(folder, "encoder-model", quantization),
        _one_file(folder, "decoder_joint-model", quantization),
        config,
    )


def _default_session(path: Path, threads: int) -> Any:
    import onnxruntime as ort  # type: ignore

    options = voice_budget.ort_session_options("asr_final", intra=threads) or ort.SessionOptions()
    options.log_severity_level = 3
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


# ---- the fused decoder + joint graph, shown to rnnt_decode as a separate decoder and joint ---------------------------


class _Step:
    """One pending prediction step: the token and the state it was fed, and the state the graph gave back."""

    __slots__ = ("after", "owner", "state", "token")

    def __init__(self, owner: _FusedJoint, token: int, state: tuple[Any, Any]) -> None:
        self.owner, self.token, self.state = owner, token, state
        self.after: tuple[Any, Any] | None = None

    def state_after(self) -> tuple[Any, Any]:
        if self.after is None:  # the state does not depend on the audio, so a silent frame gives the same one
            self.owner.run(self, np.zeros(self.owner.encoder_dim, dtype=np.float32))
        if self.after is None:
            raise NemoEarError("the decoder graph gave no state")
        return self.after


class _FusedJoint:
    """NeMo's exported ``decoder_joint`` graph takes the encoder frame, the last token and the LSTM state in one run.

    ``decoder`` and ``joint`` below are the two callables ``rnnt_decode`` wants. ``decoder`` only notes the token and
    the state; ``joint`` runs the graph (one run per step, as the graph was built to be used) and keeps the new
    state for the step that follows.
    """

    def __init__(self, session: Any, vocab_size: int, tdt: bool) -> None:
        self.session = session
        self.vocab_size = vocab_size
        self.tdt = tdt
        inputs = {item.name: item for item in session.get_inputs()}
        try:
            self.encoder_dim = int(inputs["encoder_outputs"].shape[1])
            self.zero_state = tuple(
                np.zeros((int(inputs[name].shape[0]), 1, int(inputs[name].shape[2])), dtype=np.float32)
                for name in ("input_states_1", "input_states_2")
            )
        except (KeyError, TypeError, ValueError, IndexError) as error:
            raise NemoEarError(
                "decoder_joint has no encoder_outputs, input_states_1 or input_states_2 input"
            ) from error
        wide = "int64" in str(getattr(inputs.get("targets"), "type", ""))
        self._ints = np.int64 if wide else np.int32

    def decoder(self, token: int, state: Any) -> tuple[_Step, _Step]:
        before = state.state_after() if isinstance(state, _Step) else state
        step = _Step(self, int(token), before)
        return step, step

    def run(self, step: _Step, frame: npt.NDArray[Any]) -> npt.NDArray[np.float32]:
        outputs, first, second = self.session.run(
            ["outputs", "output_states_1", "output_states_2"],
            {
                "encoder_outputs": np.asarray(frame, dtype=np.float32).reshape(1, -1, 1),
                "targets": np.asarray([[step.token]], dtype=self._ints),
                "target_length": np.asarray([1], dtype=self._ints),
                "input_states_1": step.state[0],
                "input_states_2": step.state[1],
            },
        )
        step.after = (first, second)
        return np.asarray(outputs, dtype=np.float32).reshape(-1)

    def joint(self, frame: npt.NDArray[Any], step: _Step) -> npt.NDArray[np.float32]:
        out = self.run(step, frame)
        if out.shape[0] < self.vocab_size:
            raise NemoEarError("the joint answers with fewer scores than the vocabulary has pieces")
        return out[: self.vocab_size] if self.tdt else out

    def tdt_joint(
        self, frame: npt.NDArray[Any], step: _Step
    ) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
        out = self.run(step, frame)
        if out.shape[0] <= self.vocab_size:
            raise NemoEarError("the joint carries no duration scores")
        return out[: self.vocab_size], out[self.vocab_size :]


def _joint_width(session: Any) -> int | None:
    try:
        width = session.get_outputs()[0].shape[-1]
    except (AttributeError, IndexError, TypeError):
        return None
    return width if isinstance(width, int) else None


# ---- the runner ---------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class NemoReading:
    text: str
    tokens: list[str] | None = None  # pieces in text form (the word mark is a space)
    timestamps: list[float] | None = None  # seconds of each piece's first frame
    logprobs: list[float] | None = None


class _TimedReader:
    def __init__(self, ear: NemoEar) -> None:
        self._ear = ear

    def recognize(self, samples: npt.ArrayLike, sample_rate: int = SAMPLE_RATE, **kwargs: Any) -> NemoReading:
        return self._ear.read(samples, sample_rate, timed=True, **kwargs)


def hotword_bias(
    words: Sequence[str], vocab: Mapping[str, int], *, boost: float | None = None, word_mark: str = WORD_MARK
) -> ContextGraph | None:
    """A bias graph of the owner's words and the spellings a recogniser may write for each (Roman and Devanagari, see
    ``text_norm.hotword_variants``), as far as ``vocab`` (piece to id) can spell them; None when none can be spelled
    or no word was given, so a decoder skips biasing."""
    from text_norm import hotword_variants

    spelled: list[str] = []
    for word in words:
        for variant in hotword_variants(str(word), MAX_SPELLINGS):
            if variant not in spelled:
                spelled.append(variant)
    return graph_for_words(spelled, vocab, boost=boost, word_mark=word_mark) if spelled else None


def _float_samples(samples: npt.ArrayLike, sample_rate: int) -> npt.NDArray[np.float32]:
    if sample_rate != SAMPLE_RATE:
        raise NemoEarError("this runner reads 16 kHz audio; resample first")
    raw = np.asarray(samples)
    audio = raw.astype(np.float32) / 32768.0 if raw.dtype == np.int16 else raw.astype(np.float32)
    return np.nan_to_num(audio.reshape(-1), nan=0.0, posinf=0.0, neginf=0.0)


class NemoEar:
    def __init__(self, files: NemoFiles, vocab: dict[int, str], sessions: Sequence[Any]) -> None:
        self.kind = files.kind
        self.config = files.config
        self._pieces = vocab
        self.vocab_size = max(vocab) + 1
        blank = next((i for i, piece in vocab.items() if piece in BLANK_PIECES), None)
        if blank is None:
            raise NemoEarError("the vocabulary has no blank piece (<blk>)")
        self.blank_id = blank
        self.features_size = int(self.config.get("features_size", DEFAULT_FEATURES))
        self.subsampling = int(self.config.get("subsampling_factor", DEFAULT_SUBSAMPLING))
        self.max_tokens_per_step = int(self.config.get("max_tokens_per_step", DEFAULT_MAX_TOKENS_PER_STEP))
        if min(self.features_size, self.subsampling, self.max_tokens_per_step) < 1:
            raise NemoEarError("features_size, subsampling_factor and max_tokens_per_step must be at least 1")
        self.frame_s = HOP / SAMPLE_RATE * self.subsampling
        self.features = NemoFeatures(self.features_size)
        self._encoder = sessions[0]
        self._fused: _FusedJoint | None = None
        self.durations: tuple[int, ...] = DEFAULT_DURATIONS
        if self.kind != "ctc":
            self._fused = _FusedJoint(sessions[1], self.vocab_size, self.kind == "tdt")
            if self.kind == "tdt":
                self.durations = self._durations(sessions[1])

    def _durations(self, joint_session: Any) -> tuple[int, ...]:
        """The frame jump of every duration score: the config's list, else 0, 1, 2 ... as wide as the joint says."""
        listed = self.config.get("durations")
        if isinstance(listed, list) and listed:
            return tuple(int(d) for d in listed)
        wide = _joint_width(joint_session)
        return tuple(range(wide - self.vocab_size)) if wide and wide > self.vocab_size else DEFAULT_DURATIONS

    @classmethod
    def load(
        cls,
        folder: str | Path,
        kind: str | None = None,
        quantization: str | None = None,
        *,
        threads: int | None = None,
        session_factory: Callable[[Path], Any] | None = None,
    ) -> NemoEar:
        files = discover(Path(folder), kind, quantization)
        vocab = read_vocab(files.vocab)
        make = session_factory or (lambda path: _default_session(path, threads or voice_budget.steady("asr_final")))
        sessions = [make(path) for path in [files.encoder] + ([files.decoder_joint] if files.decoder_joint else [])]
        if files.kind == "rnnt" and not kind:
            wide = _joint_width(sessions[1])
            if wide and wide > max(vocab) + 1:  # a joint wider than the vocabulary carries durations
                files = NemoFiles("tdt", files.vocab, files.encoder, files.decoder_joint, files.config)
        return cls(files, vocab, sessions)

    # -- text --------------------------------------------------------------------------------------------------------

    def pieces(self) -> list[str]:
        """The piece of every id with the word mark kept, as the CTC reader and the hotword vocabulary expect."""
        out = [""] * self.vocab_size
        for index, piece in self._pieces.items():
            out[index] = piece
        return out

    def _text_piece(self, index: int) -> str:
        return self._pieces[index].replace(WORD_MARK, " ")

    def _reading(self, ids: Sequence[int], frames: Sequence[int] | None, scores: npt.ArrayLike | None) -> NemoReading:
        tokens = [self._text_piece(i) for i in ids]
        text = _SPACES.sub(lambda hit: " " if hit.group(1) else "", "".join(tokens))
        stamps = None if frames is None else [round(float(f) * self.frame_s, 6) for f in frames]
        return NemoReading(
            text, tokens, stamps, None if scores is None else [float(s) for s in np.asarray(scores).reshape(-1)]
        )

    # -- graphs ------------------------------------------------------------------------------------------------------

    def _features(
        self, samples: npt.ArrayLike, sample_rate: int
    ) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.int64]]:
        audio = _float_samples(samples, sample_rate)
        feats, count = self.features(audio)
        return feats[None, :, :], np.asarray([count], dtype=np.int64)

    def _frames_of(self, count: int) -> int:
        return (count - 1) // self.subsampling + 1

    def _ctc_rows(self, samples: npt.ArrayLike, sample_rate: int) -> npt.NDArray[np.float32]:
        feats, lens = self._features(samples, sample_rate)
        (head,) = self._encoder.run(["logprobs"], {"audio_signal": feats, "length": lens})
        rows = np.asarray(head, dtype=np.float32)[0, : self._frames_of(int(lens[0]))]
        if rows.ndim != 2 or rows.shape[1] > self.vocab_size:
            raise NemoEarError("the CTC head is wider than the vocabulary")
        return rows

    def _encoded(self, samples: npt.ArrayLike, sample_rate: int) -> npt.NDArray[np.float32]:
        feats, lens = self._features(samples, sample_rate)
        out, out_lens = self._encoder.run(["outputs", "encoded_lengths"], {"audio_signal": feats, "length": lens})
        steps = np.asarray(out, dtype=np.float32)[0].T  # (frames, dim)
        return steps[: max(0, min(int(np.asarray(out_lens).reshape(-1)[0]), steps.shape[0]))]

    # -- reading -----------------------------------------------------------------------------------------------------

    def hotword_bias(self, words: Sequence[str], *, boost: float | None = None) -> ContextGraph | None:
        """The bias graph of the owner's words (and their spellings) in this model's vocabulary, or None."""
        vocab = {piece: index for index, piece in self._pieces.items() if piece and index != self.blank_id}
        return hotword_bias(words, vocab, boost=boost)

    def read(
        self,
        samples: npt.ArrayLike,
        sample_rate: int = SAMPLE_RATE,
        *,
        hotwords: TokenBias | None = None,
        timed: bool = False,
    ) -> NemoReading:
        """The reading of one clip. ``hotwords`` biases a beam search; without them the decode is greedy. ``timed``
        asks a biased CTC reading for its piece times and scores too (``with_timestamps()`` readers always do)."""
        trie = hotwords if hotwords else None
        if self.kind == "ctc":
            return self._read_ctc(self._ctc_rows(samples, sample_rate), trie, timed=timed)
        return self._read_transducer(self._encoded(samples, sample_rate), trie)

    def _read_ctc(self, rows: npt.NDArray[np.float32], trie: TokenBias | None, *, timed: bool = False) -> NemoReading:
        if trie and rows.shape[0]:
            best = ctc_prefix_beam(rows, blank_id=self.blank_id, hotwords=trie)[0]
            if not timed:
                return self._reading(best.tokens, None, None)
            if best.bonus > 0.0:  # a hotword made it into the line: time and score the beam's pieces
                try:
                    spans = ctc_align(rows, best.tokens, self.blank_id)
                except ValueError:  # too few frames to align: the pieces without times
                    return self._reading(best.tokens, None, None)
                scores = [float(rows[a : b + 1, tok].sum()) for tok, (a, b) in zip(best.tokens, spans, strict=True)]
                return self._reading(best.tokens, [a for a, _ in spans], scores)
        greedy = ctc_greedy(rows, self.blank_id)
        if not greedy.tokens:
            return self._reading([], [], [])
        # a piece's score is the sum of the best-piece scores over its frames, up to where the next piece starts
        kept = np.where(rows.argmax(axis=1) != self.blank_id, rows.max(axis=1), 0.0)
        return self._reading(greedy.tokens, greedy.frames, np.add.reduceat(kept, greedy.frames))

    def _read_transducer(self, enc: npt.NDArray[np.float32], trie: TokenBias | None) -> NemoReading:
        fused = self._fused
        if fused is None:
            raise NemoEarError("a CTC model has no decoder and joint")
        tdt = self.kind == "tdt"
        common: dict[str, Any] = {"blank_id": self.blank_id, "initial_state": fused.zero_state}
        if trie and enc.shape[0]:
            if tdt:
                tbeam = TdtBeamDecoder(
                    fused.decoder, fused.tdt_joint, durations=self.durations, hotwords=trie, **common
                )
                tbeam.decode_chunk(enc)
                return self._reading(tbeam.best().tokens, None, None)
            rbeam = RnntBeamDecoder(fused.decoder, fused.joint, hotwords=trie, **common)
            rbeam.decode_chunk(enc)
            return self._reading(rbeam.best().tokens, None, None)
        limit = self.max_tokens_per_step
        if tdt:
            heard = TdtGreedyDecoder(
                fused.decoder, fused.tdt_joint, durations=self.durations, max_symbols_per_step=limit, **common
            ).decode_chunk(enc)
        else:
            heard = RnntGreedyDecoder(fused.decoder, fused.joint, max_symbols_per_step=limit, **common).decode_chunk(
                enc
            )
        return self._reading([e.token for e in heard], [e.frame for e in heard], [e.logprob for e in heard])

    def recognize(self, samples: npt.ArrayLike, sample_rate: int = SAMPLE_RATE, **kwargs: Any) -> str:
        return self.read(samples, sample_rate, **kwargs).text

    def with_timestamps(self) -> _TimedReader:
        return _TimedReader(self)

    # -- the CTC head for the chunked reader -------------------------------------------------------------------------

    def ctc_head(self) -> tuple[list[str], float] | None:
        """``(pieces, frame_s)`` of the CTC head, or None for a transducer."""
        return (self.pieces(), self.frame_s) if self.kind == "ctc" else None

    def log_probs(self, samples: npt.ArrayLike) -> tuple[npt.NDArray[np.float32], list[str], float] | None:
        """``(log_probs [T, V], pieces, frame_s)`` of a CTC model for 16 kHz samples; None for a transducer, a run
        that fails, or output that is not log probabilities (biasing logits would be wrong)."""
        if self.kind != "ctc":
            return None
        try:
            rows = self._ctc_rows(samples, SAMPLE_RATE)
        except Exception:  # noqa: BLE001 — any failure means the text-only reading answers instead
            return None
        if rows.shape[0] == 0 or not np.isfinite(rows).all() or float(rows.max()) > 1e-3:
            return None
        return rows, self.pieces(), self.frame_s
