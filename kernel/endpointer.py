"""FRIDAY Ears: the end-of-turn decision table (pure logic, no audio, no clock, no dependencies).

Interface contract
------------------
* Feed one ``Observation`` per audio tick (about every 20 to 80 ms) to ``Endpointer.step``. It returns an
  ``EndpointDecision`` whose ``event`` is ``None`` or ONE of ``StartOfTurn``, ``EagerEndOfTurn``, ``TurnResumed``,
  ``EndOfTurn``. Time comes only from the observation (``trailing_silence_ms``, ``token_age_ms``): the module reads
  no clock, so a replay gives the same events.
* Event order for one turn: ``StartOfTurn`` once; then either ``EagerEndOfTurn`` (speculative, the quiet is long
  enough that a reply may start early) followed by ``TurnResumed`` if the owner goes on, or straight to
  ``EndOfTurn`` (final, the turn is over, the endpointer returns to idle). An eager end is always answered by a
  later ``TurnResumed`` or ``EndOfTurn``.
* ``turn_probability`` is the optional end-of-turn model score (``None`` when it has not answered). A late or
  missing score is never waited for: with ``None`` the text and silence rules decide alone, and the hard cap
  ``hard_cap_ms`` ends the turn whatever else is going on.
* ``end_wait_ms`` is the same table as a pure function: how much trailing quiet this text and score need.

The defaults are the rules the renderer already uses (``src/lib/friday/voice-session.ts``, ``endpointSilenceMs``,
``TURN_SCORE_ASK_MS``, ``CONFIRMED_END_MS``, ``TURN_CONFIRM_PROBABILITY``):
open conversation 420 ms, waiting for the wake word 700 ms, +780 ms when the text trails off, never above 1600 ms,
the score is asked at 240 ms, a score of 0.6 or more closes the turn at 280 ms, a score under 0.5 waits the long
pause. The word list adds aur, ki, toh, matlab, and, so, but (and the Devanagari forms) to those rules, and
digits and spelled-out letters are held longer so a number or a spelled name is not cut in half.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum


class EndpointEvent(StrEnum):
    START_OF_TURN = "StartOfTurn"
    EAGER_END_OF_TURN = "EagerEndOfTurn"
    TURN_RESUMED = "TurnResumed"
    END_OF_TURN = "EndOfTurn"


@dataclass(frozen=True)
class EndpointConfig:
    conversation_open: bool = True
    open_silence_ms: int = 420  # voice-session.ts endpointSilenceMs, conversation open
    closed_silence_ms: int = 700  # voice-session.ts endpointSilenceMs, waiting for the wake word
    trailing_off_extra_ms: int = 780  # voice-session.ts: base + 780 when the text looks mid-thought
    entity_extra_ms: int = 600  # digits or a spelled name still being said
    hard_cap_ms: int = 1600  # voice-session.ts: the longest any wait may be
    eager_ms: int = 240  # voice-session.ts TURN_SCORE_ASK_MS
    confirmed_end_ms: int = 280  # voice-session.ts CONFIRMED_END_MS
    confirm_probability: float = 0.6  # voice-session.ts TURN_CONFIRM_PROBABILITY
    low_probability: float = 0.5  # below this the score asks for the long pause
    start_probability: float = 0.5  # VAD probability that counts as speech
    token_settle_ms: int = 100  # a token younger than this means the recogniser is still moving

    def __post_init__(self) -> None:
        if self.hard_cap_ms <= 0 or self.eager_ms < 0 or self.confirmed_end_ms < 0:
            raise ValueError("times must be positive")
        if not 0.0 <= self.low_probability <= self.confirm_probability <= 1.0:
            raise ValueError("need 0 <= low_probability <= confirm_probability <= 1")

    @property
    def base_ms(self) -> int:
        return self.open_silence_ms if self.conversation_open else self.closed_silence_ms


@dataclass(frozen=True)
class Observation:
    vad_probability: float
    trailing_silence_ms: int  # quiet since the last speech, 0 while speaking
    token_age_ms: int = 1_000_000  # time since the recogniser last produced a new token
    turn_probability: float | None = None
    text: str = ""  # the current partial transcript


@dataclass(frozen=True)
class EndpointDecision:
    event: EndpointEvent | None
    required_wait_ms: int
    reason: str


_TRAILING_OFF = re.compile(
    r"(?:\b(?:and|or|but|so|because|if|when|with|the|a|an|uh|um|aur|lekin|kyunki|ki|ke|ya|matlab|toh|to|par|phir)\s*)$",
    re.IGNORECASE,
)
_TRAILING_OFF_DEVANAGARI = re.compile(r"(?:और|लेकिन|क्योंकि|कि|तो|फिर|या|मतलब|पर)\s*$")
_ENDS_WITH_DIGIT = re.compile(r"[0-9०-९]\s*$")
_DEVANAGARI_LETTER_NAMES = "ए|बी|सी|डी|ई|एफ|जी|एच|आई|जे|के|एल|एम|एन|ओ|पी|क्यू|आर|एस|टी|यू|वी|डब्ल्यू|एक्स|वाई|जेड|ज़ेड"
_LETTER = rf"(?:[A-Za-z]|{_DEVANAGARI_LETTER_NAMES})"
_SPELLED_RUN = re.compile(rf"(?:^|\s){_LETTER}(?:[\s.\-]+{_LETTER}){{2,}}[\s.\-]*$")
_SENTENCE_END = re.compile(r"[.!?।]\s*$")


def trails_off(text: str) -> bool:
    """True when the text still looks mid-thought (comma, dash, or a joining word at the end)."""
    trimmed = text.strip()
    if not trimmed or _SENTENCE_END.search(trimmed):
        return False
    if trimmed[-1] in ",:;-—":
        return True
    return bool(_TRAILING_OFF.search(trimmed) or _TRAILING_OFF_DEVANAGARI.search(trimmed))


def holds_entity(text: str) -> bool:
    """True when the text ends in digits or in spelled letters ("a b c", "ए बी सी"): more is probably coming."""
    trimmed = text.strip()
    if not trimmed or _SENTENCE_END.search(trimmed):
        return False
    return bool(_ENDS_WITH_DIGIT.search(trimmed) or _SPELLED_RUN.search(trimmed))


def end_wait_ms(
    config: EndpointConfig,
    text: str = "",
    turn_probability: float | None = None,
) -> int:
    """Trailing quiet needed before the turn may end. Always at most ``hard_cap_ms``."""
    base = config.base_ms
    long_wait = min(config.hard_cap_ms, base + config.trailing_off_extra_ms)
    wait = base
    if trails_off(text):
        wait = long_wait
    elif holds_entity(text):
        wait = min(config.hard_cap_ms, base + config.entity_extra_ms)
    if turn_probability is not None and 0.0 <= turn_probability <= 1.0:
        if turn_probability < config.low_probability:
            wait = max(wait, long_wait)
        elif turn_probability >= config.confirm_probability and wait == base:
            wait = min(base, config.confirmed_end_ms)
    return min(wait, config.hard_cap_ms)


class Endpointer:
    """Stateful wrapper: remembers whether a turn is open and whether an eager end was sent."""

    def __init__(self, config: EndpointConfig | None = None) -> None:
        self.config = config or EndpointConfig()
        self._in_turn = False
        self._eager = False

    @property
    def in_turn(self) -> bool:
        return self._in_turn

    def reset(self) -> None:
        self._in_turn = False
        self._eager = False

    def step(self, obs: Observation) -> EndpointDecision:
        cfg = self.config
        speaking = obs.vad_probability >= cfg.start_probability
        silence = 0 if speaking else max(0, obs.trailing_silence_ms)
        wait = end_wait_ms(cfg, obs.text, obs.turn_probability)

        if not self._in_turn:
            if speaking:
                self._in_turn = True
                return EndpointDecision(EndpointEvent.START_OF_TURN, wait, "speech-started")
            return EndpointDecision(None, wait, "idle")

        if speaking:
            if self._eager:
                self._eager = False
                return EndpointDecision(EndpointEvent.TURN_RESUMED, wait, "speech-resumed-after-eager")
            return EndpointDecision(None, wait, "speaking")

        if silence >= cfg.hard_cap_ms:
            return self._finish(wait, "hard-cap")
        settled = obs.token_age_ms >= cfg.token_settle_ms
        if silence >= wait and settled:
            return self._finish(wait, "silence-reached-wait")
        if not self._eager and settled and silence >= cfg.eager_ms and silence < wait and not self._holding(obs):
            self._eager = True
            return EndpointDecision(EndpointEvent.EAGER_END_OF_TURN, wait, "eager-quiet")
        return EndpointDecision(None, wait, "waiting")

    def _holding(self, obs: Observation) -> bool:
        """The text or the score says more is coming, so no speculative reply is started."""
        if trails_off(obs.text) or holds_entity(obs.text):
            return True
        score = obs.turn_probability
        return score is not None and 0.0 <= score < self.config.low_probability

    def _finish(self, wait: int, reason: str) -> EndpointDecision:
        self._in_turn = False
        self._eager = False
        return EndpointDecision(EndpointEvent.END_OF_TURN, wait, reason)
