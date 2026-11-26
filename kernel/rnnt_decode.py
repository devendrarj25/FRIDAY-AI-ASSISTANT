"""FRIDAY Ears: RNN-T / transducer decoding over abstract callables, numpy only (greedy and a small beam).

Interface contract
------------------
The model is three callables, so any runtime (onnxruntime sessions, a test fake) plugs in:

* ``decoder(token_id, state) -> (decoder_out, new_state)``: the prediction network for ONE token. ``state`` is
  opaque (the LSTM ``(h, c)`` pair); the first call gets ``initial_state`` and the blank id as the start token.
* ``joint(encoder_frame, decoder_out) -> logits``: a ``(vocab,)`` vector for one encoder frame and one decoder
  output. Logits are turned into log probabilities here.
* The encoder runs elsewhere; these classes read its output ``enc`` of shape ``(frames, dim)``.

``RnntGreedyDecoder.decode_chunk(enc)`` handles one chunk of encoder frames. The decoder state and the last token
are CARRIED to the next call, so a streaming session decodes chunk after chunk with no restart. Per frame it
emits tokens until the joint says blank or ``max_symbols_per_step`` tokens were emitted, then moves to the next
frame. It returns the ``RnntEmission`` list of that chunk (token id, global frame index).

``RnntBeamDecoder.decode_chunk(enc)`` keeps ``beam_width`` hypotheses across chunks (one decoder state each, same
carry rule). Hypotheses with the same tokens are merged by summing probability. ``best()`` returns the best
``RnntHypothesis``; with ``hotwords`` (a ``hotword_trie.HotwordTrie``) a bonus is added as tokens are emitted and a
half-matched hotword is given back in ``best()``. ``reset()`` starts a new utterance.

Functions ``rnnt_greedy`` and ``rnnt_beam`` decode one whole ``enc`` with a fresh decoder. No import side effects.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt
from hotword_trie import HotwordTrie

DecoderFn = Callable[[int, Any], tuple[npt.NDArray[Any], Any]]
JointFn = Callable[[npt.NDArray[Any], npt.NDArray[Any]], npt.NDArray[Any]]

NEG_INF = -math.inf


def _log_softmax(logits: npt.ArrayLike) -> npt.NDArray[np.float64]:
    x = np.asarray(logits, dtype=np.float64).reshape(-1)
    shifted = x - x.max()
    return shifted - np.log(np.exp(shifted).sum())


def _lse(a: float, b: float) -> float:
    if a == NEG_INF:
        return b
    if b == NEG_INF:
        return a
    hi, lo = (a, b) if a > b else (b, a)
    return hi + math.log1p(math.exp(lo - hi))


def _frames(enc: npt.ArrayLike) -> npt.NDArray[Any]:
    arr = np.asarray(enc)
    if arr.ndim != 2:
        raise ValueError("encoder output must be (frames, dim)")
    return arr


@dataclass(frozen=True)
class RnntEmission:
    token: int
    frame: int  # global frame index across chunks


@dataclass(frozen=True)
class RnntHypothesis:
    tokens: tuple[int, ...]
    acoustic: float
    bonus: float = 0.0

    @property
    def score(self) -> float:
        return self.acoustic + self.bonus


class RnntGreedyDecoder:
    def __init__(
        self,
        decoder: DecoderFn,
        joint: JointFn,
        *,
        blank_id: int,
        max_symbols_per_step: int = 10,
        initial_state: Any = None,
    ) -> None:
        if max_symbols_per_step < 1:
            raise ValueError("max_symbols_per_step must be >= 1")
        self.decoder, self.joint = decoder, joint
        self.blank_id = blank_id
        self.max_symbols_per_step = max_symbols_per_step
        self._initial_state = initial_state
        self.reset()

    def reset(self) -> None:
        self.frames_seen = 0
        self.tokens: list[int] = []
        self._decoder_out, self._state = self.decoder(self.blank_id, self._initial_state)

    def decode_chunk(self, enc: npt.ArrayLike) -> list[RnntEmission]:
        out: list[RnntEmission] = []
        for frame in _frames(enc):
            for _ in range(self.max_symbols_per_step):
                best = int(np.argmax(self.joint(frame, self._decoder_out)))
                if best == self.blank_id:
                    break
                out.append(RnntEmission(best, self.frames_seen))
                self.tokens.append(best)
                self._decoder_out, self._state = self.decoder(best, self._state)
            self.frames_seen += 1
        return out


def rnnt_greedy(
    enc: npt.ArrayLike,
    decoder: DecoderFn,
    joint: JointFn,
    *,
    blank_id: int,
    max_symbols_per_step: int = 10,
    initial_state: Any = None,
) -> list[RnntEmission]:
    engine = RnntGreedyDecoder(
        decoder, joint, blank_id=blank_id, max_symbols_per_step=max_symbols_per_step, initial_state=initial_state
    )
    return engine.decode_chunk(enc)


@dataclass
class _Hyp:
    tokens: tuple[int, ...]
    acoustic: float
    hot_state: int
    bonus: float
    parent_state: Any = None  # decoder state before the last token (the decoder runs lazily, only for survivors)


class RnntBeamDecoder:
    def __init__(
        self,
        decoder: DecoderFn,
        joint: JointFn,
        *,
        blank_id: int,
        beam_width: int = 4,
        max_symbols_per_step: int = 3,
        hotwords: HotwordTrie | None = None,
        initial_state: Any = None,
    ) -> None:
        if beam_width < 1 or max_symbols_per_step < 1:
            raise ValueError("beam_width and max_symbols_per_step must be >= 1")
        self.decoder, self.joint = decoder, joint
        self.blank_id = blank_id
        self.beam_width = beam_width
        self.max_symbols_per_step = max_symbols_per_step
        self.hotwords = hotwords if hotwords else None
        self._initial_state = initial_state
        self.reset()

    def reset(self) -> None:
        self.frames_seen = 0
        self._hyps: dict[tuple[int, ...], _Hyp] = {(): _Hyp((), 0.0, HotwordTrie.ROOT, 0.0)}
        self._cache: dict[tuple[int, ...], tuple[npt.NDArray[Any], Any]] = {
            (): self.decoder(self.blank_id, self._initial_state)
        }

    def _decoder_for(self, hyp: _Hyp) -> tuple[npt.NDArray[Any], Any]:
        cached = self._cache.get(hyp.tokens)
        if cached is None:
            cached = self.decoder(hyp.tokens[-1], hyp.parent_state)
            self._cache[hyp.tokens] = cached
        return cached

    def _prune(self, hyps: dict[tuple[int, ...], _Hyp]) -> dict[tuple[int, ...], _Hyp]:
        kept = sorted(hyps.values(), key=lambda h: (-(h.acoustic + h.bonus), h.tokens))[: self.beam_width]
        return {h.tokens: h for h in kept}

    def decode_chunk(self, enc: npt.ArrayLike) -> None:
        for frame in _frames(enc):
            self._hyps = self._step_frame(frame)
            self.frames_seen += 1
        self._cache = {key: value for key, value in self._cache.items() if key in self._hyps}

    def _step_frame(self, frame: npt.NDArray[Any]) -> dict[tuple[int, ...], _Hyp]:
        finished: dict[tuple[int, ...], _Hyp] = {}
        active = dict(self._hyps)
        for depth in range(self.max_symbols_per_step + 1):
            grown: dict[tuple[int, ...], _Hyp] = {}
            for hyp in active.values():
                decoder_out, state_after = self._decoder_for(hyp)
                logp = _log_softmax(self.joint(frame, decoder_out))
                blank = hyp.acoustic + float(logp[self.blank_id])
                self._merge(finished, _Hyp(hyp.tokens, blank, hyp.hot_state, hyp.bonus, hyp.parent_state))
                if depth == self.max_symbols_per_step:
                    continue  # the symbol budget of this frame is spent: only the blank may follow
                for token in self._best_tokens(logp):
                    hot, delta = self.hotwords.step(hyp.hot_state, token) if self.hotwords else (HotwordTrie.ROOT, 0.0)
                    child = _Hyp(
                        hyp.tokens + (token,), hyp.acoustic + float(logp[token]), hot, hyp.bonus + delta, state_after
                    )
                    self._merge(grown, child)
            active = self._prune(grown)
            if not active:
                break
        return self._prune(finished)

    def _best_tokens(self, logp: npt.NDArray[np.float64]) -> list[int]:
        masked = logp.copy()
        masked[self.blank_id] = NEG_INF
        count = min(self.beam_width, masked.shape[0] - 1)
        if count < 1:
            return []
        pool = np.argpartition(-masked, count - 1)[:count].tolist()
        return sorted(pool, key=lambda i: (-masked[i], i))

    @staticmethod
    def _merge(into: dict[tuple[int, ...], _Hyp], hyp: _Hyp) -> None:
        old = into.get(hyp.tokens)
        if old is None:
            into[hyp.tokens] = hyp
        else:
            old.acoustic = _lse(old.acoustic, hyp.acoustic)

    def n_best(self) -> list[RnntHypothesis]:
        out = []
        for hyp in self._hyps.values():
            bonus = hyp.bonus - (self.hotwords.pending_bonus(hyp.hot_state) if self.hotwords else 0.0)
            out.append(RnntHypothesis(hyp.tokens, hyp.acoustic, bonus))
        return sorted(out, key=lambda h: (-h.score, h.tokens))

    def best(self) -> RnntHypothesis:
        return self.n_best()[0]


def rnnt_beam(
    enc: npt.ArrayLike,
    decoder: DecoderFn,
    joint: JointFn,
    *,
    blank_id: int,
    beam_width: int = 4,
    max_symbols_per_step: int = 3,
    hotwords: HotwordTrie | None = None,
    initial_state: Any = None,
) -> RnntHypothesis:
    engine = RnntBeamDecoder(
        decoder,
        joint,
        blank_id=blank_id,
        beam_width=beam_width,
        max_symbols_per_step=max_symbols_per_step,
        hotwords=hotwords,
        initial_state=initial_state,
    )
    engine.decode_chunk(enc)
    return engine.best()
