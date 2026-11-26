"""How FRIDAY says a line: the small delivery tags a model may write, parsed before any sound is made.

A reply may carry ``[warm]``, ``[soft]``, ``[excited]``, ``[calm]``, ``[slow]``, ``[fast]``, ``[pause]``,
``[pause:400]``, ``[breath]``, ``[sigh]`` and ``[laugh-soft]`` (a tag may take a strength: ``[warm:0.5]``).
This file turns such text into ``Piece`` objects (clean words plus how to say them) and each piece into
``Controls`` (a speed, a gain, a filter nudge, pauses) with every number clamped. Nothing here makes sound,
opens a file or a socket, or needs a model; ``fallback_noise`` is the one function that returns samples.

Rules that do not bend:

* Only the names in ``TAGS`` do anything. Any other lowercase ``[word]`` is dropped, never spoken.
* A tag inside a code span, a code fence, a link address or a web address is plain text, and so is a bracket
  that touches a word or a number (``arr[warm]``, ``3[warm]``, ``[warm](page)``).
* Text from a tool, a page or a person is read with ``trusted=False``: its tags are removed and none applied.
* The engine's own expression tags (``<laugh>`` and the like) are reachable only through the allow-list: the
  words of a piece never hold an angle bracket, and ``Controls.text`` holds one only for an allowed tag whose
  measured status in ``ENGINE_TAG_STATUS`` is enabled.
* A mood tag lasts to the end of its sentence or the next mood tag; more than two tags in one sentence are
  ignored beyond the first two.

Every number in ``TAGS`` is a starting point written down before anyone listened (proposed 2026-11-26).
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

import numpy as np

# ---- limits ------------------------------------------------------------------------------------------------------

SPEED_LIMITS = (0.8, 1.2)  # the total multiplier a piece may ask for
ENGINE_SPEED_RANGE = (0.7, 2.0)  # what the speech graphs accept (friday_voice.SPEED_RANGE)
GAIN_LIMITS_DB = (-9.0, 3.0)
FX_LIMIT_DB = 4.0
PAUSE_LIMITS_MS = (80, 1200)
PAUSE_DEFAULT_MS = 250
PAUSE_TOTAL_MS = 2400  # one gap, however many pause tags pile up
PAUSE_SCALE_LIMITS = (0.5, 1.6)
STRENGTH_LIMITS = (0.0, 1.5)
MAX_TAGS_PER_SENTENCE = 2
STEPS_LIMITS = (1, 16)
NOISE_LIMITS_MS = (20, 2000)
NOISE_LIMITS_DB = (-60.0, -6.0)

# ---- the allow-list ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TagSpec:
    """One tag the model may write. ``kind`` is mood, pace, pause or engine; mood and pace tags replace their kind."""

    name: str
    kind: str
    speed: float = 1.0
    gain_db: float = 0.0
    fx: tuple[tuple[str, float], ...] = ()  # (band key, dB); a key is "<voice_fx band type>:<Hz>"
    pause_mul: float = 1.0
    min_steps: int | None = None
    engine: str = ""  # the engine's own expression tag, reached only through this entry


_LOW = "lowshelf:200"
_PRESENCE = "peak:3500"
_AIR = "highshelf:6000"

TAGS: dict[str, TagSpec] = {
    spec.name: spec
    for spec in (
        TagSpec("warm", "mood", speed=0.97, fx=((_LOW, 1.5), (_PRESENCE, 1.0)), min_steps=5),
        TagSpec("soft", "mood", speed=0.92, gain_db=-3.0, fx=((_AIR, -2.0),)),
        TagSpec("excited", "mood", speed=1.08, gain_db=1.0, pause_mul=0.8),
        TagSpec("calm", "mood", speed=0.93, pause_mul=1.2),
        TagSpec("slow", "pace", speed=0.88),
        TagSpec("fast", "pace", speed=1.12),
        TagSpec("pause", "pause"),
        TagSpec("breath", "engine", engine="breath"),
        TagSpec("sigh", "engine", engine="sigh"),
        TagSpec("laugh-soft", "engine", gain_db=-4.0, engine="laugh"),
    )
}
KINDS = ("mood", "pace", "pause", "engine")
ENGINE_TAG_NAMES = tuple(sorted({spec.engine for spec in TAGS.values() if spec.engine}))
_FX_KEY = re.compile(r"^(?:lowshelf|peak|highshelf|highpass|lowpass):\d{2,5}$")

# What the screen drops from an angle tag too. The speech path drops every angle tag.
ANGLE_EXPRESSION_NAMES = frozenset(
    {"breath", "sigh", "laugh", "cough", "inhale", "exhale", "sniff", "gasp", "yawn", "hum", "giggle", "cry", "sob"}
    | {"hi", "en", "na"}
)

# Measured 2026-11-26 on the pinned speech graphs: voice F2, 5 steps, seeds 1-4, English, Hindi and unknown-language
# clauses, read back by a small recogniser. "alone" is the tag as its own clause (how ``controls_for`` sends it); the
# inline read put the tag inside a sentence at its start, middle and end. "spoken" is True when the tag's own word was
# heard in either read (English "<breath>" inline came back as the word "breath" in 3 of 3 places; Hindi "<sigh>"
# alone came back as "sai" in 1 of 4). "active_s" and "rms_db" are the (low, high) of the sound the tag added alone:
# short, and 10 to 25 dB apart from seed to seed, so the level cannot be promised. Nothing is enabled until the
# owner has listened on the real speaker; the default is off and the fallbacks below take over.
ENGINE_TAG_MEASURED_ON = "2026-11-26"
ENGINE_TAG_STATUS: dict[str, dict[str, Any]] = {
    "breath": {
        "enabled": False,
        "spoken": {"en": True, "hi": False, "na": False},
        "alone_active_s": {"en": (0.40, 0.71), "hi": (0.44, 0.65), "na": (0.45, 0.71)},
        "alone_rms_db": {"en": (-41.0, -22.9), "hi": (-38.3, -32.0), "na": (-46.0, -25.2)},
        "note": "read as the word inside an English sentence; alone it is a quiet airy sound of uneven level",
    },
    "sigh": {
        "enabled": False,
        "spoken": {"en": False, "hi": True, "na": False},
        "alone_active_s": {"en": (0.39, 0.50), "hi": (0.25, 0.48), "na": (0.20, 0.51)},
        "alone_rms_db": {"en": (-48.8, -36.0), "hi": (-47.8, -20.5), "na": (-48.9, -18.7)},
        "note": "almost silent in 6 of 8 English and unknown-language reads; the Hindi read can say 'sai'",
    },
    "laugh": {
        "enabled": False,
        "spoken": {"en": False, "hi": False, "na": False},
        "alone_active_s": {"en": (0.14, 0.41), "hi": (0.31, 0.48), "na": (0.21, 0.41)},
        "alone_rms_db": {"en": (-29.1, -18.3), "hi": (-32.9, -21.0), "na": (-30.1, -22.6)},
        "note": "a short 'ha' sound, sometimes a stray word; FRIDAY never laughs on its own, so it stays off",
    },
}

# What a disabled engine tag becomes instead (data, so the caller makes the sound).
ENGINE_FALLBACK: dict[str, dict[str, float]] = {
    "breath": {"noise_ms": 180.0, "noise_db": -26.0, "pause_ms": 0.0},
    "sigh": {"noise_ms": 0.0, "noise_db": -30.0, "pause_ms": 300.0},
    "laugh": {"noise_ms": 0.0, "noise_db": -30.0, "pause_ms": 0.0},
}

# ---- text scanning -----------------------------------------------------------------------------------------------

_FENCE = r"```.*?(?:```|\Z)"
_INLINE_CODE = r"`[^`\n]+`"
_URL = r"(?:https?://|www\.)[^\s<>\"']+"
_LINK_TARGET = r"\]\([^)\s]*\)"
_PROTECTED = re.compile(f"{_FENCE}|{_INLINE_CODE}|{_URL}|{_LINK_TARGET}", re.DOTALL | re.IGNORECASE)
# a square-bracket tag: letters and hyphens, an optional value; never glued to a word before it or a digit or "(" after
_BRACKET = re.compile(r"(?<![\w/\\])\[([A-Za-z][A-Za-z-]{1,19})(?::([^\]\s]{0,12}))?\](?![\d(])")
_ANGLE_MARKS = "<>＜＞﹤﹥"  # every character the speech graphs' own text clean-up folds into < or >
_ANGLE = re.compile(r"[<＜﹤]\s*/?\s*([A-Za-z][A-Za-z0-9_-]{0,23})\s*/?\s*[>＞﹥]")
_SENTENCE_END = re.compile(r"(?:[.!?।॥…]+[\"')\]”’]*(?=\s|\Z))|\n+")
_STRENGTH = re.compile(r"^\d{1,2}(?:\.\d{1,3})?$")
_PAUSE_VALUE = re.compile(r"^(\d{1,5}(?:\.\d{1,3})?)(ms|s)?$", re.IGNORECASE)
_SPACES = re.compile(r"[ \t]+")


@dataclass(frozen=True)
class _Token:
    kind: str  # "text", "tag" (a bracket tag), "angle" (an angle tag)
    text: str  # the source text of the token
    name: str = ""
    value: str | None = None


def _clean_controls(text: str) -> str:
    """No control or format characters (zero-width joiners and the like): they can hide a tag from a scanner."""
    return "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch) not in ("Cc", "Cf"))


def _scan(text: str) -> list[_Token]:
    """Split text into plain runs and tags. A protected span stays inside a plain run, untouched."""
    tokens: list[_Token] = []
    position = 0
    for found in _PROTECTED.finditer(text):
        _scan_open(text[position : found.start()], tokens)
        _push_text(tokens, found.group(0))
        position = found.end()
    _scan_open(text[position:], tokens)
    return tokens


def _push_text(tokens: list[_Token], text: str) -> None:
    if not text:
        return
    if tokens and tokens[-1].kind == "text":
        tokens[-1] = _Token("text", tokens[-1].text + text)
    else:
        tokens.append(_Token("text", text))


def _scan_open(text: str, tokens: list[_Token]) -> None:
    hits: list[tuple[int, int, _Token]] = []
    for found in _BRACKET.finditer(text):
        name, value = found.group(1), found.group(2)
        if name.lower() in TAGS or name.islower():
            hits.append((found.start(), found.end(), _Token("tag", found.group(0), name.lower(), value)))
    for found in _ANGLE.finditer(text):
        hits.append((found.start(), found.end(), _Token("angle", found.group(0), found.group(1).lower())))
    hits.sort(key=lambda hit: hit[0])
    position = 0
    for start, end, token in hits:
        if start < position:
            continue
        _push_text(tokens, text[position:start])
        tokens.append(token)
        position = end
    _push_text(tokens, text[position:])


# ---- screen text -------------------------------------------------------------------------------------------------


def strip(text: str) -> str:
    """What a screen shows: the text without delivery tags, unknown bracket tags and angle expression tags.

    Code spans, code fences and addresses are left exactly as they are. A text with nothing to remove comes back
    unchanged.
    """
    value = str(text or "")
    tokens = _scan(value)
    out: list[str] = []
    removed = False
    for index, token in enumerate(tokens):
        drop = token.kind == "tag" or (token.kind == "angle" and token.name in ANGLE_EXPRESSION_NAMES)
        if not drop:
            out.append(token.text)
            continue
        removed = True
        before = out[-1] if out else ""
        after = tokens[index + 1].text if index + 1 < len(tokens) else ""
        if (not before or before[-1:].isspace()) and after[:1].isspace():
            tokens[index + 1] = _Token(tokens[index + 1].kind, after.lstrip(" \t"), tokens[index + 1].name)
        elif before[-1:] == " " and after[:1] in (".", ",", ";", ":", "!", "?", "।", "॥"):
            out[-1] = before.rstrip(" ")
    result = "".join(out)
    return result.strip() if removed else value


# ---- the parser --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Piece:
    """A run of words and how to say it, or (empty text) a lone engine tag or pause."""

    text: str
    speed_mul: float = 1.0
    gain_db: float = 0.0
    fx_delta: dict[str, float] = field(default_factory=dict)
    pause_ms_before: int = 0
    pause_ms_after: int = 0
    engine_tags: tuple[str, ...] = ()
    tags_applied: tuple[str, ...] = ()
    pause_mul: float = 1.0
    min_steps: int | None = None


def _clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


def _finite(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _strength(value: str | None) -> float | None:
    """The strength a tag asked for: 1.0 when none, None when the value is not a plain number."""
    if value is None:
        return 1.0
    if not _STRENGTH.match(value):
        return None
    return _clamp(float(value), *STRENGTH_LIMITS)


def _pause_ms(value: str | None) -> int | None:
    if value is None:
        return PAUSE_DEFAULT_MS
    found = _PAUSE_VALUE.match(value)
    if not found:
        return None
    ms = float(found.group(1)) * (1000.0 if (found.group(2) or "").lower() == "s" else 1.0)
    return int(round(_clamp(ms, *PAUSE_LIMITS_MS)))


class _State:
    """The mood and pace that are open now, with the strength each came with."""

    def __init__(self) -> None:
        self.mood: tuple[TagSpec, float] | None = None
        self.pace: tuple[TagSpec, float] | None = None
        self.count = 0

    @property
    def neutral(self) -> bool:
        return self.mood is None and self.pace is None

    def reset(self) -> None:
        self.mood = None
        self.pace = None
        self.count = 0

    def numbers(self) -> tuple[float, float, dict[str, float], float, int | None, tuple[str, ...]]:
        speed, gain, pause_mul = 1.0, 0.0, 1.0
        fx: dict[str, float] = {}
        steps: int | None = None
        names: list[str] = []
        for slot in (self.mood, self.pace):
            if slot is None:
                continue
            spec, strength = slot
            names.append(spec.name)
            speed *= 1.0 + (spec.speed - 1.0) * strength
            gain += spec.gain_db * strength
            pause_mul *= 1.0 + (spec.pause_mul - 1.0) * strength
            for key, db in spec.fx:
                fx[key] = fx.get(key, 0.0) + db * strength
            if spec.min_steps is not None and strength > 0:
                steps = max(steps or 0, spec.min_steps)
        return speed, gain, fx, pause_mul, steps, tuple(names)


def _piece(
    text: str, state: _State, *, engine: tuple[str, ...] = (), extra_gain: float = 0.0, extra: tuple[str, ...] = ()
) -> Piece:
    speed, gain, fx, pause_mul, steps, names = state.numbers()
    return Piece(
        text=text,
        speed_mul=_clamp(speed, *SPEED_LIMITS),
        gain_db=_clamp(gain + extra_gain, *GAIN_LIMITS_DB),
        fx_delta={key: _clamp(db, -FX_LIMIT_DB, FX_LIMIT_DB) for key, db in fx.items()},
        engine_tags=engine,
        tags_applied=names + extra,
        pause_mul=_clamp(pause_mul, *PAUSE_SCALE_LIMITS),
        min_steps=steps,
    )


def _words(text: str) -> str:
    """Words for the speech graphs: no angle bracket of any kind, one space between words."""
    for mark in _ANGLE_MARKS:
        text = text.replace(mark, " ")
    return _SPACES.sub(" ", text)


def _merge(piece: Piece, **changes: Any) -> Piece:
    data = {name: getattr(piece, name) for name in piece.__dataclass_fields__}
    data.update(changes)
    return Piece(**data)


def parse(text: str, *, trusted: bool = True) -> list[Piece]:
    """Delivery tags and words in, ordered pieces out. Text not written by the model is read with ``trusted=False``."""
    value = _clean_controls(str(text or ""))
    pieces: list[Piece] = []
    state = _State()
    buffer: list[str] = []
    pending_before = 0

    def flush() -> None:
        nonlocal pending_before
        words = _words("".join(buffer)).strip(" \t")
        buffer.clear()
        if not words.strip():
            return
        made = _piece(words, state)
        if pending_before:
            made = _merge(made, pause_ms_before=pending_before, tags_applied=("pause",) + made.tags_applied)
            pending_before = 0
        pieces.append(made)

    def add_pause(ms: int) -> None:
        nonlocal pending_before
        if pieces:
            last = pieces[-1]
            applied = last.tags_applied if "pause" in last.tags_applied else last.tags_applied + ("pause",)
            pieces[-1] = _merge(
                last, pause_ms_after=min(last.pause_ms_after + ms, PAUSE_TOTAL_MS), tags_applied=applied
            )
        else:
            pending_before = min(pending_before + ms, PAUSE_TOTAL_MS)

    for token in _scan(value):
        if token.kind == "text":
            _feed(token.text, state, buffer, flush)
            continue
        if token.kind == "angle" or not trusted:
            continue  # never reaches the engine, never spoken
        spec = TAGS.get(token.name)
        if spec is None:
            continue  # an unknown tag is dropped, never spoken
        flush()
        state.count += 1
        if state.count > MAX_TAGS_PER_SENTENCE:
            continue
        if spec.kind == "pause":
            ms = _pause_ms(token.value)
            if ms is not None:
                add_pause(ms)
            continue
        strength = _strength(token.value)
        if strength is None:
            continue
        if spec.kind == "mood":
            state.mood = (spec, strength)
        elif spec.kind == "pace":
            state.pace = (spec, strength)
        elif spec.kind == "engine":
            made = _piece("", state, engine=(spec.engine,), extra_gain=spec.gain_db * strength, extra=(spec.name,))
            if pending_before:
                made = _merge(made, pause_ms_before=pending_before, tags_applied=("pause",) + made.tags_applied)
                pending_before = 0
            pieces.append(made)
    flush()
    if pending_before and not pieces:
        pieces.append(Piece(text="", pause_ms_before=pending_before, tags_applied=("pause",)))
    elif pending_before:
        pieces[-1] = _merge(pieces[-1], pause_ms_after=pieces[-1].pause_ms_after + pending_before)
    return pieces


def _feed(text: str, state: _State, buffer: list[str], flush: Any) -> None:
    """Add words to the open piece; a sentence end closes a styled piece and clears the mood."""
    position = 0
    for found in _SENTENCE_END.finditer(text):
        end = found.end()
        buffer.append(text[position:end])
        position = end
        if not state.neutral:
            flush()
        state.reset()
    buffer.append(text[position:])


# ---- controls ----------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Controls:
    """What the voice does with one piece. ``text`` is what the speech graphs read ("" when only a pause or noise)."""

    text: str
    speed: float
    steps: int | None
    gain_db: float
    fx_delta: dict[str, float]
    pause_before_ms: int
    pause_after_ms: int
    pause_mul: float
    noise_ms: int
    noise_db: float
    engine_tag: str


def engine_enabled(name: str, status: Mapping[str, Mapping[str, Any]] | None = None) -> bool:
    """True when the measured status of an engine tag says it is safe to send."""
    table = ENGINE_TAG_STATUS if status is None else status
    entry = table.get(str(name))
    return bool(entry and entry.get("enabled") is True) and str(name) in ENGINE_TAG_NAMES


def _int_ms(value: Any, low: int, high: int) -> int:
    return int(round(_clamp(_finite(value, 0.0), low, high)))


def controls_for(
    piece: Piece,
    base_speed: float = 1.0,
    *,
    engine_status: Mapping[str, Mapping[str, Any]] | None = None,
) -> Controls:
    """The clamped numbers for one piece. A disabled engine tag turns into its fallback (noise or a pause)."""
    base = _clamp(_finite(base_speed, 1.0), *ENGINE_SPEED_RANGE)
    mul = _clamp(_finite(piece.speed_mul, 1.0), *SPEED_LIMITS)
    speed = round(_clamp(base * mul, *ENGINE_SPEED_RANGE), 4)
    fx = {
        str(key): round(_clamp(_finite(db, 0.0), -FX_LIMIT_DB, FX_LIMIT_DB), 3)
        for key, db in dict(piece.fx_delta or {}).items()
        if _FX_KEY.match(str(key))
    }
    steps = (
        piece.min_steps
        if piece.min_steps is not None and STEPS_LIMITS[0] <= piece.min_steps <= STEPS_LIMITS[1]
        else None
    )
    before = _int_ms(piece.pause_ms_before, 0, PAUSE_TOTAL_MS)
    after = _int_ms(piece.pause_ms_after, 0, PAUSE_TOTAL_MS)
    text = _words(str(piece.text or "")).strip()
    noise_ms, noise_db, engine_tag = 0, NOISE_LIMITS_DB[0], ""
    for name in piece.engine_tags:
        if name not in ENGINE_TAG_NAMES:
            continue  # nothing outside the allow-list reaches the engine
        if engine_enabled(name, engine_status):
            engine_tag = name
            text = f"<{name}>"
            break
        fallback = ENGINE_FALLBACK.get(name, {})
        noise_ms = _int_ms(fallback.get("noise_ms", 0.0), 0, NOISE_LIMITS_MS[1])
        noise_db = _clamp(_finite(fallback.get("noise_db", -30.0), -30.0), *NOISE_LIMITS_DB)
        after = min(PAUSE_TOTAL_MS, after + _int_ms(fallback.get("pause_ms", 0.0), 0, PAUSE_LIMITS_MS[1]))
    return Controls(
        text=text,
        speed=speed,
        steps=steps,
        gain_db=round(_clamp(_finite(piece.gain_db, 0.0), *GAIN_LIMITS_DB), 3),
        fx_delta=fx,
        pause_before_ms=before,
        pause_after_ms=after,
        pause_mul=_clamp(_finite(piece.pause_mul, 1.0), *PAUSE_SCALE_LIMITS),
        noise_ms=noise_ms,
        noise_db=noise_db,
        engine_tag=engine_tag,
    )


def merge_fx(deltas: Iterable[Mapping[str, float]]) -> dict[str, float]:
    """Add several band nudges into one, each band kept inside the limit."""
    total: dict[str, float] = {}
    for delta in deltas:
        for key, db in delta.items():
            if _FX_KEY.match(str(key)):
                total[key] = total.get(key, 0.0) + _finite(db, 0.0)
    return {key: round(_clamp(db, -FX_LIMIT_DB, FX_LIMIT_DB), 3) for key, db in total.items()}


# ---- the sound a disabled breath becomes -------------------------------------------------------------------------


def fallback_noise(sample_rate: int = 44100, ms: float = 180.0, level_dbfs: float = -26.0, seed: int = 0) -> np.ndarray:
    """Soft airy noise (about 250 Hz to 5 kHz) with a swell and a fade, at a given RMS level. Float32, deterministic."""
    rate = int(sample_rate) if isinstance(sample_rate, int | float) and 8000 <= int(sample_rate) <= 192000 else 44100
    count = int(rate * _clamp(_finite(ms, 180.0), *NOISE_LIMITS_MS) / 1000.0)
    if count < 8:
        return np.zeros(0, dtype=np.float32)
    level = _clamp(_finite(level_dbfs, -26.0), *NOISE_LIMITS_DB)
    white = np.random.RandomState(int(seed) & 0x7FFFFFFF).randn(count)
    spectrum = np.fft.rfft(white)
    freq = np.fft.rfftfreq(count, 1.0 / rate)
    shape = (freq / (freq + 250.0)) / np.sqrt(1.0 + (freq / 5000.0) ** 4)
    noise = np.fft.irfft(spectrum * shape, count)
    rise = max(1, int(count * 0.35))
    envelope = np.concatenate(
        [np.sin(np.linspace(0.0, np.pi / 2, rise)) ** 2, np.cos(np.linspace(0.0, np.pi / 2, count - rise)) ** 2]
    )
    noise = noise * envelope
    rms = float(np.sqrt(np.mean(noise * noise)))
    if rms < 1e-12:
        return np.zeros(count, dtype=np.float32)
    return np.asarray(noise * (10.0 ** (level / 20.0) / rms), dtype=np.float32)
