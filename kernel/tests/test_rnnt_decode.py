"""FRIDAY Ears: RNN-T greedy and beam over fake decoder and joint callables (no model, deterministic)."""

from __future__ import annotations

import math
import sys
import zlib
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from context_graph import ContextGraph  # noqa: E402
from ctc_decode import ctc_prefix_beam  # noqa: E402
from hotword_trie import HotwordTrie  # noqa: E402
from rnnt_decode import (  # noqa: E402
    RnntBeamDecoder,
    RnntGreedyDecoder,
    TdtBeamDecoder,
    TdtGreedyDecoder,
    rnnt_beam,
    rnnt_greedy,
    tdt_beam,
    tdt_greedy,
)

BLANK = 0
VOCAB = 4


def encoder_frames(count: int) -> np.ndarray:
    """One row per frame; column 0 is the frame number the fake joint reads."""
    return np.arange(count, dtype=np.float64)[:, None] * np.ones((1, 2))


def fake_decoder(token: int, state):
    """The state is the tuple of emitted tokens; the start call (state None) gets the blank id."""
    history = () if state is None else (*state, token)
    return np.array([float(len(history)), float(history[-1]) if history else -1.0]), history


def scripted_joint(plan: list[tuple[int, int]]):
    """plan[n] = (frame, token): the n-th token of the utterance is emitted at that frame, else blank."""

    def joint(frame: np.ndarray, dec: np.ndarray) -> np.ndarray:
        n, t = int(dec[0]), int(frame[0])
        logits = np.zeros(VOCAB)
        if n < len(plan) and plan[n][0] == t:
            logits[plan[n][1]] = 9.0
        else:
            logits[BLANK] = 9.0
        return logits

    return joint


PLAN = [(1, 2), (1, 3), (4, 1), (6, 2)]


def test_greedy_emits_tokens_with_global_frame_indices():
    out = rnnt_greedy(encoder_frames(8), fake_decoder, scripted_joint(PLAN), blank_id=BLANK)
    assert [(e.token, e.frame) for e in out] == [(2, 1), (3, 1), (1, 4), (2, 6)]


def test_max_symbols_per_step_caps_a_frame_and_the_rest_is_not_emitted_there():
    burst = [(2, 1), (2, 2), (2, 3), (2, 1)]
    capped = rnnt_greedy(encoder_frames(5), fake_decoder, scripted_joint(burst), blank_id=BLANK, max_symbols_per_step=2)
    assert [e.token for e in capped] == [1, 2]  # frame 3 onward never sees the other two
    free = rnnt_greedy(encoder_frames(5), fake_decoder, scripted_joint(burst), blank_id=BLANK)
    assert [e.token for e in free] == [1, 2, 3, 1]


def test_a_joint_that_never_says_blank_still_moves_on_every_frame():
    def never_blank(frame, dec):
        return np.array([-5.0, 3.0, 0.0, 0.0])

    out = rnnt_greedy(encoder_frames(4), fake_decoder, never_blank, blank_id=BLANK, max_symbols_per_step=3)
    assert len(out) == 12 and [e.frame for e in out] == [f for f in range(4) for _ in range(3)]


def test_decoder_state_and_last_token_are_carried_across_chunks():
    enc = encoder_frames(8)
    whole = rnnt_greedy(enc, fake_decoder, scripted_joint(PLAN), blank_id=BLANK)
    engine = RnntGreedyDecoder(fake_decoder, scripted_joint(PLAN), blank_id=BLANK)
    pieces = [engine.decode_chunk(enc[a:b]) for a, b in ((0, 2), (2, 5), (5, 5), (5, 8))]
    # the fake joint reads the carried history: a restart would re-emit plan[0] in every chunk
    assert [e for piece in pieces for e in piece] == whole
    assert engine.tokens == [2, 3, 1, 2] and engine.frames_seen == 8


def test_greedy_reset_starts_a_new_utterance():
    engine = RnntGreedyDecoder(fake_decoder, scripted_joint(PLAN), blank_id=BLANK)
    first = engine.decode_chunk(encoder_frames(8))
    engine.reset()
    assert engine.decode_chunk(encoder_frames(8)) == first and engine.tokens == [2, 3, 1, 2]


