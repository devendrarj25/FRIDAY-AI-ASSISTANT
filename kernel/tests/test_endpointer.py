"""FRIDAY Ears: the end-of-turn table on seeded tone-burst and gap timelines (no clock, no audio)."""

from __future__ import annotations

import random
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from endpointer import (  # noqa: E402
    EndpointConfig,
    Endpointer,
    EndpointEvent,
    Observation,
    end_wait_ms,
    holds_entity,
    trails_off,
)

TICK = 20
Segment = tuple[str, int]  # ("burst" | "gap", milliseconds)


def run(
    segments: list[Segment],
    text: str | Callable[[int], str] = "open the settings",
    score: float | None | Callable[[int], float | None] = None,
    config: EndpointConfig | None = None,
    seed: int = 11,
    token_age_in_gap: Callable[[int], int] | None = None,
) -> list[tuple[int, str]]:
    """Play a timeline; return (time_ms, event) pairs."""
    rng = random.Random(seed)  # noqa: S311 - seeded test data
    ep = Endpointer(config)
    events: list[tuple[int, str]] = []
    now = 0
    quiet = 0
    for kind, length in segments:
        for _ in range(length // TICK):
            now += TICK
            if kind == "burst":
                quiet = 0
                vad, age = 0.8 + 0.2 * rng.random(), rng.randrange(0, 60)
            else:
                quiet += TICK
                vad, age = 0.2 * rng.random(), (token_age_in_gap(quiet) if token_age_in_gap else 10_000)
            obs = Observation(
                vad_probability=vad,
                trailing_silence_ms=quiet,
                token_age_ms=age,
                turn_probability=score(quiet) if callable(score) else score,
                text=text(now) if callable(text) else text,
            )
            decision = ep.step(obs)
            if decision.event is not None:
                events.append((now, decision.event.value))
    return events


def names(events: list[tuple[int, str]]) -> list[str]:
    return [name for _, name in events]


def test_defaults_are_the_renderer_rules():
    cfg = EndpointConfig()
    assert (cfg.open_silence_ms, cfg.closed_silence_ms, cfg.trailing_off_extra_ms, cfg.hard_cap_ms) == (
        420,
        700,
        780,
        1600,
    )
    assert (cfg.eager_ms, cfg.confirmed_end_ms, cfg.confirm_probability) == (240, 280, 0.6)
    assert EndpointConfig(conversation_open=False).base_ms == 700


def test_plain_turn_starts_goes_eager_then_ends_at_the_open_pause():
    events = run([("gap", 200), ("burst", 1000), ("gap", 1000)])
    assert names(events) == ["StartOfTurn", "EagerEndOfTurn", "EndOfTurn"]
    start, eager, end = (t for t, _ in events)
    assert start == 220
    assert eager - 1200 == 240  # the burst ends at 1200 ms
    assert end - 1200 == 420


def test_waiting_for_the_wake_word_waits_700():
    events = run([("burst", 600), ("gap", 1500)], config=EndpointConfig(conversation_open=False))
    assert names(events) == ["StartOfTurn", "EagerEndOfTurn", "EndOfTurn"]
    assert events[-1][0] - 600 == 700


def test_speech_after_an_eager_end_is_turn_resumed_then_the_turn_ends_later():
    events = run([("burst", 800), ("gap", 300), ("burst", 600), ("gap", 1000)])
    assert names(events) == ["StartOfTurn", "EagerEndOfTurn", "TurnResumed", "EagerEndOfTurn", "EndOfTurn"]


def test_a_short_gap_before_the_eager_mark_changes_nothing():
    assert names(run([("burst", 800), ("gap", 120), ("burst", 600), ("gap", 1000)])) == [
        "StartOfTurn",
        "EagerEndOfTurn",
        "EndOfTurn",
    ]


@pytest.mark.parametrize("word", ["aur", "ki", "toh", "matlab", "and", "so", "but", "और"])
def test_trailing_off_words_wait_longer_but_not_past_the_cap(word):
    text = f"mujhe batao {word}"
    assert trails_off(text)
    events = run([("burst", 800), ("gap", 2400)], text=text)
    assert names(events) == ["StartOfTurn", "EndOfTurn"]  # no speculative reply on a half sentence
    assert events[-1][0] - 800 == 420 + 780 <= 1600


def test_a_finished_sentence_is_not_trailing_off():
    assert not trails_off("open settings.")
    assert not trails_off("")
    assert trails_off("open settings,")
    assert not trails_off("this is a bandit")  # "and"/"a" inside a word is not the word


def test_digits_and_spelled_names_are_held_longer():
    for text in ("my number is 98765", "mera naam A R J U N", "नाम ए आर जे"):
        assert holds_entity(text), text
    for text in ("open the settings", "yeh sahi hai", "वह है ना", "call mom."):
        assert not holds_entity(text), text
    held = run([("burst", 800), ("gap", 2000)], text="mera number 98765")
    plain = run([("burst", 800), ("gap", 2000)], text="mera number hai")
    assert held[-1][0] - 800 == 420 + 600
    assert plain[-1][0] - 800 == 420
    assert "EagerEndOfTurn" not in names(held)


def test_a_confident_score_closes_early_and_an_unsure_one_waits_the_long_pause():
    sure = run([("burst", 800), ("gap", 1500)], score=0.9)
    assert sure[-1][0] - 800 == 280
    unsure = run([("burst", 800), ("gap", 2500)], score=0.2)
    assert unsure[-1][0] - 800 == 420 + 780
    assert "EagerEndOfTurn" not in names(unsure)
    middle = run([("burst", 800), ("gap", 1500)], score=0.55)
    assert middle[-1][0] - 800 == 420


def test_a_late_score_is_never_waited_for():
    late = run([("burst", 800), ("gap", 1500)], score=lambda quiet: 0.9 if quiet >= 1000 else None)
    assert late[-1][0] - 800 == 420  # the rules ended it before the score arrived


def test_the_hard_cap_wins_over_text_entity_score_and_a_moving_recogniser():
    text = "mera number 98765 aur"
    events = run(
        [("burst", 800), ("gap", 3000)],
        text=text,
        score=0.1,
        token_age_in_gap=lambda quiet: 0,  # tokens keep arriving
    )
    assert names(events) == ["StartOfTurn", "EndOfTurn"]
    assert events[-1][0] - 800 == 1600
    assert end_wait_ms(EndpointConfig(trailing_off_extra_ms=5000), text, 0.1) == 1600


def test_a_recogniser_still_producing_tokens_delays_the_end():
    events = run([("burst", 800), ("gap", 1500)], token_age_in_gap=lambda quiet: quiet - 300 if quiet > 300 else 0)
    assert names(events) == ["StartOfTurn", "EagerEndOfTurn", "EndOfTurn"]
    # token age reaches the 100 ms settle mark at quiet = 400 (eager) and the table at 420 ends it
    assert events[1][0] - 800 >= 400
    assert events[-1][0] - 800 == 420


def test_end_wait_is_never_above_the_cap_for_any_input():
    cfg = EndpointConfig(conversation_open=False)
    for text in ("", "a b c", "so", "123", "ok."):
        for score in (None, 0.0, 0.3, 0.6, 1.0, float("nan")):
            assert 0 <= end_wait_ms(cfg, text, score) <= cfg.hard_cap_ms
    assert end_wait_ms(EndpointConfig(), "x", float("nan")) == 420  # an unusable score is ignored


def test_idle_noise_never_starts_a_turn_and_reset_closes_one():
    ep = Endpointer()
    for _ in range(50):
        assert ep.step(Observation(0.1, 500)).event is None
    assert ep.step(Observation(0.9, 0)).event is EndpointEvent.START_OF_TURN
    assert ep.in_turn
    ep.reset()
    assert not ep.in_turn


def test_end_of_turn_returns_to_idle_so_the_next_burst_starts_again():
    events = run([("burst", 600), ("gap", 800), ("burst", 600), ("gap", 800)])
    assert names(events).count("StartOfTurn") == 2 and names(events).count("EndOfTurn") == 2


def test_seeded_timelines_repeat_exactly():
    segs: list[Segment] = [("burst", 700), ("gap", 260), ("burst", 500), ("gap", 900)]
    assert run(segs, seed=5) == run(segs, seed=5)


def test_bad_probability_order_is_refused():
    with pytest.raises(ValueError):
        EndpointConfig(low_probability=0.9, confirm_probability=0.6)
