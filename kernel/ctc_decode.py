"""FRIDAY Ears: CTC decoding, numpy only (greedy and prefix beam search, optional hotword bonus).

Interface contract
------------------
* Input is ``log_probs``: a ``(frames, vocab)`` float array of per-frame log probabilities (``log_softmax`` of the
  logits; ``log_softmax`` is provided). ``blank_id`` is the CTC blank. Token ids are plain ints; turning ids into
  text is the caller's job.
* ``ctc_greedy`` takes the best token per frame, merges repeats and drops blanks.
* ``ctc_prefix_beam`` is the standard CTC prefix beam search in log space: every prefix keeps the probability of
  ending in a blank and of ending in a token, so paths that collapse to the same text are summed. It returns the
  ``beam_width`` best ``CtcHypothesis`` objects, best first (``score`` is acoustic log probability plus hotword
  bonus). With no hotwords the best one has the exact CTC prefix probability, which can differ from greedy.
* ``hotwords`` is an optional ``hotword_trie.HotwordTrie``. A bonus is added when a hypothesis appends a token
  that continues a hotword, and a half-matched hotword is given back at the end, so a hotword is never rewarded
  for being merely started. The trie's caps bound the boost; blank frames never earn it.
* Per frame only the ``max_candidates`` best tokens (and the blank) are expanded and tokens below ``prune_log_prob``
  are skipped, which keeps a large vocabulary cheap. Output is deterministic: ties break on token ids.

No import side effects; import it inside the feature that needs it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from hotword_trie import HotwordTrie

NEG_INF = -math.inf


def log_softmax(logits: npt.ArrayLike, axis: int = -1) -> npt.NDArray[np.float64]:
    x = np.asarray(logits, dtype=np.float64)
    shifted = x - x.max(axis=axis, keepdims=True)
    return shifted - np.log(np.exp(shifted).sum(axis=axis, keepdims=True))


def _lse(a: float, b: float) -> float:
    if a == NEG_INF:
        return b
    if b == NEG_INF:
        return a
    hi, lo = (a, b) if a > b else (b, a)
    return hi + math.log1p(math.exp(lo - hi))


@dataclass(frozen=True)
class CtcGreedyResult:
    tokens: list[int]
    frames: list[int]  # frame where each token first appeared


@dataclass(frozen=True)
class CtcHypothesis:
    tokens: tuple[int, ...]
    acoustic: float  # log probability of the prefix, all alignments summed
    bonus: float = 0.0

    @property
    def score(self) -> float:
        return self.acoustic + self.bonus


def _check(log_probs: npt.ArrayLike, blank_id: int) -> npt.NDArray[np.float64]:
    arr = np.asarray(log_probs, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] == 0:
        raise ValueError("log_probs must be (frames, vocab)")
    if not 0 <= blank_id < arr.shape[1]:
        raise ValueError("blank_id is outside the vocabulary")
    return arr


def ctc_greedy(log_probs: npt.ArrayLike, blank_id: int = 0) -> CtcGreedyResult:
    arr = _check(log_probs, blank_id)
    tokens: list[int] = []
    frames: list[int] = []
    previous = blank_id
    for t, best in enumerate(np.argmax(arr, axis=1).tolist()):
        if best != blank_id and best != previous:
            tokens.append(int(best))
            frames.append(t)
        previous = int(best)
    return CtcGreedyResult(tokens, frames)


def _candidates(row: npt.NDArray[np.float64], blank_id: int, limit: int, floor: float) -> list[int]:
    """Best tokens of one frame, best first; the blank is always included."""
    count = min(limit, row.shape[0])
    pool = list(range(row.shape[0])) if count == row.shape[0] else np.argpartition(-row, count - 1)[:count].tolist()
    order = sorted(pool, key=lambda i: (-row[i], i))
    chosen = [i for i in order if row[i] >= floor or i == order[0]]
    if blank_id not in chosen:
        chosen.append(blank_id)
    return chosen


def ctc_prefix_beam(
    log_probs: npt.ArrayLike,
    *,
    beam_width: int = 8,
    blank_id: int = 0,
    hotwords: HotwordTrie | None = None,
    max_candidates: int = 16,
    prune_log_prob: float = -15.0,
) -> list[CtcHypothesis]:
    arr = _check(log_probs, blank_id)
    if beam_width < 1 or max_candidates < 1:
        raise ValueError("beam_width and max_candidates must be >= 1")
    trie = hotwords if hotwords else None
    root = HotwordTrie.ROOT
    beams: dict[tuple[int, ...], tuple[float, float]] = {(): (0.0, NEG_INF)}
    meta: dict[tuple[int, ...], tuple[int, float]] = {(): (root, 0.0)}

    for row in arr:
        scores: dict[tuple[int, ...], list[float]] = {}
        for prefix, (p_blank, p_token) in beams.items():
            total = _lse(p_blank, p_token)
            last = prefix[-1] if prefix else None
            for c in _candidates(row, blank_id, max_candidates, prune_log_prob):
                p = float(row[c])
                if c == blank_id:
                    entry = scores.setdefault(prefix, [NEG_INF, NEG_INF])
                    entry[0] = _lse(entry[0], total + p)
                    continue
                grown = prefix + (c,)
                if grown not in meta:
                    state, bonus = meta[prefix]
                    state, delta = trie.step(state, c) if trie is not None else (root, 0.0)
                    meta[grown] = (state, bonus + delta)
                new = scores.setdefault(grown, [NEG_INF, NEG_INF])
                if c == last:
                    new[1] = _lse(new[1], p_blank + p)  # a repeat needs a blank between the two
                    stay = scores.setdefault(prefix, [NEG_INF, NEG_INF])
                    stay[1] = _lse(stay[1], p_token + p)  # without one it collapses into the same prefix
                else:
                    new[1] = _lse(new[1], total + p)
        alive = [(prefix, pair, _lse(pair[0], pair[1])) for prefix, pair in scores.items()]
        ranked = sorted(
            ((prefix, pair) for prefix, pair, total in alive if total != NEG_INF),
            key=lambda item: (-(_lse(item[1][0], item[1][1]) + meta[item[0]][1]), item[0]),
        )[:beam_width]
        beams = {prefix: (pair[0], pair[1]) for prefix, pair in ranked}
        meta = {prefix: meta[prefix] for prefix in beams}

    out: list[CtcHypothesis] = []
    for prefix, (p_blank, p_token) in beams.items():
        state, bonus = meta[prefix]
        if trie is not None:
            bonus -= trie.pending_bonus(state)
        out.append(CtcHypothesis(prefix, _lse(p_blank, p_token), bonus))
    out.sort(key=lambda h: (-h.score, h.tokens))
    return out