def test_blank_id_can_be_any_index_and_initial_state_reaches_the_decoder():
    seen = []

    def decoder(token, state):
        seen.append((token, state))
        return np.zeros(1), state

    def joint(frame, dec):
        return np.array([1.0, 1.0, 5.0])

    out = rnnt_greedy(encoder_frames(3), decoder, joint, blank_id=2, initial_state="h0")
    assert out == [] and seen == [(2, "h0")]


def test_bad_arguments_are_refused():
    with pytest.raises(ValueError):
        RnntGreedyDecoder(fake_decoder, scripted_joint([]), blank_id=0, max_symbols_per_step=0)
    with pytest.raises(ValueError):
        RnntBeamDecoder(fake_decoder, scripted_joint([]), blank_id=0, beam_width=0)
    with pytest.raises(ValueError):
        rnnt_greedy(np.zeros(4), fake_decoder, scripted_joint([]), blank_id=0)


def test_beam_on_a_peaked_joint_equals_greedy():
    enc = encoder_frames(8)
    best = rnnt_beam(enc, fake_decoder, scripted_joint(PLAN), blank_id=BLANK, beam_width=4, max_symbols_per_step=3)
    assert best.tokens == (2, 3, 1, 2) and best.bonus == 0.0
    assert best.acoustic == pytest.approx(0.0, abs=1e-2)


# ---- beam against an exact enumeration ------------------------------------------------------------------------


def soft_joint(frame: np.ndarray, dec: np.ndarray) -> np.ndarray:
    """Pseudo-random but fixed logits per (frame, emitted history)."""
    seed = zlib.crc32(f"{int(frame[0])}:{int(dec[0])}:{int(dec[1])}".encode())
    return np.random.default_rng(seed).standard_normal(VOCAB)


def exact_prefix_probabilities(frames: int, max_symbols: int) -> dict[tuple[int, ...], float]:
    """Sum the probability of every alignment per token sequence, with the same per-frame symbol budget."""
    out: dict[tuple[int, ...], float] = {}

    def lp(t: int, history: tuple[int, ...]) -> np.ndarray:
        dec, _ = fake_decoder(history[-1], history[:-1]) if history else fake_decoder(BLANK, None)
        logits = soft_joint(np.array([float(t)]), dec)
        shifted = logits - logits.max()
        return shifted - np.log(np.exp(shifted).sum())

    def walk(t: int, history: tuple[int, ...], logprob: float, used: int) -> None:
        if t == frames:
            out[history] = out.get(history, 0.0) + math.exp(logprob)
            return
        row = lp(t, history)
        walk(t + 1, history, logprob + float(row[BLANK]), 0)
        if used < max_symbols:
            for token in range(1, VOCAB):
                walk(t, history + (token,), logprob + float(row[token]), used + 1)

    walk(0, (), 0.0, 0)
    return out


def test_wide_beam_sums_alignments_exactly_like_the_enumeration():
    frames, budget = 3, 2
    truth = exact_prefix_probabilities(frames, budget)
    engine = RnntBeamDecoder(fake_decoder, soft_joint, blank_id=BLANK, beam_width=5000, max_symbols_per_step=budget)
    engine.decode_chunk(encoder_frames(frames))
    got = {h.tokens: h.acoustic for h in engine.n_best()}
    assert set(got) == set(truth)
    for tokens, prob in truth.items():
        assert got[tokens] == pytest.approx(math.log(prob), abs=1e-9)
    ranked = [h.score for h in engine.n_best()]
    assert ranked == sorted(ranked, reverse=True)


def test_narrow_beam_returns_at_most_beam_width_hypotheses_and_is_deterministic():
    enc = encoder_frames(6)
    one = RnntBeamDecoder(fake_decoder, soft_joint, blank_id=BLANK, beam_width=3)
    two = RnntBeamDecoder(fake_decoder, soft_joint, blank_id=BLANK, beam_width=3)
    one.decode_chunk(enc)
    two.decode_chunk(enc)
    assert len(one.n_best()) <= 3 and one.n_best() == two.n_best()


