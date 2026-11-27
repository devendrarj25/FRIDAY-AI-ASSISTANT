"""FRIDAY Ears: context graph (Aho-Corasick biasing with backoff) and its hook in the CTC prefix beam."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from context_graph import ContextGraph, graph_for_words  # noqa: E402
from ctc_decode import ctc_greedy, ctc_prefix_beam  # noqa: E402
from hotword_trie import HotwordTrie  # noqa: E402

BLANK, A, B, C, D, X = 0, 1, 2, 3, 4, 5


def peaked(path: list[int], vocab: int, sharp: float = 0.97) -> np.ndarray:
    rows = np.full((len(path), vocab), (1 - sharp) / (vocab - 1))
    for t, token in enumerate(path):
        rows[t, token] = sharp
    return np.log(rows)


def test_a_finished_phrase_earns_boost_times_tokens_and_a_started_one_is_given_back():
    graph = ContextGraph(boost=1.0)
    graph.add_phrase([A, B, C])
    assert graph.sequence_bonus([A, B, C]) == pytest.approx(3.0)
    assert graph.sequence_bonus([A, B, X]) == pytest.approx(0.0)  # mismatch gives the half match back
    state = ContextGraph.ROOT
    for token in (A, B):
        state, _ = graph.step(state, token)
    assert graph.pending_bonus(state) == pytest.approx(2.0)
    assert graph.sequence_bonus([A, B], finish=True) == pytest.approx(0.0)
    assert graph.sequence_bonus([A, B, C], finish=True) == pytest.approx(3.0)


def test_every_phrase_has_its_own_boost():
    graph = ContextGraph(boost=1.0)
    graph.add_phrase([A, B], boost=0.5)
    graph.add_phrase([C, D], boost=2.0)
    assert graph.sequence_bonus([A, B]) == pytest.approx(1.0)
    assert graph.sequence_bonus([C, D]) == pytest.approx(4.0)
    assert not graph.add_phrase([], boost=1.0) and not graph.add_phrase([A], boost=0.0)
    assert len(graph) == 2


def test_caps_hold_however_large_the_boost():
    graph = ContextGraph(boost=1e6, max_token_boost=2.0, max_phrase_boost=5.0)
    graph.add_phrase([A, B, C, D])
    assert graph.sequence_bonus([A, B, C, D]) <= 5.0 + 1e-9
    graph.add_phrase([X], boost=1e9)
    assert graph.sequence_bonus([X]) == pytest.approx(2.0)


def test_backoff_keeps_a_finished_phrase_when_a_longer_one_fails():
    graph = ContextGraph(boost=1.0)
    graph.add_phrase([A, B])
    graph.add_phrase([A, B, C, D])
    # "a b c x": a b finished, c started the longer phrase and x broke it
    assert graph.sequence_bonus([A, B, C, X], finish=True) == pytest.approx(2.0)
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([A, B])
    trie.add_phrase([A, B, C, D])
    assert trie.sequence_bonus([A, B, C, X]) == pytest.approx(0.0)  # the trie leaks the finished phrase


def test_backoff_falls_to_the_longest_matching_suffix():
    graph = ContextGraph(boost=1.0)
    graph.add_phrase([A, B, C])
    graph.add_phrase([B, C, D])
    # "a b c" is finished (3); d breaks that state but "b c d" still matches through the failure link (3 more)
    assert graph.sequence_bonus([A, B, C]) == pytest.approx(3.0)
    assert graph.sequence_bonus([A, B, C, D], finish=True) == pytest.approx(6.0)
    assert graph.sequence_bonus([A, B, X], finish=True) == pytest.approx(0.0)
    assert graph.sequence_bonus([A, B, C, X], finish=True) == pytest.approx(3.0)


def test_scan_reports_labels_and_spans_including_suffix_phrases():
    graph = ContextGraph()
    graph.add_phrase([A, B], label="ab")
    graph.add_phrase([B], label="b")
    graph.add_phrase([C, D], label="cd")
    found = [(m.label, m.start, m.end) for m in graph.scan([X, A, B, C, D])]
    assert ("ab", 1, 3) in found and ("b", 2, 3) in found and ("cd", 3, 5) in found
    assert graph.scan([X, X]) == []


def test_partial_weight_lowers_the_credit_of_an_unfinished_phrase_only():
    graph = ContextGraph(boost=1.0, partial_weight=0.5)
    graph.add_phrase([A, B, C])
    state = ContextGraph.ROOT
    for token in (A, B):
        state, _ = graph.step(state, token)
    assert graph.pending_bonus(state) == pytest.approx(1.0)
    assert graph.sequence_bonus([A, B, C]) == pytest.approx(3.0)


def test_look_alike_spelling_is_helped_but_less_than_the_exact_one():
    graph = ContextGraph(boost=1.0, confusions={B: [D]}, fuzzy_weight=0.5)
    graph.add_phrase([A, B, C])
    exact = graph.sequence_bonus([A, B, C], finish=True)
    near = graph.sequence_bonus([A, D, C], finish=True)
    assert exact == pytest.approx(3.0) and 0.0 < near < exact
    assert graph.sequence_bonus([A, X, C], finish=True) == pytest.approx(0.0)
    assert [m.label for m in graph.scan([A, D, C])] == ["1-2-3"]


def test_bad_settings_are_refused():
    with pytest.raises(ValueError):
        ContextGraph(max_token_boost=-1)
    with pytest.raises(ValueError):
        ContextGraph(partial_weight=1.5)


def test_graph_for_words_spells_words_and_skips_unspellable_ones():
    vocab = {"▁fri": 1, "day": 2, "▁hi": 3}
    graph = graph_for_words(["friday", ("hi", 2.0), "zzz"], vocab)
    assert graph is not None and len(graph) == 2
    assert graph.sequence_bonus([3]) == pytest.approx(2.0)
    assert graph_for_words(["zzz"], vocab) is None


def test_beam_with_an_empty_graph_equals_no_bias_and_both_options_together_are_refused():
    table = np.log(np.random.default_rng(4).dirichlet(np.ones(6), size=7))
    assert ctc_prefix_beam(table, context=ContextGraph()) == ctc_prefix_beam(table)
    one = HotwordTrie()
    one.add_phrase([A])
    two = ContextGraph()
    two.add_phrase([A])
    with pytest.raises(ValueError):
        ctc_prefix_beam(table, hotwords=one, context=two)


def test_beam_reports_the_bonus_apart_and_a_near_tie_tips_to_the_hotword():
    table = np.log(np.asarray([[0.05, 0.50, 0.45, 0.0001, 0.0001, 0.0001]]) / 1.0001)
    assert ctc_prefix_beam(table)[0].tokens == (A,)
    graph = ContextGraph(boost=1.0)
    graph.add_phrase([B])
    best = ctc_prefix_beam(table, context=graph)[0]
    assert best.tokens == (B,) and best.bonus == pytest.approx(1.0)


def test_a_huge_boost_cannot_insert_a_word_the_audio_does_not_have():
    table = np.log(np.asarray([[0.99998, 0.00001, 0.00001, 0.00000001, 0.00000001, 0.00000001]] * 5))
    graph = ContextGraph(boost=10_000.0)
    graph.add_phrase([B])
    graph.add_phrase([A, B, A])
    assert ctc_prefix_beam(table, context=graph)[0].tokens == ()


def _fixture(seed: int, vocab: int = 24, length: int = 30) -> tuple[np.ndarray, list[int]]:
    rng = np.random.default_rng(seed)
    path = rng.integers(1, vocab, size=length).tolist()
    return peaked(path, vocab, sharp=0.9), path


def test_no_insertions_on_five_fixtures_without_the_hotwords():
    for seed in range(5):
        table, path = _fixture(seed)
        spoken = set(path)
        unseen = [t for t in range(1, 24) if t not in spoken][:3]
        graph = ContextGraph(boost=3.0)
        if len(unseen) >= 2:
            graph.add_phrase(unseen[:2])
            graph.add_phrase(unseen[1:])
        graph.add_phrase([unseen[0]] if unseen else [23])
        plain = ctc_prefix_beam(table, beam_width=4)[0].tokens
        biased = ctc_prefix_beam(table, beam_width=4, context=graph)[0].tokens
        assert biased == plain == tuple(ctc_greedy(table).tokens)


def _hotword_recall(use_graph: bool) -> int:
    """Hotword spoken but the model leans 55/45 to a rival token: how many does the bias recover."""
    hits = 0
    for seed in range(20):
        rng = np.random.default_rng(100 + seed)
        word = rng.choice(np.arange(1, 20), size=3, replace=False).tolist()
        rival = [t if t % 2 else 20 for t in word]
        rows = []
        for gold, other in zip(word, rival, strict=True):
            row = np.full(24, 0.001)
            row[gold], row[other if other != gold else 21] = 0.40, 0.55
            rows.append(row / row.sum())
            rows.append(np.eye(24)[0] * 0.97 + 0.001)  # a blank between
        table = np.log(np.asarray(rows) / np.asarray(rows).sum(axis=1, keepdims=True))
        if use_graph:
            bias = ContextGraph(boost=1.5)
            bias.add_phrase(word)
            top = ctc_prefix_beam(table, beam_width=8, context=bias)[0].tokens
        else:
            trie = HotwordTrie(bonus=1.5)
            trie.add_phrase(word)
            top = ctc_prefix_beam(table, beam_width=8, hotwords=trie)[0].tokens
        hits += int(top == tuple(word))
    return hits


def test_hotword_recall_on_synthetic_logits_is_at_least_the_trie():
    graph_hits, trie_hits = _hotword_recall(True), _hotword_recall(False)
    assert graph_hits >= trie_hits
    assert graph_hits >= 15
