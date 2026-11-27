"""FRIDAY Ears: the hotword automaton (pure logic, deterministic)."""

from __future__ import annotations

import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hotword_trie import HotwordTrie  # noqa: E402


def test_a_finished_phrase_earns_its_bonus_a_half_match_earns_nothing():
    trie = HotwordTrie(bonus=2.0)
    assert trie.add_phrase([5, 6, 7])
    assert trie.sequence_bonus([5, 6, 7]) == pytest.approx(6.0)
    assert trie.sequence_bonus([5, 6]) == pytest.approx(4.0)  # still running: pending
    assert trie.sequence_bonus([5, 6, 9]) == pytest.approx(0.0)  # broke off: given back
    assert trie.sequence_bonus([9, 5, 6, 7, 9, 9]) == pytest.approx(6.0)  # banked after the phrase ends


def test_pending_bonus_is_what_an_open_match_still_holds():
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([1, 2, 3])
    state, total = HotwordTrie.ROOT, 0.0
    for token in (1, 2):
        state, delta = trie.step(state, token)
        total += delta
    assert total == 2.0 and trie.pending_bonus(state) == 2.0
    state, delta = trie.step(state, 3)
    assert trie.pending_bonus(state) == 0.0 and total + delta == 3.0  # finished: nothing to give back
    assert trie.pending_bonus(HotwordTrie.ROOT) == 0.0


def test_step_returns_states_and_deltas_one_token_at_a_time():
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([1, 2])
    state, d1 = trie.step(HotwordTrie.ROOT, 1)
    assert d1 == 1.0 and not trie.is_terminal(state)
    state, d2 = trie.step(state, 2)
    assert d2 == 1.0 and trie.is_terminal(state)
    state, d3 = trie.step(state, 1)  # a new match can start right after a finished one
    assert d3 == 1.0 and not trie.is_terminal(state)
    _, d4 = trie.step(state, 3)
    assert d4 == -1.0


def test_failure_links_find_a_phrase_that_starts_inside_a_broken_one():
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([1, 2, 3])
    trie.add_phrase([2, 3, 4])
    assert trie.sequence_bonus([1, 2, 3]) == pytest.approx(3.0)
    assert trie.sequence_bonus([1, 2, 4]) == pytest.approx(0.0)
    # "1 2 3 4" really contains both phrases (they overlap), so each earns its own bonus
    assert trie.sequence_bonus([1, 2, 3, 4]) == pytest.approx(6.0)
    assert trie.sequence_bonus([2, 3, 4]) == pytest.approx(3.0)


def test_shared_prefix_and_prefix_phrase():
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([1, 2])
    trie.add_phrase([1, 2, 3])
    assert trie.sequence_bonus([1, 2, 3]) == pytest.approx(3.0)
    assert trie.sequence_bonus([1, 2, 9]) == pytest.approx(2.0)  # the short phrase still counts


def test_large_boosts_are_capped_per_token_and_per_phrase():
    trie = HotwordTrie(bonus=1000.0, max_token_bonus=3.0, max_phrase_bonus=8.0)
    trie.add_phrase([1])
    trie.add_phrase([2, 3, 4, 5, 6, 7])
    assert trie.sequence_bonus([1]) == pytest.approx(3.0)
    assert trie.sequence_bonus([2, 3, 4, 5, 6, 7]) == pytest.approx(8.0)
    assert trie.effective_bonus(2, bonus=50.0) == 3.0
    assert trie.effective_bonus(10, bonus=50.0) == pytest.approx(0.8)


def test_random_streams_stay_inside_the_phrase_cap_per_finished_match():
    rng = random.Random(7)  # noqa: S311 - seeded test data
    trie = HotwordTrie(bonus=99.0, max_phrase_bonus=5.0)
    for _ in range(6):
        trie.add_phrase([rng.randrange(4) for _ in range(rng.randrange(1, 5))])
    state, total, finished = HotwordTrie.ROOT, 0.0, 0
    for _ in range(2000):
        state, delta = trie.step(state, rng.randrange(4))
        finished += trie.is_terminal(state)
        total += delta
        assert -1e-9 <= total <= 5.0 * (finished + 1) + 1e-9


def test_empty_and_non_positive_adds_are_ignored_and_empty_trie_is_inert():
    trie = HotwordTrie()
    assert not trie and len(trie) == 0
    assert trie.add_phrase([]) is False
    assert trie.add_phrase([1], bonus=0.0) is False
    assert trie.add_phrase([1], bonus=-2.0) is False
    assert trie.step(HotwordTrie.ROOT, 1) == (HotwordTrie.ROOT, 0.0)
    assert trie.sequence_bonus([1, 2, 3]) == 0.0


def test_adding_after_use_rebuilds_the_automaton():
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([1, 2])
    assert trie.sequence_bonus([3, 4]) == 0.0
    trie.add_phrase([3, 4])
    assert trie.sequence_bonus([3, 4]) == pytest.approx(2.0)
    assert len(trie) == 2


def test_negative_caps_are_refused():
    with pytest.raises(ValueError):
        HotwordTrie(max_token_bonus=-1.0)