def test_beam_chunks_carry_hypotheses_and_decoder_states():
    enc = encoder_frames(6)
    whole = RnntBeamDecoder(fake_decoder, soft_joint, blank_id=BLANK, beam_width=4)
    whole.decode_chunk(enc)
    parts = RnntBeamDecoder(fake_decoder, soft_joint, blank_id=BLANK, beam_width=4)
    for a, b in ((0, 1), (1, 4), (4, 6)):
        parts.decode_chunk(enc[a:b])
    assert parts.n_best() == whole.n_best() and parts.frames_seen == 6
    parts.reset()
    assert parts.best().tokens == () and parts.frames_seen == 0


def test_the_decoder_is_only_run_for_surviving_hypotheses():
    calls = []

    def counting(token, state):
        calls.append(token)
        return fake_decoder(token, state)

    engine = RnntBeamDecoder(counting, soft_joint, blank_id=BLANK, beam_width=2, max_symbols_per_step=2)
    engine.decode_chunk(encoder_frames(5))
    assert len(calls) <= 1 + 5 * 2 * (
        2 + 2 * 2
    )  # start call plus at most beam x depth x children, never the vocabulary


# ---- hotwords --------------------------------------------------------------------------------------------------


def tie_joint(frame: np.ndarray, dec: np.ndarray) -> np.ndarray:
    """After nothing: a 0.50, b 0.45; once something was said: blank."""
    probs = [0.05, 0.50, 0.45, 0.0001] if int(dec[0]) == 0 else [0.9997, 0.0001, 0.0001, 0.0001]
    return np.log(np.array(probs))


def test_hotword_bonus_tips_a_close_call_and_is_reported():
    enc = encoder_frames(1)
    assert rnnt_beam(enc, fake_decoder, tie_joint, blank_id=BLANK).tokens == (1,)
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([2])
    best = rnnt_beam(enc, fake_decoder, tie_joint, blank_id=BLANK, hotwords=trie)
    assert best.tokens == (2,) and best.bonus == pytest.approx(1.0)


def test_a_huge_boost_cannot_insert_a_token_the_audio_lacks():
    def silent(frame, dec):
        return np.log(np.array([0.99997, 0.00001, 0.00001, 0.00001]))

    trie = HotwordTrie(bonus=10_000.0)
    trie.add_phrase([3])
    best = rnnt_beam(encoder_frames(5), fake_decoder, silent, blank_id=BLANK, hotwords=trie)
    assert best.tokens == ()


def test_half_matched_hotword_is_given_back_in_the_final_score():
    trie = HotwordTrie(bonus=1.0)
    trie.add_phrase([1, 2])
    best = rnnt_beam(encoder_frames(1), fake_decoder, tie_joint, blank_id=BLANK, hotwords=trie)
    assert best.tokens == (1,) and best.bonus == pytest.approx(0.0)
    assert rnnt_beam(encoder_frames(1), fake_decoder, tie_joint, blank_id=BLANK, hotwords=HotwordTrie()).bonus == 0.0


# ---- TDT: token logits and a duration (frame jump) per step ----------------------------------------------------

SPANS = 5  # durations (0, 1, 2, 3, 4)


