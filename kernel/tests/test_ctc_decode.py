"""FRIDAY Ears: CTC greedy and prefix beam search with hotword bonus (synthetic posteriors, deterministic)."""

from __future__ import annotations

import itertools
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ctc_decode import CtcHypothesis, ctc_greedy, ctc_prefix_beam, log_softmax  # noqa: E402
from hotword_trie import HotwordTrie  # noqa: E402

BLANK, A, B = 0, 1, 2


def lp(rows: list[list[float]]) -> np.ndarray:
    return np.log(np.asarray(rows, dtype=np.float64))


def peaked(path: list[int], vocab: int, sharp: float = 0.97) -> np.ndarray:
    rows = np.full((len(path), vocab), (1 - sharp) / (vocab - 1))
    for t, token in enumerate(path):
        rows[t, token] = sharp
    return np.log(rows)


def brute_force(log_probs: np.ndarray, blank: int = BLANK) -> dict[tuple[int, ...], float]:
    """Sum the probability of every alignment per collapsed text."""
    frames, vocab = log_probs.shape
    out: dict[tuple[int, ...], float] = {}
    for path in itertools.product(range(vocab), repeat=frames):
        text: list[int] = []
        prev = None
        for token in path:
            if token != prev and token != blank:
                text.append(token)
            prev = token
        prob = math.exp(sum(log_probs[t, token] for t, token in enumerate(path)))
        out[tuple(text)] = out.get(tuple(text), 0.0) + prob
    return out


def test_greedy_merges_repeats_drops_blanks_and_reports_frames():
    result = ctc_greedy(peaked([A, A, BLANK, A, B, B, BLANK], 3))
    assert result.tokens == [A, A, B] and result.frames == [0, 3, 4]
    assert ctc_greedy(peaked([BLANK, BLANK], 3)).tokens == []
    assert ctc_greedy(np.zeros((0, 3))).tokens == []


def test_greedy_honours_a_blank_that_is_not_zero():
    assert ctc_greedy(peaked([2, 0, 2, 1], 3), blank_id=2).tokens == [0, 1]


def test_beam_sums_alignments_so_it_can_beat_greedy():
    frame = [0.4, 0.35, 0.25]
    table = lp([frame, frame])
    assert ctc_greedy(table).tokens == []  # best path is blank, blank
    best = ctc_prefix_beam(table, beam_width=8)[0]
    assert best.tokens == (A,)
    assert best.acoustic == pytest.approx(math.log(0.35 * 0.35 + 2 * 0.35 * 0.4))


def test_beam_scores_equal_the_brute_force_prefix_probabilities():
    rng = np.random.default_rng(3)
    table = log_softmax(rng.standard_normal((4, 3)))
    truth = brute_force(table)
    result = {h.tokens: h for h in ctc_prefix_beam(table, beam_width=50, max_candidates=3, prune_log_prob=-50)}
    assert set(result) == set(truth)
    for tokens, prob in truth.items():
        assert result[tokens].acoustic == pytest.approx(math.log(prob), abs=1e-9)
    ordered = [h.score for h in ctc_prefix_beam(table, beam_width=50, max_candidates=3, prune_log_prob=-50)]
    assert ordered == sorted(ordered, reverse=True)


def test_a_repeat_needs_a_blank_between_the_two_tokens():
    table = peaked([A, A], 3)
    assert ctc_prefix_beam(table)[0].tokens == (A,)
    assert ctc_prefix_beam(peaked([A, BLANK, A], 3))[0].tokens == (A, A)


def test_peaked_random_posteriors_agree_with_greedy_and_repeat():
    rng = np.random.default_rng(9)
    path = rng.integers(0, 40, size=60).tolist()
    table = peaked(path, 40)
    first = ctc_prefix_beam(table, beam_width=4)
    assert list(first[0].tokens) == ctc_greedy(table).tokens
    assert first == ctc_prefix_beam(table, beam_width=4)  # deterministic


def test_beam_width_limits_the_returned_list():
    table = log_softmax(np.random.default_rng(1).standard_normal((6, 5)))
    assert len(ctc_prefix_beam(table, beam_width=3)) <= 3
    assert ctc_prefix_beam(np.zeros((0, 3)))[0] == CtcHypothesis((), 0.0, 0.0)


def test_hotword_bonus_tips_a_near_tie_and_is_reported_separately():
    table = lp([[0.05, 0.50, 0.45]])
    assert ctc_prefix_beam(table)[0].tokens == (A,)
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([B])
    best = ctc_prefix_beam(table, hotwords=trie)[0]
    assert best.tokens == (B,) and best.bonus == pytest.approx(1.0)
    assert best.acoustic == pytest.approx(math.log(0.45)) and best.score == pytest.approx(math.log(0.45) + 1.0)


def test_a_huge_boost_cannot_insert_a_word_the_audio_does_not_have():
    table = lp([[0.99998, 0.00001, 0.00001]] * 5)
    trie = HotwordTrie(bonus=10_000.0)
    trie.add_phrase([B])
    assert ctc_prefix_beam(table, hotwords=trie)[0].tokens == ()
    twice = HotwordTrie(bonus=10_000.0)
    twice.add_phrase([A, B, A])
    assert ctc_prefix_beam(table, hotwords=twice)[0].tokens == ()


def test_a_hotword_helps_a_multi_token_phrase_only_when_it_completes():
    table = lp([[0.2, 0.4, 0.4], [0.5, 0.25, 0.25]])
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([A, B])
    for hyp in ctc_prefix_beam(table, hotwords=trie):
        # "a" alone or "b" alone: a started hotword earns nothing
        assert hyp.bonus == pytest.approx(2.0 if hyp.tokens == (A, B) else 0.0)
    full = ctc_prefix_beam(lp([[0.1, 0.5, 0.4], [0.1, 0.4, 0.5]]), hotwords=trie)
    top = full[0]
    assert top.tokens == (A, B) and top.bonus == pytest.approx(2.0)


def test_empty_trie_changes_nothing():
    table = log_softmax(np.random.default_rng(5).standard_normal((5, 4)))
    assert ctc_prefix_beam(table, hotwords=HotwordTrie()) == ctc_prefix_beam(table)


def test_bad_input_is_refused():
    with pytest.raises(ValueError):
        ctc_greedy(np.zeros(5))
    with pytest.raises(ValueError):
        ctc_greedy(np.zeros((2, 3)), blank_id=3)
    with pytest.raises(ValueError):
        ctc_prefix_beam(np.zeros((2, 3)), beam_width=0)


def test_large_vocabulary_is_pruned_to_the_best_candidates():
    rng = np.random.default_rng(2)
    path = rng.integers(1, 5000, size=8).tolist()
    table = peaked(path, 5000, sharp=0.9)
    best = ctc_prefix_beam(table, beam_width=3, max_candidates=8)[0]
    assert list(best.tokens) == path
