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

Turn protocol (``TurnTracker``)
-------------------------------
The same observations also drive the five-event turn protocol the stream-feed reply carries: ``start``, ``partial``,
``eager``, ``resumed``, ``end`` and ``revised``. ``eager`` needs ``EndpointConfig.eager_turn`` (off by default), a
VAD stop of ``vad_stop_ms`` and an end-of-turn score of ``eager_probability`` or more; it is always answered by
``resumed`` (the owner went on) or ``end``. ``revised`` is a changed text after ``end``. ``config_for_ears`` maps the
``ears.eagerness`` preset (eager 300/1600, normal 500/3000, patient 800/6000 ms, base/max) and ``ears.eagerTurn``
to a config; without ``ears`` the defaults above stay.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


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
    vad_stop_ms: int = 200  # quiet after which the end-of-turn model is asked and an eager end may be sent
    incomplete_wait_ms: int | None = None  # wait after the model says "not finished"; None = the long pause
    eager_turn: bool = False  # ears.eagerTurn: send the speculative ``eager`` turn event at all
    eager_probability: float = 0.5  # the model score an eager turn event needs

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


# Fillers and joining words that mean the owner is still thinking: English, Hindi in Latin letters, and Devanagari.
_FILLER = r"(?:woh|wo|um+|uh+|er+|hmm+|aa+h*|ah+|yaani|yani|jaise|mtlb|matlab|haan toh)"
_TRAILING_OFF = re.compile(
    rf"(?:\b(?:and|or|but|so|because|if|when|with|the|a|an|{_FILLER}|aur|lekin|kyunki|ki|ke|ya|toh|to|par|phir)\s*)$",
    re.IGNORECASE,
)
_FILLER_ELLIPSIS = re.compile(rf"\b{_FILLER}\s*(?:\.{{2,}}|…)\s*$", re.IGNORECASE)
_TRAILING_OFF_DEVANAGARI = re.compile(r"(?:और|लेकिन|क्योंकि|कि|तो|फिर|या|मतलब|पर)\s*$")
_FILLER_DEVANAGARI = re.compile(r"(?:^|[\s,])(?:वो|वह|उम+|उम्म|अं|ऊं|आ|अ|यानी|जैसे|हाँ तो|हां तो)\s*(?:\.{2,}|…)?\s*$")
_ENDS_WITH_DIGIT = re.compile(r"[0-9०-९]\s*$")
_DEVANAGARI_LETTER_NAMES = "ए|बी|सी|डी|ई|एफ|जी|एच|आई|जे|के|एल|एम|एन|ओ|पी|क्यू|आर|एस|टी|यू|वी|डब्ल्यू|एक्स|वाई|जेड|ज़ेड"
_LETTER = rf"(?:[A-Za-z]|{_DEVANAGARI_LETTER_NAMES})"
_SPELLED_RUN = re.compile(rf"(?:^|\s){_LETTER}(?:[\s.\-]+{_LETTER}){{2,}}[\s.\-]*$")
_SENTENCE_END = re.compile(r"[.!?।]\s*$")


def trails_off(text: str) -> bool:
    """True when the text still looks mid-thought (comma, dash, or a joining word at the end)."""
    trimmed = text.strip()
    if not trimmed:
        return False
    if _FILLER_ELLIPSIS.search(trimmed) or _FILLER_DEVANAGARI.search(trimmed):
        return True
    if _SENTENCE_END.search(trimmed):
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
            if config.incomplete_wait_ms is not None:
                wait = max(wait, min(config.hard_cap_ms, config.incomplete_wait_ms))
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


# ---- eagerness presets ----------------------------------------------------------------------------------------------

# ears.eagerness -> (base silence ms, longest wait ms). The base is the pause that closes a plainly finished
# sentence; the longest is what a turn the model calls unfinished may wait before the fallback ends it.
EAGERNESS_PRESETS: dict[str, tuple[int, int]] = {
    "eager": (300, 1600),
    "normal": (500, 3000),
    "patient": (800, 6000),
}
_CLOSED_EXTRA_MS = 280  # the wake-word-waiting pause is the open one plus this (700 against 420 today)


def config_for_ears(ears: Any) -> dict[str, Any] | None:
    """``EndpointConfig`` fields for the ``ears`` object of the stream-open payload, or None when ``ears`` is absent
    or names no known ``eagerness`` (the defaults stay). ``eagerTurn`` is on only for a real ``True``."""
    if not isinstance(ears, Mapping):
        return None
    name = str(ears.get("eagerness") or "").strip().lower()
    preset = EAGERNESS_PRESETS.get(name)
    if preset is None:
        return None
    base, longest = preset
    if name == "normal":
        # "normal" keeps today's pauses (420 open, 700 closed) so the renderer's default changes nothing the
        # owner hears; only a turn the model calls unfinished may now wait up to the preset's longest (3.0 s).
        return {
            "open_silence_ms": 420,
            "closed_silence_ms": 700,
            "hard_cap_ms": longest,
            "incomplete_wait_ms": longest,
            "eager_turn": ears.get("eagerTurn") is True,
        }
    return {
        "open_silence_ms": base,
        "closed_silence_ms": min(longest, base + _CLOSED_EXTRA_MS),
        "hard_cap_ms": longest,
        "incomplete_wait_ms": longest,
        "eager_turn": ears.get("eagerTurn") is True,
    }


# ---- the turn protocol ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TurnNote:
    """One event of the turn protocol. ``event`` is start, partial, eager, resumed, end or revised."""

    turn_id: int
    event: str
    text: str


class TurnTracker:
    """Turns ``Endpointer`` decisions and the changing text into the turn protocol. Pure: no clock, no audio."""

    def __init__(self, config: EndpointConfig | None = None) -> None:
        self.config = config or EndpointConfig()
        self.reset()

    def reset(self) -> None:
        self.turn_id = 0
        self._open = False
        self._eager = False
        self._ended = False
        self._text = ""

    def step(self, obs: Observation, decision: EndpointDecision) -> list[TurnNote]:
        cfg = self.config
        text = obs.text.strip()
        speaking = obs.vad_probability >= cfg.start_probability
        notes: list[TurnNote] = []
        if decision.event is EndpointEvent.START_OF_TURN:
            self.turn_id += 1
            self._open, self._eager, self._ended = True, False, False
            self._text = text
            return [TurnNote(self.turn_id, "start", text)]
        if not self._open:
            if self._ended and text and text != self._text:
                self._text = text
                notes.append(TurnNote(self.turn_id, "revised", text))
            return notes
        if speaking and self._eager:
            self._eager = False
            notes.append(TurnNote(self.turn_id, "resumed", text))
        if text and text != self._text:
            self._text = text
            notes.append(TurnNote(self.turn_id, "partial", text))
        if decision.event is EndpointEvent.END_OF_TURN:
            self._open, self._eager, self._ended = False, False, True
            notes.append(TurnNote(self.turn_id, "end", self._text))
        elif self._eager_ready(obs, speaking, text):
            self._eager = True
            notes.append(TurnNote(self.turn_id, "eager", text))
        return notes

    def _eager_ready(self, obs: Observation, speaking: bool, text: str) -> bool:
        cfg = self.config
        score = obs.turn_probability
        if not cfg.eager_turn or self._eager or speaking or not text or score is None:
            return False
        if obs.trailing_silence_ms < cfg.vad_stop_ms or obs.token_age_ms < cfg.token_settle_ms:
            return False
        return score >= cfg.eager_probability and not (trails_off(text) or holds_entity(text))