def tdt_joint_for(plan: list[tuple[int, int, int]], blank_jump: int = 1):
    """plan[n] = (frame, token, jump): the n-th token is read at that frame and the decoder jumps ``jump`` frames."""

    def joint(frame: np.ndarray, dec: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        n, t = int(dec[0]), int(frame[0])
        tokens, spans = np.zeros(VOCAB), np.zeros(SPANS)
        if n < len(plan) and plan[n][0] == t:
            tokens[plan[n][1]] = 9.0
            spans[plan[n][2]] = 9.0
        else:
            tokens[BLANK] = 9.0
            spans[blank_jump] = 9.0
        return tokens, spans

    return joint


def test_tdt_greedy_jumps_by_the_chosen_duration():
    plan = [(1, 2, 3), (4, 3, 1), (5, 1, 2)]  # 1 -> 4 -> 5 -> 7: frames 2, 3, 6 are never read
    out = tdt_greedy(encoder_frames(9), fake_decoder, tdt_joint_for(plan), blank_id=BLANK)
    assert [(e.token, e.frame, e.duration) for e in out] == [(2, 1, 3), (3, 4, 1), (1, 5, 2)]


def test_tdt_greedy_keeps_the_frame_for_a_zero_duration_token():
    plan = [(2, 1, 0), (2, 3, 0), (2, 2, 1)]  # three tokens on frame 2, the last one moves on
    out = tdt_greedy(encoder_frames(5), fake_decoder, tdt_joint_for(plan), blank_id=BLANK)
    assert [(e.token, e.frame) for e in out] == [(1, 2), (3, 2), (2, 2)]


def test_tdt_blank_with_a_zero_duration_still_moves_one_frame():
    seen: list[int] = []

    def joint(frame: np.ndarray, dec: np.ndarray):
        seen.append(int(frame[0]))
        return np.array([9.0, 0, 0, 0]), np.array([9.0, 0, 0, 0, 0])  # blank, duration 0

    assert tdt_greedy(encoder_frames(4), fake_decoder, joint, blank_id=BLANK) == []
    assert seen == [0, 1, 2, 3]


def test_tdt_max_symbols_per_step_ends_a_frame_that_never_moves_on():
    def stuck(frame: np.ndarray, dec: np.ndarray):
        return np.array([-5.0, 3.0, 0, 0]), np.array([9.0, 0, 0, 0, 0])  # always token 1, duration 0

    out = tdt_greedy(encoder_frames(3), fake_decoder, stuck, blank_id=BLANK, max_symbols_per_step=2)
    assert [e.frame for e in out] == [0, 0, 1, 1, 2, 2]


def test_tdt_jump_past_the_end_of_a_chunk_is_carried_into_the_next():
    plan = [(1, 2, 4), (6, 3, 1), (7, 1, 1)]
    whole = tdt_greedy(encoder_frames(10), fake_decoder, tdt_joint_for(plan), blank_id=BLANK)
    engine = TdtGreedyDecoder(fake_decoder, tdt_joint_for(plan), blank_id=BLANK)
    parts = []
    for first, last in ((0, 3), (3, 4), (4, 10)):  # the jump from frame 1 lands in the third chunk
        chunk = np.arange(first, last, dtype=np.float64)[:, None] * np.ones((1, 2))
        parts += engine.decode_chunk(chunk)
    assert parts == whole and [(e.token, e.frame) for e in whole] == [(2, 1), (3, 6), (1, 7)]
    assert engine.frames_seen == 10 and engine.tokens == [2, 3, 1]


def test_tdt_durations_table_maps_an_index_to_a_jump():
    plan = [(0, 2, 2), (4, 3, 1)]  # index 2 of (0, 2, 4, 6, 8) is a jump of 4
    out = tdt_greedy(
        encoder_frames(6),
        fake_decoder,
        tdt_joint_for(plan),
        blank_id=BLANK,
        durations=(0, 2, 4, 6, 8),
        max_symbols_per_step=2,
    )
    assert [(e.token, e.frame, e.duration) for e in out] == [(2, 0, 4), (3, 4, 2)]


def test_tdt_emission_carries_the_log_probability_of_the_token_alone():
    out = tdt_greedy(encoder_frames(3), fake_decoder, tdt_joint_for([(1, 2, 1)]), blank_id=BLANK)
    expected = 9.0 - math.log(math.exp(9.0) + 3.0)
    assert out[0].logprob == pytest.approx(expected)


def test_rnnt_emission_carries_its_log_probability_too():
    out = rnnt_greedy(encoder_frames(3), fake_decoder, scripted_joint([(1, 2)]), blank_id=BLANK)
    assert out[0].logprob == pytest.approx(9.0 - math.log(math.exp(9.0) + 3.0))


def test_tdt_greedy_reset_starts_a_new_utterance():
    engine = TdtGreedyDecoder(fake_decoder, tdt_joint_for([(1, 2, 1)]), blank_id=BLANK)
    first = engine.decode_chunk(encoder_frames(4))
    engine.reset()
    assert engine.decode_chunk(encoder_frames(4)) == first and engine.frames_seen == 4


def test_tdt_bad_arguments_are_refused():
    joint = tdt_joint_for([])
    with pytest.raises(ValueError):
        TdtGreedyDecoder(fake_decoder, joint, blank_id=BLANK, max_symbols_per_step=0)
    for durations in ((), (0, -1)):
        with pytest.raises(ValueError):
            TdtGreedyDecoder(fake_decoder, joint, blank_id=BLANK, durations=durations)
    with pytest.raises(ValueError):
        TdtBeamDecoder(fake_decoder, joint, blank_id=BLANK, beam_width=0)
    with pytest.raises(ValueError):
        TdtGreedyDecoder(fake_decoder, joint, blank_id=BLANK).decode_chunk(np.zeros(4))


def seeded_tdt_joint(frame: np.ndarray, dec: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    key = zlib.crc32(f"{int(frame[0])}:{int(dec[0])}:{int(dec[1])}".encode())
    rng = np.random.default_rng(key)
    return rng.normal(size=VOCAB) * 2.0, rng.normal(size=SPANS) * 2.0


def reference_tdt(frames: int) -> list[tuple[int, int]]:
    """The NeMo rule written out on its own for the seeded joint: (token, frame) pairs."""
    out: list[tuple[int, int]] = []
    history: tuple[int, ...] = ()
    t = emitted = 0
    while t < frames:
        dec = np.array([float(len(history)), float(history[-1]) if history else -1.0])
        tokens, spans = seeded_tdt_joint(encoder_frames(frames)[t], dec)
        token, jump = int(np.argmax(tokens)), int(np.argmax(spans))
        if token != BLANK:
            out.append((token, t))
            history += (token,)
            emitted += 1
        if jump > 0:
            t += jump
            emitted = 0
        elif token == BLANK or emitted == 10:
            t += 1
            emitted = 0
    return out


@pytest.mark.parametrize("frames", [6, 17, 40])
def test_tdt_greedy_matches_the_published_rule_on_a_seeded_joint(frames):
    expected = reference_tdt(frames)
    out = tdt_greedy(encoder_frames(frames), fake_decoder, seeded_tdt_joint, blank_id=BLANK)
    assert expected and [(e.token, e.frame) for e in out] == expected


def test_tdt_beam_on_a_peaked_joint_equals_greedy():
    plan = [(1, 2, 2), (3, 3, 1), (4, 1, 1)]
    greedy = tdt_greedy(encoder_frames(8), fake_decoder, tdt_joint_for(plan), blank_id=BLANK)
    best = tdt_beam(encoder_frames(8), fake_decoder, tdt_joint_for(plan), blank_id=BLANK, beam_width=3)
    assert list(best.tokens) == [e.token for e in greedy] == [2, 3, 1]


def test_tdt_beam_chunks_carry_hypotheses_waiting_for_a_later_frame():
    plan = [(1, 2, 4), (6, 3, 1)]
    whole = tdt_beam(encoder_frames(9), fake_decoder, tdt_joint_for(plan), blank_id=BLANK, beam_width=3)
    engine = TdtBeamDecoder(fake_decoder, tdt_joint_for(plan), blank_id=BLANK, beam_width=3)
    for first, last in ((0, 2), (2, 5), (5, 9)):
        engine.decode_chunk(np.arange(first, last, dtype=np.float64)[:, None] * np.ones((1, 2)))
    assert engine.best().tokens == whole.tokens == (2, 3)
    assert engine.best().acoustic == pytest.approx(whole.acoustic)


def test_tdt_beam_sums_the_alignments_that_spell_the_same_tokens():
    def soft(frame: np.ndarray, dec: np.ndarray):
        return np.array([0.0, 1.0, 0.0, 0.0]), np.array([0.0, 0.0, 0.0, 0.0, 0.0])

    wide = TdtBeamDecoder(fake_decoder, soft, blank_id=BLANK, beam_width=64, max_symbols_per_step=1)
    wide.decode_chunk(encoder_frames(3))
    narrow = TdtBeamDecoder(fake_decoder, soft, blank_id=BLANK, beam_width=1, max_symbols_per_step=1)
    narrow.decode_chunk(encoder_frames(3))
    by_tokens = {h.tokens: h.acoustic for h in wide.n_best()}
    assert () in by_tokens and (1,) in by_tokens and len(by_tokens) > 3
    total = sum(math.exp(v) for v in by_tokens.values())
    assert total <= 1.0 + 1e-9  # probabilities of distinct token strings never exceed one
    assert len(narrow.n_best()) <= 1 and narrow.best().score <= wide.best().score + 1e-12


def tdt_tie_joint(frame: np.ndarray, dec: np.ndarray):
    quiet = np.array([9.0, -9.0, -9.0, -9.0])
    tokens = np.array([-3.0, -9.0, 1.0, 1.04])  # on frame 1 token 3 edges token 2 by a hair
    jump_one = np.array([-9.0, 9.0, -9.0, -9.0, -9.0])
    return (tokens if int(frame[0]) == 1 else quiet), jump_one


def test_tdt_hotword_bonus_tips_a_close_call():
    plain = tdt_beam(encoder_frames(3), fake_decoder, tdt_tie_joint, blank_id=BLANK, beam_width=4)
    trie = HotwordTrie()
    trie.add_phrase([2])
    boosted = tdt_beam(encoder_frames(3), fake_decoder, tdt_tie_joint, blank_id=BLANK, beam_width=4, hotwords=trie)
    assert plain.tokens != boosted.tokens and boosted.tokens == (2,) and boosted.bonus > 0


def test_tdt_beam_keeps_a_blank_with_zero_duration_moving_and_reset_starts_again():
    def blank_zero(frame: np.ndarray, dec: np.ndarray):
        return np.array([9.0, -9.0, -9.0, -9.0]), np.array([9.0, -9.0, -9.0, -9.0, -9.0])

    engine = TdtBeamDecoder(fake_decoder, blank_zero, blank_id=BLANK, beam_width=2)
    engine.decode_chunk(encoder_frames(5))
    assert engine.best().tokens == () and engine.frames_seen == 5
    engine.reset()
    assert engine.frames_seen == 0 and engine.best().tokens == ()


# ---- a ContextGraph (any TokenBias) in the transducer beams ----------------------------------------------------------


def _graph(*phrases: list[int], boost: float = 1.5) -> ContextGraph:
    graph = ContextGraph(boost=boost)
    for phrase in phrases:
        graph.add_phrase(phrase)
    return graph


def _trie(*phrases: list[int], bonus: float = 1.5) -> HotwordTrie:
    trie = HotwordTrie(bonus=bonus)
    for phrase in phrases:
        trie.add_phrase(phrase)
    return trie


def _near_tie_joint(p_hot: float):
    """After nothing: token 1 holds 0.5 and the hotword token 2 holds ``p_hot``; once said: blank."""

    def joint(frame: np.ndarray, dec: np.ndarray) -> np.ndarray:
        rest = max(1e-4, 1.0 - 0.5 - p_hot - 0.0001)
        probs = [rest, 0.50, p_hot, 0.0001] if int(dec[0]) == 0 else [0.9997, 0.0001, 0.0001, 0.0001]
        return np.log(np.array(probs))

    return joint


def _near_tie_tdt(p_hot: float):
    plain = _near_tie_joint(p_hot)
    jump_one = np.array([-9.0, 9.0, -9.0, -9.0, -9.0])
    return lambda frame, dec: (plain(frame, dec), jump_one)


def _hot_probs() -> list[float]:
    return [float(p) for p in np.random.default_rng(7).uniform(0.15, 0.49, size=12)]


def test_a_context_graph_runs_in_the_rnnt_beam_with_an_integer_state_and_a_running_bonus():
    graph = _graph([2])
    best = rnnt_beam(encoder_frames(1), fake_decoder, _near_tie_joint(0.45), blank_id=BLANK, hotwords=graph)
    assert best.tokens == (2,) and best.bonus == pytest.approx(graph.sequence_bonus([2], finish=True))
    engine = RnntBeamDecoder(fake_decoder, _near_tie_joint(0.45), blank_id=BLANK, hotwords=graph)
    engine.decode_chunk(encoder_frames(1))
    assert all(isinstance(h.hot_state, int) for h in engine._hyps.values())


def test_a_half_matched_graph_phrase_is_given_back_in_the_rnnt_and_the_tdt_beam():
    graph = _graph([1, 2])
    rnnt = rnnt_beam(encoder_frames(1), fake_decoder, _near_tie_joint(0.45), blank_id=BLANK, hotwords=graph)
    assert rnnt.tokens == (1,) and rnnt.bonus == pytest.approx(0.0)
    tdt = tdt_beam(encoder_frames(1), fake_decoder, _near_tie_tdt(0.45), blank_id=BLANK, hotwords=graph)
    assert tdt.tokens == (1,) and tdt.bonus == pytest.approx(0.0)


@pytest.mark.parametrize("kind", ["rnnt", "tdt"])
def test_graph_recall_is_at_least_the_hotword_trie_on_close_calls(kind):
    def run(p_hot: float, bias):
        if kind == "rnnt":
            return rnnt_beam(encoder_frames(2), fake_decoder, _near_tie_joint(p_hot), blank_id=BLANK, hotwords=bias)
        return tdt_beam(encoder_frames(2), fake_decoder, _near_tie_tdt(p_hot), blank_id=BLANK, hotwords=bias)

    cases = _hot_probs()
    plain = sum(run(p, None).tokens[:1] == (2,) for p in cases)
    by_trie = sum(run(p, _trie([2])).tokens[:1] == (2,) for p in cases)
    by_graph = sum(run(p, _graph([2])).tokens[:1] == (2,) for p in cases)
    assert plain == 0 and by_trie == len(cases) and by_graph >= by_trie


def test_ctc_graph_recall_is_at_least_the_hotword_trie_on_close_calls():
    def rows(p_hot: float) -> np.ndarray:
        probs = np.full((3, 5), 0.02)
        probs[0, 0] = probs[2, 0] = 0.92
        probs[1, 3], probs[1, 2] = 0.5, p_hot
        return np.log(probs / probs.sum(axis=1, keepdims=True))

    cases = _hot_probs()
    plain = sum(ctc_prefix_beam(rows(p), blank_id=0)[0].tokens == (2,) for p in cases)
    by_trie = sum(ctc_prefix_beam(rows(p), blank_id=0, hotwords=_trie([2]))[0].tokens == (2,) for p in cases)
    by_graph = sum(ctc_prefix_beam(rows(p), blank_id=0, hotwords=_graph([2]))[0].tokens == (2,) for p in cases)
    assert plain == 0 and by_trie == len(cases) and by_graph >= by_trie
    older = ctc_prefix_beam(rows(0.3), blank_id=0, context=_graph([2]))  # the older keyword still works
    assert older[0].tokens == (2,)


def test_a_finished_short_hotword_survives_a_failed_longer_one_in_the_beam():
    def joint(frame: np.ndarray, dec: np.ndarray) -> np.ndarray:
        said = int(dec[0])
        probs = {0: [0.05, 0.50, 0.40, 0.0001], 1: [0.05, 0.001, 0.949, 0.0001]}.get(said)
        return np.log(np.array(probs if probs else [0.9997, 0.0001, 0.0001, 0.0001]))

    graph = _graph([2], [2, 3, 3])
    best = rnnt_beam(encoder_frames(3), fake_decoder, joint, blank_id=BLANK, hotwords=graph)
    assert best.bonus == pytest.approx(graph.sequence_bonus(list(best.tokens), finish=True))
    assert best.tokens[:1] == (2,) and best.bonus > 0


@pytest.mark.parametrize("kind", ["rnnt", "tdt"])
def test_no_hotwords_and_unspoken_hotwords_insert_nothing(kind):
    def sharp(frame, dec):
        return np.log(np.array([0.9997, 0.0001, 0.0001, 0.0001]))

    def sharp_tdt(frame, dec):
        return sharp(frame, dec), np.array([-9.0, 9.0, -9.0, -9.0, -9.0])

    huge = _graph([1], [2, 3], [3], boost=10_000.0)

    def run(bias):
        if kind == "rnnt":
            return rnnt_beam(encoder_frames(6), fake_decoder, sharp, blank_id=BLANK, hotwords=bias)
        return tdt_beam(encoder_frames(6), fake_decoder, sharp_tdt, blank_id=BLANK, hotwords=bias)

    assert run(None).tokens == () and run(ContextGraph()).tokens == ()
    biased = run(huge)
    assert biased.tokens == () and biased.bonus == 0.0
