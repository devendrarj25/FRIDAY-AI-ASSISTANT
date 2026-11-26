"""FRIDAY Ears: RNN-T greedy and beam over fake decoder and joint callables (no model, deterministic)."""

from __future__ import annotations

import math
import sys
import zlib
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hotword_trie import HotwordTrie  # noqa: E402
from rnnt_decode import RnntBeamDecoder, RnntGreedyDecoder, rnnt_beam, rnnt_greedy  # noqa: E402

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
